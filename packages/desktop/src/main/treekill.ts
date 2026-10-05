import { execFile, execFileSync } from 'node:child_process'

/**
 * Ends a process and everything it started.
 *
 * Used wherever Helm owns a process that may have children: a session's pty
 * and a plugin's programs and service. A `.cmd` shim alone makes every one of
 * them a tree - `cmd.exe` and the program it ran.
 *
 * It began as the backstop behind `IPty.kill()`:
 *
 * Spike C deviation #8: node-pty's console-process enumeration hits
 * `AttachConsole failed` and falls back to killing the pty's own pid alone. A
 * hosted `claude` is a process *tree* - it spawns Node children for MCP
 * servers, ripgrep for searches, whatever a Bash tool call started - so that
 * fallback can leave the tree behind while the pane it belonged to is gone.
 * `taskkill /T` walks the tree the way node-pty could not.
 *
 * For a session it is not a substitute for `IPty.kill()`, which is still what
 * releases the ConPTY handles: this runs alongside it.
 */
export function treeKill(pid: number, sync: boolean): void {
  if (pid <= 0) return
  if (process.platform !== 'win32') {
    try {
      // Negative pid = the process group, which is the POSIX equivalent of /T.
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone, or never had a group of its own.
    }
    return
  }
  const args = ['/PID', String(pid), '/T', '/F']
  if (sync) {
    try {
      execFileSync('taskkill.exe', args, { windowsHide: true, stdio: 'ignore', timeout: 4000 })
    } catch {
      // Exit code 128 means "no such process", which is the outcome we wanted.
    }
    return
  }
  execFile('taskkill.exe', args, { windowsHide: true, timeout: 4000 }, () => undefined)
}
