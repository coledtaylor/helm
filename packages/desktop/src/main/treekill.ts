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
 *
 * One way per OS family:
 *
 * - **Windows**: `taskkill /T /F`, which walks the tree itself.
 * - **macOS and Linux**: the process group, plus a walk of the process table.
 *   A session's pty leads its own group (node-pty starts it with `setsid`),
 *   and a plugin's program or service is spawned `detached` so it leads one
 *   too (`POSIX_OWN_GROUP`) - so `kill(-pid)` ends everything that stayed in
 *   the group. The walk is for what did not: a child that moved to a group of
 *   its own, or a root that never led one (an Electron utility process). It
 *   reads the table *before* anything is killed, because a child whose parent
 *   has exited is re-parented and no longer names it.
 */
export function treeKill(pid: number, sync: boolean): void {
  if (pid <= 0) return
  if (process.platform === 'win32') {
    windowsTreeKill(pid, sync)
    return
  }
  if (sync) {
    let table: string | null = null
    try {
      table = execFileSync('ps', PS_TREE_ARGS, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000 })
    } catch {
      // No table: the group kill below still ends everything in the group.
    }
    posixKill(pid, table)
    return
  }
  execFile('ps', PS_TREE_ARGS, { encoding: 'utf8', timeout: 4000 }, (error, stdout) => {
    posixKill(pid, error === null ? stdout : null)
  })
}

/**
 * The spawn option that puts a child in a process group of its own on macOS
 * and Linux, so `treeKill` can end it with everything it started.
 *
 * Windows is left as it is: `detached` there means a new console window, and
 * `taskkill /T` needs no group.
 */
export const POSIX_OWN_GROUP: { detached: boolean } = { detached: process.platform !== 'win32' }

/** `ps` in the form macOS and Linux both take: every process, pid and parent. */
const PS_TREE_ARGS = ['-A', '-o', 'pid=,ppid=']

/**
 * The pids under `root` in a `ps -o pid=,ppid=` table, nearest first.
 *
 * Bounded by `seen`, because a table read at slightly different instants can
 * hold a cycle, and never following pid 0 or 1, which every orphan names.
 */
export function descendantsIn(table: string, root: number): number[] {
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const parent = Number(match[2])
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [pid])
    else list.push(pid)
  }
  const seen = new Set<number>([root, 0, 1])
  const order: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    const next = queue.shift() as number
    for (const child of children.get(next) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      order.push(child)
      queue.push(child)
    }
  }
  return order
}

function signal(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone, or never had a group of its own.
  }
}

function posixKill(pid: number, table: string | null): void {
  const below = table === null ? [] : descendantsIn(table, pid)
  // Negative pid = the process group, which is the POSIX equivalent of /T.
  signal(-pid)
  signal(pid)
  for (const child of below) signal(child)
}

function windowsTreeKill(pid: number, sync: boolean): void {
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
