import { posix } from 'node:path'
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
 * The processes-and-ports pass on macOS: `ps` for the table, `lsof` for the
 * listening sockets.
 *
 * Two `ps` calls rather than one, because a row can carry only one free-text
 * column: `comm` (the executable's path) and `args` (the command line) can
 * both hold spaces, so a single `pid ppid comm args` line cannot be split back
 * into its fields. Each call ends in its one free-text column, and the two are
 * joined on the pid. All three tools run at once; the pass costs what the
 * slowest of them does.
 *
 * Unelevated, as everywhere: `ps` lists every process to every user, and
 * `lsof` without root lists the sockets of this user's own processes, which is
 * every session Helm started.
 */

/** `ps -axww -o pid=,ppid=,comm=`: the tree and each process's name. */
export const PS_NAMES_ARGS = ['-axww', '-o', 'pid=,ppid=,comm='] as const
/** `ps -axww -o pid=,args=`: each process's full command line. */
export const PS_ARGS_ARGS = ['-axww', '-o', 'pid=,args='] as const
/**
 * `lsof` in its field output, listening TCP sockets only, with no name or port
 * lookups (`-nP`) and no warnings (`-w`): `p` starts a process, `t` says the
 * family of the file after it and `n` its address.
 */
export const LSOF_ARGS = ['-nP', '-w', '-iTCP', '-sTCP:LISTEN', '-F', 'ptn'] as const

const ROW = /^\s*(\d+)\s+(\d+)\s+(.*)$/
const PID_REST = /^\s*(\d+)\s+(.*)$/

/** Parses `ps -o pid=,ppid=,comm=` into rows with no command line yet. */
export function parsePsNames(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const match = ROW.exec(line)
    if (match === null) continue
    const pid = toInt(match[1])
    const parentPid = toInt(match[2])
    if (pid === null || parentPid === null) continue
    const comm = (match[3] ?? '').trim()
    rows.push({ pid, parentPid, name: comm === '' ? String(pid) : posix.basename(comm), commandLine: null })
  }
  return rows
}

/** Parses `ps -o pid=,args=` into a command line per pid. */
export function parsePsArgs(text: string): Map<number, string> {
  const lines = new Map<number, string>()
  for (const line of text.split('\n')) {
    const match = PID_REST.exec(line)
    if (match === null) continue
    const pid = toInt(match[1])
    const args = (match[2] ?? '').trim()
    if (pid === null || args === '') continue
    lines.set(pid, args)
  }
  return lines
}

/** Parses `lsof -F ptn` output into one row per listening address. */
export function parseLsofListening(text: string): PortRow[] {
  const rows: PortRow[] = []
  let pid: number | null = null
  let family = ''
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const field = line.charAt(0)
    const value = line.slice(1)
    if (field === 'p') {
      pid = toInt(value)
      family = ''
    } else if (field === 'f') {
      family = ''
    } else if (field === 't') {
      family = value
    } else if (field === 'n' && pid !== null) {
      const split = splitSocketAddress(value, family === 'IPv6' ? '::' : '0.0.0.0')
      if (split !== null) rows.push({ pid, port: split.port, address: split.address })
    }
  }
  return uniquePorts(rows)
}

/**
 * What `lsof` answered, as rows or as "could not look".
 *
 * `lsof` exits 1 both for "nothing matched" and for a real failure, so the exit
 * code alone cannot say which. Nothing on stdout and nothing on stderr is the
 * first; a failure says why on stderr (`-w` keeps warnings off it).
 */
export function lsofResult(output: { stdout: string; stderr: string; code: number } | null): PortRow[] | null {
  if (output === null) return null
  if (output.code === 0) return parseLsofListening(output.stdout)
  if (output.stdout.trim() !== '') return parseLsofListening(output.stdout)
  if (output.code === 1 && output.stderr.trim() === '') return []
  return null
}

export async function readDarwinProcesses(timeoutMs: number, run: ToolRunner = runTool): Promise<HostProcessFacts> {
  const [names, args, lsof] = await Promise.all([
    run('ps', PS_NAMES_ARGS, timeoutMs),
    run('ps', PS_ARGS_ARGS, timeoutMs),
    run('lsof', LSOF_ARGS, timeoutMs)
  ])

  let processes: ProcessRow[] | null = null
  if (names !== null && names.code === 0) {
    // The command lines are a second read of the same table. Without them the
    // tree still stands, each row's command line unknown rather than invented.
    const lines = args !== null && args.code === 0 ? parsePsArgs(args.stdout) : new Map<number, string>()
    processes = parsePsNames(names.stdout).map((row) => ({ ...row, commandLine: lines.get(row.pid) ?? null }))
  }
  return { processes, ports: lsofResult(lsof) }
}
