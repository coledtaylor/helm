import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PortRow, ProcessRow } from '@helm/core'
import {
  runTool,
  splitSocketAddress,
  toInt,
  uniquePorts,
  type HostProcessFacts,
  type ToolRunner
} from './processes-tool'

/**
 * The processes-and-ports pass on Linux, WSL included: the process table from
 * `/proc`, the listening sockets from `ss`.
 *
 * `/proc` is read rather than `ps` run, because it is what `ps` reads and it is
 * already a file per fact: `stat` for the parent and the name, `cmdline` for
 * the arguments, NUL-separated so nothing has to be split back out of a line.
 * The reads are asynchronous and run together, so the main thread spends only
 * the parse on them.
 *
 * `ss -ltnpH` names the owning pid of a socket only for this user's own
 * processes when unprivileged, which is every session Helm started. A row it
 * printed without one cannot be joined to a process and is left out.
 */

/** `ss`: listening (`-l`) TCP (`-t`) sockets, numeric (`-n`), with processes (`-p`), no header (`-H`). */
export const SS_ARGS = ['-ltnpH'] as const

/**
 * One `/proc/<pid>/stat` line.
 *
 * The name is the second field, in parentheses, and may itself hold spaces and
 * parentheses - so it runs to the *last* `)`, and the fields after it are split
 * from there. The parent is the second field after the name.
 */
export function parseProcStat(text: string): { pid: number; parentPid: number; name: string } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = toInt(text.slice(0, open).trim())
  const after = text.slice(close + 1).trim().split(/\s+/)
  const parentPid = toInt(after[1])
  if (pid === null || parentPid === null) return null
  const name = text.slice(open + 1, close)
  return { pid, parentPid, name: name === '' ? String(pid) : name }
}

/**
 * One `/proc/<pid>/cmdline`: arguments separated by NUL, with a trailing NUL.
 *
 * Empty for a kernel thread and for a zombie, which have none - null, the same
 * "would not give it up" Windows reports for a process it may not open.
 */
export function parseProcCmdline(raw: Buffer | string): string | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  const args = text.split('\0').filter((arg) => arg !== '')
  return args.length === 0 ? null : args.join(' ')
}

/**
 * The process table under a `/proc`, or null when it cannot be listed.
 *
 * Takes the root so a test can hand it a directory shaped like `/proc`. A
 * process that exits between the listing and its reads is simply not in the
 * table; that is the ordinary race of reading a live one.
 */
export async function readProcTable(procRoot = '/proc'): Promise<ProcessRow[] | null> {
  let entries: string[]
  try {
    entries = await readdir(procRoot)
  } catch {
    return null
  }
  const rows = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry): Promise<ProcessRow | null> => {
        const dir = join(procRoot, entry)
        try {
          const [stat, cmdline] = await Promise.all([
            readFile(join(dir, 'stat'), 'utf8'),
            readFile(join(dir, 'cmdline')).catch(() => null)
          ])
          const parsed = parseProcStat(stat)
          if (parsed === null) return null
          return { ...parsed, commandLine: cmdline === null ? null : parseProcCmdline(cmdline) }
        } catch {
          return null
        }
      })
  )
  return rows.filter((row): row is ProcessRow => row !== null)
}

/**
 * Parses `ss -ltnpH` output.
 *
 * Columns: state, receive queue, send queue, local address, peer address, and
 * then `users:(("node",pid=123,fd=21),...)` - one socket can be held by several
 * processes, and each is a row. `*` as a local address is a socket on every
 * address of both families.
 */
export function parseSsListening(text: string): PortRow[] {
  const rows: PortRow[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 5) continue
    const local = splitSocketAddress(fields[3] ?? '', '::')
    if (local === null) continue
    const users = fields.slice(5).join(' ')
    for (const match of users.matchAll(/pid=(\d+)/g)) {
      const pid = toInt(match[1])
      if (pid !== null) rows.push({ pid, port: local.port, address: local.address })
    }
  }
  return uniquePorts(rows)
}

export async function readLinuxProcesses(
  timeoutMs: number,
  run: ToolRunner = runTool,
  procRoot = '/proc'
): Promise<HostProcessFacts> {
  const [processes, ss] = await Promise.all([readProcTable(procRoot), run('ss', SS_ARGS, timeoutMs)])
  return { processes, ports: ss !== null && ss.code === 0 ? parseSsListening(ss.stdout) : null }
}
