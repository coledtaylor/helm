import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeProcess } from './overlay'

/**
 * The per-session MCP registration, as a file on disk and two argv words.
 *
 * **Never `claude mcp add-json -s local`.** That writes into the user's
 * `~/.claude.json` on every launch, under `projects[<cwd>]`, and leaves the
 * entry there afterwards - so a Helm that had been run once would keep offering
 * a browser endpoint that no longer exists, and every launch would be a write
 * into a file CLAUDE.md says Helm only reads. `--mcp-config` takes a file, the
 * file belongs to Helm, and the session that was handed it is the only thing
 * that ever sees it. Nothing of the user's is touched at all.
 *
 * The file carries a **bearer token**, which is the reason for everything else
 * in here: it is written under Helm's own data directory rather than `%TEMP%`,
 * it is removed when the session it was written for ends, and what is left
 * behind by a crash is swept by the same rule the overlay shims are swept by -
 * the owning process is asked about, and anything not provably gone is left
 * alone.
 */

/** What a session is told about the endpoint. */
export interface SessionMcpServer {
  /** The name the tools appear under. One server, one name. */
  name: string
  /** `http://127.0.0.1:<port>/mcp`. Loopback, always. */
  url: string
  /** The bearer header. This is the whole of the auth. */
  headers: Record<string, string>
}

/**
 * The file name a sweep can reason about.
 *
 * `mcp-<pid>-<something unique>.json`. The pid is in the name rather than in
 * the JSON because the sweep has to be able to decide from a directory listing:
 * reading every file to find out whether it may be deleted means parsing files
 * another process may be part-way through writing.
 */
const PREFIX = 'mcp-'
const SUFFIX = '.json'

function fileName(pid: number): string {
  return `${PREFIX}${String(pid)}-${randomBytes(6).toString('hex')}${SUFFIX}`
}

/** The pid a file name claims, or null when it is not one of ours. */
function pidOf(name: string): number | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null
  const pid = Number(name.slice(PREFIX.length).split('-')[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Writes one session's MCP config and answers with where it went.
 *
 * The shape is the CLI's `--mcp-config` document: `mcpServers`, keyed by name,
 * `type: 'http'`. Written whole rather than merged into anything - this file
 * exists for one session and is deleted with it.
 */
export function writeSessionMcpConfig(dir: string, server: SessionMcpServer): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, fileName(process.pid))
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        mcpServers: {
          [server.name]: { type: 'http', url: server.url, headers: server.headers }
        }
      },
      null,
      2
    )}\n`
  )
  return file
}

/** Removes one, and says nothing if it is already gone. */
export function removeSessionMcpConfig(file: string | null): void {
  if (file === null) return
  try {
    rmSync(file, { force: true })
  } catch {
    // A file that could not be removed is a file the next sweep finds. It
    // carries a token no live endpoint will accept, so leaving one is inert.
  }
}

/**
 * What a crashed run left behind, removed - and **only** what is provably dead.
 *
 * The same asymmetry `cleanStaleShims` is built on, for a weaker reason and
 * therefore with the same answer: a leftover config file is inert bytes naming
 * a port nothing is listening on, where a file deleted out from under a live
 * session is a session whose tools stop working mid-task. So `unknown` and
 * `alive` both mean leave it. Two Helms sharing a data directory is a state
 * `paths.ts` allows, and this is what makes that safe.
 */
export function cleanStaleMcpConfigs(
  dir: string,
  probe: (pid: number) => 'alive' | 'gone' | 'unknown' = probeProcess
): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    const pid = pidOf(entry)
    if (pid === null) continue
    // This process's own files are not stale - `stop()` owns those.
    if (pid === process.pid) continue
    if (probe(pid) !== 'gone') continue
    try {
      rmSync(join(dir, entry), { force: true })
      removed.push(join(dir, entry))
    } catch {
      // Next start tries again.
    }
  }
  return removed
}
