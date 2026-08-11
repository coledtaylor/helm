import type { BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import type { DetectedShell } from '@helm/core'
import { getSession, killSession, spawnSession } from './pty'

/**
 * Project shells: a plain terminal per project, opened in that project's
 * directory and shown under the project pane.
 *
 * Deliberately not a session. A hosted `claude` gets a database row, an exit
 * notification and a place in history; a shell for `git status` and `pnpm dev`
 * is furniture, and recording it would put noise in every surface that reads
 * sessions. It rides the same pty registry (`spawnSession`), so app shutdown
 * tree-kills shells exactly the way it kills sessions - but under `shell:` ids
 * the session host never sees.
 *
 * One shell per project path: reopening a project tab reattaches to the shell
 * it already had rather than stacking processes.
 *
 * Which executable that is has three sources, in order: what the pane asked for
 * (its own picker), the `terminalShell` setting, and failing both, detection.
 * Only the last of those is memoised, and it is the only one that is a fact
 * about the machine rather than a choice someone made - so a settings change
 * takes effect on the next shell opened, with no restart.
 */

interface ShellRecord {
  id: number
  path: string
  shell: string
  cols: number
  rows: number
  /**
   * The grid the pty was opened at - the renderer's pre-spawn estimate, before
   * any pane had measured itself. Kept because it is the only record of it:
   * the first fit overwrites `cols`/`rows` within a frame, and "the estimate
   * lands within a column of the fit" is a claim about the difference.
   */
  opened: { cols: number; rows: number }
}

export interface OpenShellRequest {
  path: string
  cols: number
  rows: number
  /** This pane only. Absent means the default shell. */
  shell?: string | null | undefined
}

export interface OpenedShell {
  id: number
  /** The executable actually running. */
  shell: string
  /** What was asked for, when that is not what runs. Null when they agree. */
  requested: string | null
  /** Why. Null when nothing went wrong. */
  problem: string | null
}

export interface PtermHost {
  open: (request: OpenShellRequest) => OpenedShell
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  close: (id: number) => void
  /** The grid the pane last reported, which is what the pty is actually at. */
  grid: (id: number) => { cols: number; rows: number } | null
  /** Open shells, for a driver to check what is running where. */
  list: () => Array<{
    id: number
    path: string
    shell: string
    grid: { cols: number; rows: number }
    opened: { cols: number; rows: number }
  }>
  /** Shells found on this machine, for the pickers. */
  detected: () => DetectedShell[]
}

// ---------------------------------------------------------------------------
// Which shells this machine has
// ---------------------------------------------------------------------------

/**
 * The shells Helm knows how to launch, and the arguments each one wants.
 *
 * Keyed by **file name**, not by substring of the whole path. The substring
 * test this replaces asked whether the executable's path contained `powershell`
 * or `pwsh`, which is true of `C:\pwsh-tools\bin\bash.exe` - and `bash -NoLogo`
 * does not start a shell, it prints a usage error and exits.
 *
 * `cmd.exe` has no quiet flag; its two-line banner is unavoidable. The POSIX
 * shells are launched **without** `-l`: a login shell sources a profile, and
 * under Git for Windows that profile changes directory to `$HOME` unless
 * `CHERE_INVOKING` is set - which would defeat the one thing a project shell is
 * for.
 */
const KNOWN_SHELLS: Array<{ file: string; label: string; args: string[] }> = [
  // The banner is three lines of chrome in a pane that is deliberately short.
  { file: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'] },
  { file: 'powershell.exe', label: 'Windows PowerShell', args: ['-NoLogo'] },
  { file: 'cmd.exe', label: 'Command Prompt', args: [] },
  { file: 'wsl.exe', label: 'WSL', args: [] },
  { file: 'bash.exe', label: 'Bash', args: [] },
  { file: 'bash', label: 'Bash', args: [] },
  { file: 'zsh', label: 'Zsh', args: [] },
  { file: 'fish', label: 'Fish', args: [] },
  { file: 'sh', label: 'Shell', args: [] }
]

function known(file: string): { file: string; label: string; args: string[] } | undefined {
  const name = basename(file).toLowerCase()
  return KNOWN_SHELLS.find((entry) => entry.file === name)
}

/** The arguments to launch `file` with. Unknown shells get none. */
export function shellArgs(file: string): string[] {
  return known(file)?.args ?? []
}

/** `where.exe <name>`, first hit only. Absolute, which is what gets stored. */
function whereIs(name: string): string | null {
  try {
    const out = execFileSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '')
    return first ?? null
  } catch {
    return null
  }
}

let detectedShells: DetectedShell[] | null = null

/**
 * Every known shell this machine actually has.
 *
 * Memoised: `where.exe` five times is a hundred milliseconds, and the answer is
 * a property of the installation rather than of the app's state. Nothing a user
 * can change in Helm changes it.
 */
export function detectShells(): DetectedShell[] {
  if (detectedShells !== null) return detectedShells

  const found: DetectedShell[] = []
  if (process.platform === 'win32') {
    for (const entry of KNOWN_SHELLS) {
      if (!entry.file.endsWith('.exe')) continue
      const path = whereIs(entry.file)
      if (path === null) continue
      found.push({ path, name: basename(path), label: entry.label, args: entry.args })
    }
  } else {
    const fromEnv = process.env['SHELL']
    const candidates = [fromEnv, '/bin/bash', '/bin/zsh', '/bin/sh'].filter(
      (candidate): candidate is string => candidate !== undefined && candidate !== ''
    )
    for (const candidate of candidates) {
      if (found.some((entry) => entry.path === candidate)) continue
      const entry = known(candidate)
      found.push({
        path: candidate,
        name: basename(candidate),
        label: entry?.label ?? basename(candidate),
        args: entry?.args ?? []
      })
    }
  }
  detectedShells = found
  return found
}

/** The shell to use when nothing has been chosen. */
function autoShell(): string {
  const found = detectShells()
  if (found.length > 0) return found[0]?.path ?? 'powershell.exe'
  // Nothing was found, which on Windows means `where.exe` itself failed. The
  // guaranteed-present fallbacks are better than refusing to open a shell.
  return process.platform === 'win32' ? 'powershell.exe' : (process.env['SHELL'] ?? 'bash')
}

export interface PtermDeps {
  window: () => BrowserWindow | null
  /**
   * The `terminalShell` setting, read at every open rather than captured.
   * Reading it once would make the choice a property of when Helm started.
   */
  defaultShell: () => string | null
}

export function createPtermHost(deps: PtermDeps): PtermHost {
  let nextId = 1
  const byId = new Map<number, ShellRecord>()
  const byPath = new Map<string, ShellRecord>()

  const drop = (record: ShellRecord): void => {
    byId.delete(record.id)
    if (byPath.get(record.path.toLowerCase()) === record) {
      byPath.delete(record.path.toLowerCase())
    }
  }

  const start = (id: number, file: string, request: OpenShellRequest): void => {
    spawnSession({
      id: `shell:${String(id)}`,
      file,
      args: shellArgs(file),
      cols: request.cols,
      rows: request.rows,
      cwd: request.path,
      onData: (chunk) => {
        const win = deps.window()
        if (win && !win.isDestroyed()) win.webContents.send('pterm:data', { id, data: chunk })
      },
      onExit: (exitCode) => {
        const record = byId.get(id)
        if (record) drop(record)
        const win = deps.window()
        if (win && !win.isDestroyed()) win.webContents.send('pterm:exit', { id, exitCode })
      }
    })
  }

  return {
    open: (request) => {
      const existing = byPath.get(request.path.toLowerCase())
      if (existing) {
        return { id: existing.id, shell: existing.shell, requested: null, problem: null }
      }

      const wanted = request.shell ?? deps.defaultShell() ?? autoShell()
      const id = nextId++

      let shell = wanted
      let requested: string | null = null
      let problem: string | null = null
      try {
        start(id, wanted, request)
      } catch (err) {
        // A shell that will not spawn - uninstalled since it was picked, or
        // renamed - must not leave the project pane with an empty box and no
        // explanation. Fall back to what Helm would have found on its own and
        // say what happened.
        const fallback = autoShell()
        if (fallback.toLowerCase() === wanted.toLowerCase()) throw err
        start(id, fallback, request)
        shell = fallback
        requested = wanted
        problem = err instanceof Error ? err.message : String(err)
      }

      const record: ShellRecord = {
        id,
        path: request.path,
        shell,
        cols: request.cols,
        rows: request.rows,
        opened: { cols: request.cols, rows: request.rows }
      }
      byId.set(id, record)
      byPath.set(request.path.toLowerCase(), record)
      return { id, shell, requested, problem }
    },

    input: (id, data) => getSession(`shell:${String(id)}`)?.write(data),

    resize: (id, cols, rows) => {
      const record = byId.get(id)
      if (record) {
        record.cols = cols
        record.rows = rows
      }
      getSession(`shell:${String(id)}`)?.resize(cols, rows)
    },

    close: (id) => {
      const record = byId.get(id)
      if (!record) return
      drop(record)
      killSession(`shell:${String(id)}`)
    },

    grid: (id) => {
      const record = byId.get(id)
      return record ? { cols: record.cols, rows: record.rows } : null
    },

    list: () =>
      [...byId.values()].map((record) => ({
        id: record.id,
        path: record.path,
        shell: record.shell,
        grid: { cols: record.cols, rows: record.rows },
        opened: { ...record.opened }
      })),

    detected: () => detectShells()
  }
}
