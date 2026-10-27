import { execFile } from 'node:child_process'
import type { PortRow, ProcessRow } from '@helm/core'

/**
 * What one OS's reader managed to see: each half null when it could not look.
 *
 * The per-OS readers (`processes.ts` for Windows, `processes-darwin.ts`,
 * `processes-linux.ts`) all produce this, and `readProcessSnapshot` stamps it
 * with the time. Nothing outside those readers branches on the OS.
 */
export interface HostProcessFacts {
  processes: ProcessRow[] | null
  ports: PortRow[] | null
}

/** One OS's way of reading its process table and listening sockets. */
export type ProcessTableReader = (timeoutMs: number) => Promise<HostProcessFacts>

/** How a tool run ended, when it could be run at all. */
export interface ToolOutput {
  stdout: string
  stderr: string
  /** The exit code; 0 for success. */
  code: number
}

/**
 * Runs one tool through `execFile` and says how it ended.
 *
 * `null` means it could not be run or did not finish: not on the machine, a
 * spawn that failed, a timeout, a signal. A non-zero exit is an answer and
 * comes back with its code, because `lsof` exits 1 for "nothing matched" and
 * that is an empty list, not a failure. Never rejects.
 */
export type ToolRunner = (file: string, args: readonly string[], timeoutMs: number) => Promise<ToolOutput | null>

/** The output ceiling, for the reason `processes.ts` gives for its own. */
const MAX_BUFFER = 32 * 1024 * 1024

export const runTool: ToolRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(
        file,
        [...args],
        { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ stdout, stderr, code: 0 })
            return
          }
          // A numeric code is the program's own exit; anything else (ENOENT,
          // EACCES, a timeout's kill, maxBuffer) is "could not look".
          if (typeof error.code === 'number' && error.killed !== true && !error.signal) {
            resolve({ stdout, stderr, code: error.code })
            return
          }
          resolve(null)
        }
      )
    } catch {
      // `execFile` throws synchronously for a spawn it cannot even attempt.
      resolve(null)
    }
  })

export function toInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * `host:port` as a socket tool prints it, split into the two halves.
 *
 * Covers what `lsof` and `ss` both print: `127.0.0.1:3000`, `[::1]:3000`,
 * `*:8080`, and `127.0.0.53%lo:53` with an interface after the address.
 * `wildcard` is what `*` means for the tool and family that printed it.
 */
export function splitSocketAddress(
  text: string,
  wildcard: string
): { address: string | null; port: number } | null {
  const colon = text.lastIndexOf(':')
  if (colon <= 0) return null
  const port = toInt(text.slice(colon + 1))
  if (port === null || port <= 0 || port > 65_535) return null
  let host = text.slice(0, colon)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const zone = host.indexOf('%')
  if (zone >= 0) host = host.slice(0, zone)
  if (host === '*') host = wildcard
  return { address: host === '' ? null : host, port }
}

/** One listening socket per (pid, port, address), whatever the tool repeated. */
export function uniquePorts(rows: readonly PortRow[]): PortRow[] {
  const seen = new Set<string>()
  const out: PortRow[] = []
  for (const row of rows) {
    const key = `${String(row.pid)}|${String(row.port)}|${row.address ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}
