import type { BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
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
 */

interface ShellRecord {
  id: number
  path: string
  shell: string
}

export interface PtermHost {
  open: (path: string, cols: number, rows: number) => { id: number; shell: string }
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  close: (id: number) => void
}

let shellFile: string | null = null

/** PowerShell 7 when the machine has it, Windows PowerShell otherwise. */
function shellExecutable(): string {
  if (shellFile !== null) return shellFile
  if (process.platform !== 'win32') {
    shellFile = process.env['SHELL'] ?? 'bash'
    return shellFile
  }
  try {
    execFileSync('where.exe', ['pwsh.exe'], { stdio: 'pipe', windowsHide: true, timeout: 3000 })
    shellFile = 'pwsh.exe'
  } catch {
    shellFile = 'powershell.exe'
  }
  return shellFile
}

export function createPtermHost(window: () => BrowserWindow | null): PtermHost {
  let nextId = 1
  const byId = new Map<number, ShellRecord>()
  const byPath = new Map<string, ShellRecord>()

  const drop = (record: ShellRecord): void => {
    byId.delete(record.id)
    if (byPath.get(record.path.toLowerCase()) === record) {
      byPath.delete(record.path.toLowerCase())
    }
  }

  return {
    open: (path, cols, rows) => {
      const existing = byPath.get(path.toLowerCase())
      if (existing) return { id: existing.id, shell: existing.shell }

      const id = nextId++
      const shell = shellExecutable()
      const record: ShellRecord = { id, path, shell }

      // `-NoLogo` for both PowerShells: the banner is three lines of chrome in
      // a pane that is deliberately short.
      spawnSession({
        id: `shell:${String(id)}`,
        file: shell,
        args: shell.includes('powershell') || shell.includes('pwsh') ? ['-NoLogo'] : [],
        cols,
        rows,
        cwd: path,
        onData: (chunk) => {
          const win = window()
          if (win && !win.isDestroyed()) win.webContents.send('pterm:data', { id, data: chunk })
        },
        onExit: (exitCode) => {
          drop(record)
          const win = window()
          if (win && !win.isDestroyed()) win.webContents.send('pterm:exit', { id, exitCode })
        }
      })

      byId.set(id, record)
      byPath.set(path.toLowerCase(), record)
      return { id, shell }
    },

    input: (id, data) => getSession(`shell:${String(id)}`)?.write(data),

    resize: (id, cols, rows) => getSession(`shell:${String(id)}`)?.resize(cols, rows),

    close: (id) => {
      const record = byId.get(id)
      if (!record) return
      drop(record)
      killSession(`shell:${String(id)}`)
    }
  }
}
