import { execFile } from 'node:child_process'
import { noProcessSnapshot, type PortRow, type ProcessRow, type ProcessSnapshot } from '@helm/core'

/**
 * The machine's process table and its listening sockets, asked for once.
 *
 * The host half of `core/resources/` - `packages/core` never imports Electron
 * and never shells out for platform facts, so the platform call is here and the
 * shape it produces is handed over.
 *
 * ## Why CIM, and why one child process
 *
 * `Get-CimInstance Win32_Process` gives `ParentProcessId` and `CommandLine`
 * unelevated, which is the whole of what a tree needs, and
 * `MSFT_NetTCPConnection` gives `OwningProcess`, which maps a listening port to
 * a pid without a privileged call. `wmic` would answer the first and is
 * deprecated and absent from recent Windows 11 builds; `sessionscheck.ts`
 * records that reasoning at its own tree walk and this is the same mechanism,
 * not a third one.
 *
 * `Get-NetTCPConnection` is the friendlier spelling of the second query and is
 * deliberately not used: it lives in a module, and **the first call pays for
 * loading it**. Measured twice on this machine, 2026-08-20: 970ms then 518ms
 * for the first call in a shell, against 76ms then 87ms for the second in the
 * same shell - and a flat 107-134ms for the CIM class it wraps, whether or not
 * anything has touched `NetTCPIP`. A pass whose cost depends on what else has
 * already run in the process is a pass with no budget.
 *
 * Both queries go in **one** child process because the cost here is not the
 * queries. Measured on this machine over two runs of five and six consecutive
 * passes: **400-480ms wall, of which the two queries are 160-240ms** - the rest
 * is `powershell.exe` starting. Two spawns would very nearly double a pass for
 * nothing. Under `sessions-check`, with three sessions running and 301
 * processes on the machine, the same pass measured **478-547ms**: the shape of
 * this cost is the spawn, and load moves it by tens of milliseconds.
 *
 * ## The budget, stated
 *
 * The number that matters for a repeating timer is not the wall time, it is how
 * much of it lands on the **main thread**, because that is what pty resizes and
 * IPC replies queue behind. The archive is the standing warning: 16MB chunks of
 * synchronous work at start-up were enough to make `settings-check`'s terminal
 * group fail, and that one was not on a timer.
 *
 * So: `execFile`, never `execFileSync`. The 400ms is another process's, and
 * this one's share of a pass is the JSON parse - **0.11 to 0.21ms** over 58 to
 * 66KB and 276 to 285 processes, measured on the same eleven passes.
 * `resources.ts` owns the interval that number is spent at, and says what it
 * chose.
 *
 * ## What it never does
 *
 * **No elevation is assumed and none is asked for.** A process this user may
 * not open answers `null` for its command line - 159 of 277 did, unelevated, on
 * this machine, and 158 of 276 on a second run - and that is carried through as
 * `null` rather than made into a
 * failure. Nothing here retries with different credentials, and nothing reads
 * anything out of a process: the four fields below are what `Win32_Process`
 * publishes about every process to every user, and the command line is the only
 * one that is ever withheld.
 */

/**
 * One PowerShell pass, written without a single double quote.
 *
 * That constraint is load-bearing rather than stylistic. This string is handed
 * to `powershell.exe -Command` through `execFile`, which quotes the argument
 * for the Windows command line; a `"` inside it would have to survive that
 * quoting and then `powershell.exe`'s own re-parse, and the failure mode is a
 * script silently cut in half. `cmd`'s two-quote rule is the same class of bug
 * that broke every `.cmd` shim launch (`SESS-20`), and the cheapest way not to
 * have it is to have no quotes to strip.
 *
 * Each query is wrapped in its own `try`, under `$ErrorActionPreference =
 * 'Stop'` so a non-terminating error still reaches the `catch`, and each sets
 * its own `read` flag. That flag - not the length of the array beside it - is
 * what says whether the query ran, because "no listening sockets" and "the
 * socket query failed" are different claims and an empty array cannot tell them
 * apart. `[ordered]` inside `[pscustomobject]` keeps an empty array serialising
 * as `[]` and a one-element array as a one-element array, which the pipeline
 * root does not (measured on PowerShell 5.1.26100).
 */
