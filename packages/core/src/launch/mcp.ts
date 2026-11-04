import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { probeProcess } from './overlay'

/**
 * The per-session `--mcp-config` files an earlier Helm wrote under its data
 * directory, when it ran sessions in its own process, swept at start.
 *
 * Each carried a bearer token for that run's listener, was named
 * `mcp-<pid>-<something unique>.json` after the process that wrote it, and was
 * removed when its session ended. What a crash left behind is still on disk in
 * an upgraded install, so start removes it by the rule the overlay shims are
 * swept by: the owning process is asked about, and anything not provably gone
 * is left alone. The local host writes its sessions' files in its own folder,
 * never here.
 *
 * The pid is in the name rather than in the JSON so the sweep decides from a
 * directory listing, never by parsing a file another process may be writing.
 */
const PREFIX = 'mcp-'
const SUFFIX = '.json'

/** The pid a file name claims, or null when it is not one of ours. */
function pidOf(name: string): number | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null
  const pid = Number(name.slice(PREFIX.length).split('-')[0])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * What a crashed run left behind, removed - and **only** what is provably dead.
 *
 * The same asymmetry `cleanStaleShims` is built on: a leftover config file is
 * inert bytes naming a port nothing is listening on, where a file deleted out
 * from under a live session is a session whose tools stop working mid-task.
 * So `unknown` and `alive` both mean leave it. Two Helms sharing a data
 * directory is a state `paths.ts` allows, and this is what makes that safe.
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
