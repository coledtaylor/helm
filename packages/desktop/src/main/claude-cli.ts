import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Locates the `claude` CLI and reads its version.
 *
 * SPEC 7 pins the response to flag drift: assert on the version at startup,
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

/** Cached answer to `readClaudeSupportsSessionId`. Declared beside the override
 * it is invalidated by, so `setClaudeOverride` never reaches it before it
 * exists - the temporal-dead-zone failure PACKAGING.md records. */
let sessionIdSupport: boolean | null = null

export function setClaudeOverride(path: string | null): void {
  overridePath = path !== null && path.trim() !== '' && isExecutableFile(path) ? path : null
  // A different binary may answer differently about its own flags, and the
  // cached answer below is about whichever one was asked.
  forgetClaudeCapabilities()
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
  /**
   * Whether this goes through `cmd.exe /c` rather than being the program.
   *
   * Two things downstream turn on it and neither is cosmetic: what node-pty is
   * handed (`claudePtyArgs`), and the fact that the pty's pid is then the
   * wrapper's rather than `claude`'s - which is why the session registry is
   * joined on the conversation id and not on that pid.
   */
  shim: boolean
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
    return {
      file: process.env['COMSPEC'] ?? 'cmd.exe',
      prefixArgs: ['/c', resolved],
      resolved,
      shim: true
    }
  }
  return { file: resolved, prefixArgs: [], resolved, shim: false }
}

/** Anything cmd.exe would read as structure rather than as text. */
const CMD_SPECIAL = /[\s"&<>()@^|]/

/**
 * One argument, quoted so `cmd.exe` hands it to the program intact.
 *
 * Quoted whenever it holds whitespace or a cmd metacharacter, because cmd does
 * no special-character processing inside quotes - so a review prompt carrying
 * an `&` reaches `claude` as an ampersand instead of ending the command.
 *
 * The known limit: an argument containing a literal `"` cannot be expressed
 * here. cmd counts quotes before the program's own parser ever sees them, so
 * the two escapings disagree by construction. That is unchanged from before
 * this - the whole shim path was in that position - and it is why the quote is
 * dropped rather than escaped: a mangled argument is better than one that ends
 * the command line early.
 */
function quoteForCmd(arg: string): string {
  const clean = arg.replace(/"/g, '')
  return CMD_SPECIAL.test(clean) || clean === '' ? `"${clean}"` : clean
}

/**
 * What node-pty is handed for a launch: an argv array, or a command line.
 *
 * A direct spawn is an array, which is the honest shape and what every launch
 * has always been.
 *
 * A `.cmd` shim is a string, and it has to be. `cmd.exe /c` re-parses the
 * command line under a rule of its own (`cmd /?`, "how quote characters are
 * processed"): unless there are *exactly two* quotes on the line it strips the
 * first quote and the last one, whatever they were quoting. node-pty quotes
 * every argument that needs it, so a shim under a path with a space plus a
 * session name with a space is four quotes, and the strip cuts the shim's path
 * in half. Measured against a shim in a directory named `cmd shim` and a
 * session named `shim join`: cmd reported the path truncated at that space as
 * "not recognized as an internal or external command", and the session never
 * started.
 *
 * The documented answer is the `/s` form: `/s` forces the strip-first-and-last
 * branch, and an **extra pair of quotes around the whole command** is what that
 * branch then removes - leaving the inner line, quoting intact, for cmd to
 * parse normally. Nothing about the direct path changes, and `SESS-20` is what
 * says this still holds.
 *
 * This is not hypothetical for a Windows user: an npm-installed CLI leaves a
 * `.cmd`, and a global prefix under `C:\Program Files` or a user folder with a
 * space in it is ordinary. It is also why the repository's rule is to test
 * paths with spaces.
 */
export function claudePtyArgs(command: ClaudeCommand, argv: readonly string[]): string[] | string {
  if (!command.shim) return [...command.prefixArgs, ...argv]
  const inner = [command.resolved, ...argv].map(quoteForCmd).join(' ')
  return `/s /c "${inner}"`
}

/**
 * Whether the `claude` on this machine takes `--session-id`.
 *
 * Read once, from `--help`, and cached for the run. Asked rather than inferred
 * from the version number, because the version is a string this repository has
 * no contract over and the flag list is the CLI answering about itself.
 *
 * It has to be asked at all because the failure is total: an unrecognised flag
 * is a `claude` that exits before it opens a session, and Helm assigning the
 * conversation id is worth exactly nothing next to that. So the flag is only
 * passed where the CLI has said it exists, and a CLI without it launches the
 * way it did before this - the join then falls back to the pty's pid, which is
 * the right answer for a direct spawn and no answer at all through a `.cmd`
 * shim.
 *
 * `null` - no CLI, or `--help` that could not be run - is read as **not
 * supported**, for the same reason: the safe direction here is the launch that
 * still happens.
 */
export async function readClaudeSupportsSessionId(at?: string): Promise<boolean> {
  if (sessionIdSupport !== null) return sessionIdSupport
  const command = resolveClaudeCommand(at)
  if (!command) return false
  try {
    const { stdout } = await run(command.file, [...command.prefixArgs, '--help'], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    })
    sessionIdSupport = /--session-id\b/.test(stdout)
  } catch {
    sessionIdSupport = false
  }
  if (!sessionIdSupport) {
    // Said once, about the binary, rather than at every launch about something
    // the user cannot fix from inside Helm. It is a degradation and not a
    // failure: sessions launch exactly as they did before, and what is lost is
    // the durable join between a tab and its conversation - which only shows up
    // as a tab whose state dot stays at "running" through a `.cmd` shim.
    console.warn(
      `${command.resolved} does not list --session-id, so Helm cannot assign ` +
        'conversation ids. Sessions still launch; the session-state indicator ' +
        'falls back to joining on the pty pid.'
    )
  }
  return sessionIdSupport
}

/** What the last probe answered, without running one. `null` before the first. */
export function claudeSessionIdSupport(): boolean | null {
  return sessionIdSupport
}

/** Clears the cache - the CLI path setting has moved, so the answer may have. */
export function forgetClaudeCapabilities(): void {
  sessionIdSupport = null
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
