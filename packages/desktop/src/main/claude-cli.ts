import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Locates the `claude` CLI and reads its version.
 *
 * SPEC 8 pins the response to flag drift: assert on the version at startup,
 * warn, do not block. A missing CLI is not fatal - the config console and the
 * content viewer work without it, and telling the user what is wrong beats a
 * failed launch later with no explanation.
 */

const INSTALL_CANDIDATES = [
  join(homedir(), '.local', 'bin', 'claude.exe'),
  join(homedir(), '.local', 'bin', 'claude.cmd'),
  join(homedir(), '.local', 'bin', 'claude')
]

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A path the user picked by hand, which wins over discovery.
 *
 * Module state, set once at startup from settings and again when the picker
 * writes a new one, rather than a parameter threaded through every caller.
 * Every one of them - the session host, the MCP runner, the check drivers -
 * wants the same answer, and an override that some code paths honoured and
 * others did not would be a machine where sessions launch and `claude mcp add`
 * does not.
 */
let overridePath: string | null = null

export function setClaudeOverride(path: string | null): void {
  overridePath = path !== null && path.trim() !== '' && isExecutableFile(path) ? path : null
}

export function claudeOverride(): string | null {
  return overridePath
}

/**
 * PATH resolution, done here rather than left to the spawn.
 *
 * ConPTY spawns through `CreateProcess`, which searches PATH but reports a
 * failure as a generic error with no indication that the *executable* was the
 * problem. Resolving first means a missing CLI is a sentence in the UI instead
 * of a pty that opens and immediately closes.
 *
 * Takes the program name because `gh-cli.ts` needs exactly this walk for
 * exactly this reason, and two copies of a PATHEXT loop would be two places for
 * a machine's `.cmd` shim to stop being found.
 */
export function searchPath(name: string): string | null {
  const path = process.env['PATH'] ?? process.env['Path']
  if (!path) return null

  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** The `claude` entry point on this machine, or null if there is not one. */
export function findClaudeExecutable(): string | null {
  if (overridePath !== null) return overridePath
  for (const candidate of INSTALL_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate
  }
  return searchPath('claude')
}

export interface ClaudeCommand {
  /** What to hand node-pty. */
  file: string
  /** Args that must come before the caller's own. */
  prefixArgs: string[]
  /** The CLI entry point itself, for diagnostics and the status bar. */
  resolved: string
}

/**
 * How to spawn `claude` in a pty.
 *
 * Usually the executable directly. When the installation is a `.cmd` or `.bat`
 * shim - which is what an npm-installed CLI leaves on Windows - it goes through
 * `cmd.exe /c`, because `CreateProcess` cannot execute a batch file and ConPTY
 * has no shell of its own to do it. The wrapper becomes the pty's process and
 * `claude` its child, which is one more reason session teardown kills the tree
 * rather than the pid (see `treeKill`).
 */
export function resolveClaudeCommand(at?: string): ClaudeCommand | null {
  const resolved = at !== undefined ? (isExecutableFile(at) ? at : null) : findClaudeExecutable()
  if (!resolved) return null

  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', resolved], resolved }
  }
  return { file: resolved, prefixArgs: [], resolved }
}

export async function readClaudeVersion(at?: string): Promise<string | null> {
  const command = resolveClaudeCommand(at)
  if (!command) return null
  try {
    const { stdout } = await run(command.file, [...command.prefixArgs, '--version'], {
      timeout: 15_000,
      windowsHide: true
    })
    return stdout.trim() || null
  } catch {
    return null
  }
}
