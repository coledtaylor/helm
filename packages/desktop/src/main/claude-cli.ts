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

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * PATH resolution, done here rather than left to the spawn.
 *
 * ConPTY spawns through `CreateProcess`, which searches PATH but reports a
 * failure as a generic error with no indication that the *executable* was the
 * problem. Resolving first means a missing CLI is a sentence in the UI instead
 * of a pty that opens and immediately closes.
 */
function searchPath(): string | null {
  const path = process.env['PATH'] ?? process.env['Path']
  if (!path) return null

  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `claude${ext}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** The `claude` entry point on this machine, or null if there is not one. */
export function findClaudeExecutable(): string | null {
  for (const candidate of INSTALL_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate
  }
  return searchPath()
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
export function resolveClaudeCommand(): ClaudeCommand | null {
  const resolved = findClaudeExecutable()
  if (!resolved) return null

  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', resolved], resolved }
  }
  return { file: resolved, prefixArgs: [], resolved }
}

export async function readClaudeVersion(): Promise<string | null> {
  const command = resolveClaudeCommand()
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