const PASS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$out = [ordered]@{ processesRead = $false; portsRead = $false; processes = @(); ports = @() }
try {
  $out.processes = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine |
    ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; r = [int]$_.ParentProcessId; n = $_.Name; c = $_.CommandLine } })
  $out.processesRead = $true
} catch {}
try {
  $out.ports = @(Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter 'State=2' |
    ForEach-Object { [pscustomobject]@{ p = [int]$_.OwningProcess; t = [int]$_.LocalPort; a = $_.LocalAddress } })
  $out.portsRead = $true
} catch {}
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 3
`

/** How long a pass may take before it is abandoned. See `resources.ts`. */
const PASS_TIMEOUT_MS = 15_000

/**
 * The output ceiling.
 *
 * 58-66KB on a machine with 276-285 processes, so 32MB is four hundred times the
 * measured size. It is here because `execFile`'s default is 1MB and a machine
 * with long command lines would silently truncate against it - and a truncated
 * JSON document is a failed parse, which this file reports as "could not look".
 * A ceiling that produces the right answer for the wrong reason is worse than
 * none.
 */
const MAX_BUFFER = 32 * 1024 * 1024

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null
  }
  return null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * One JSON document, parsed tolerantly.
 *
 * Same posture as the registry reader's parse and for the same reason: this is
 * a shape produced by another program's serialiser, so a field going missing or
 * changing type must cost a value and never an exception. A row that cannot
 * name a pid is dropped, since nothing can be joined to it.
 */
function parsePass(text: string): { processes: ProcessRow[] | null; ports: PortRow[] | null } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { processes: null, ports: null }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { processes: null, ports: null }
  }
  const bag = value as Record<string, unknown>

  const rows = (key: string): unknown[] => {
    const found = bag[key]
    if (Array.isArray(found)) return found
    // A shape that stopped being an array is still usable as one row.
    return found === null || found === undefined ? [] : [found]
  }

  const processes: ProcessRow[] | null =
    bag['processesRead'] === true
      ? rows('processes').flatMap((row): ProcessRow[] => {
          if (typeof row !== 'object' || row === null) return []
          const item = row as Record<string, unknown>
          const pid = int(item['p'])
          const parentPid = int(item['r'])
          if (pid === null) return []
          return [
            {
              pid,
              parentPid: parentPid ?? 0,
              name: str(item['n']) ?? String(pid),
              commandLine: str(item['c'])
            }
          ]
        })
      : null

  const ports: PortRow[] | null =
    bag['portsRead'] === true
      ? rows('ports').flatMap((row): PortRow[] => {
          if (typeof row !== 'object' || row === null) return []
          const item = row as Record<string, unknown>
          const pid = int(item['p'])
          const port = int(item['t'])
          if (pid === null || port === null) return []
          return [{ pid, port, address: str(item['a']) }]
        })
      : null

  return { processes, ports }
}

/**
 * One pass over the machine.
 *
 * Never rejects and never throws. A host that cannot be asked - no
 * `powershell.exe`, a timeout, a parse that failed - is a snapshot of nulls,
 * which is what `sessionResources` turns into "unknown" rather than "empty".
 */
export function readProcessSnapshot(timeoutMs = PASS_TIMEOUT_MS): Promise<ProcessSnapshot> {
  const startedAt = Date.now()
  const startedHr = process.hrtime.bigint()

  if (process.platform !== 'win32') {
    // The enumeration is Windows-shaped and Helm is Windows-first. Elsewhere
    // this reports "could not look", which is the honest answer and the one the
    // surfaces already degrade to.
    return Promise.resolve(noProcessSnapshot(startedAt))
  }

  return new Promise<ProcessSnapshot>((resolve) => {
    const done = (parsed: { processes: ProcessRow[] | null; ports: PortRow[] | null }): void => {
      resolve({
        processes: parsed.processes,
        ports: parsed.ports,
        atMs: startedAt,
        durationMs: Number(process.hrtime.bigint() - startedHr) / 1e6
      })
    }

    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', PASS_SCRIPT],
        { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout) => {
          // `error` is set for a non-zero exit and for the timeout, and stdout
          // may still hold a whole document in the first case - the script
          // swallows its own query failures, so a non-zero exit means something
          // else went wrong and the flags in the document are still the
          // authority. Parsing it either way costs a fifth of a millisecond.
          if (error && stdout.trim() === '') {
            done({ processes: null, ports: null })
            return
          }
          done(parsePass(stdout))
        }
      )
    } catch {
      // `execFile` throws synchronously for a spawn it cannot even attempt.
      done({ processes: null, ports: null })
    }
  })
}
