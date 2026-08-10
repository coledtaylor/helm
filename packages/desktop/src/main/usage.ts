import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  claudeConfigFileIn,
  claudeHome,
  projectsDirIn,
  readUsage,
  usageFileState,
  type Store,
  type UsageFileState,
  type UsageSnapshot,
  type UsageSpend
} from '@helm/core'
import { createUsageIndex, USAGE_INDEX_POLL_MS, type UsageIndex } from './usageindex'

/**
 * Keeping the status bar's usage figures level with a file Helm does not own.
 *
 * The same two mechanisms `history.ts` uses on `history.jsonl`, for the same
 * reason: `~/.claude.json` is written by every `claude` on the machine, and the
 * refresh that matters most is the one Helm did not cause. An `fs.watch` on the
 * containing directory fires within milliseconds and is documented as not
 * available everywhere; a stat poll every few seconds costs one syscall and
 * covers the case where the watch is silent. Both funnel into one debounced
 * pass.
 *
 * Two differences from the history indexer, both because of what the file is.
 * It is not append-only - one changed digit rewrites the whole thing - so there
 * is no byte cursor and no tail; the pass reads and parses the file whole,
 * which measures about a millisecond at 134 KB. And nothing is written to the
 * database: a cached percentage is worth nothing once it is old, so persisting
 * it would only make it possible to paint a stale number after a restart.
 *
 * Staleness itself is deliberately not decided here. The main process ships the
 * reading and the window decides what may be painted from it, on a timer, using
 * the same pure function - because a reading goes stale and a window rolls over
 * with no file having changed, and a push-only design would leave a dead number
 * on screen until something happened to touch the disk.
 */

/** Long enough for the CLI's rewrite to land, short enough to feel immediate. */
const DEBOUNCE_MS = 150

/** The backstop, not the mechanism - one `stat` per tick. */
const POLL_MS = 4000

export interface UsageService {
  /** Reads now and returns the reading, whether or not it changed. */
  refresh: () => UsageSnapshot
  /** The last reading, without touching the disk. */
  snapshot: () => UsageSnapshot
  /** The file being read. */
  file: () => string
  /**
   * Reads a different file instead - `null` restores the real one.
   *
   * The one way the usage reader can be pointed at a fixture, used by
   * `--usage-check` to prove that a missing, stale or reshaped
   * `cachedUsageUtilization` paints nothing. It is a method on the service
   * rather than a channel on the IPC contract on purpose: the renderer has no
   * business choosing which file the figures come from.
   */
  pointAt: (file: string | null) => UsageSnapshot
  /** The transcript index behind the dollar estimate; `usage-check` drives it. */
  index: UsageIndex
  start: () => void
  stop: () => void
}

export interface UsageServiceDeps {
  /** Called after any pass whose reading differs from the one before it. */
  onChange: (snapshot: UsageSnapshot) => void
  /** Holds the token index. */
  store: Store
  /** Overridden by the checks to read a fixture instead of the real tree. */
  home?: string | undefined
}

/**
 * What makes one reading different from another.
 *
 * Compared as a string rather than field by field so that a limit appearing,
 * disappearing or changing its scope counts as a change without this function
 * having to know which fields exist. The window it does *not* include is time:
 * an unchanged file produces an unchanged signature however old it gets, which
 * is correct, because the ageing is the window's to notice.
 */
function signature(snapshot: UsageSnapshot): string {
  return JSON.stringify([
    snapshot.file,
    snapshot.fetchedAtMs,
    snapshot.problem?.kind ?? null,
    snapshot.limits.map((l) => [l.kind, l.group, l.percent, l.severity, l.resetsAtMs, l.scope]),
    snapshot.spend
  ])
}

function sameState(a: UsageFileState | null, b: UsageFileState | null): boolean {
  if (a === null || b === null) return a === b
  return a.size === b.size && a.mtimeMs === b.mtimeMs
}

export function createUsageService({ onChange, store, home }: UsageServiceDeps): UsageService {
  const realFile = claudeConfigFileIn(home ?? claudeHome())
  const index = createUsageIndex({ store, projectsDir: projectsDirIn(home ?? claudeHome()) })

  let file = realFile
  let last: UsageSnapshot = { file, fetchedAtMs: null, limits: [], problem: null, spend: null }
  let lastSignature = ''
  let lastState: UsageFileState | null = null

  let watcher: FSWatcher | null = null
  let poll: NodeJS.Timeout | null = null
  let indexPoll: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null
  let catchUp: NodeJS.Immediate | null = null
  let indexMs = 0

  /**
   * The estimate, aligned with the percentage beside it.
   *
   * The session window is taken from the plan's own `resets_at` rather than
   * "the last five hours", so the dollar figure and the percentage describe the
   * same window - which is the only way a user can read one against the other.
   * Null until the first catch-up finishes: an estimate over a third of the
   * transcripts is a wrong number, not a partial one.
   */
  function spendFor(snapshot: UsageSnapshot): UsageSpend | null {
    if (!index.ready()) return null
    const session = snapshot.limits.find((limit) => limit.group === 'session')
    try {
      return index.spend(session?.resetsAtMs ?? null, indexMs)
    } catch (err) {
      console.warn(`usage spend could not be summed: ${String(err)}`)
      return null
    }
  }

  function refresh(): UsageSnapshot {
    const read = readUsage(file)
    const next: UsageSnapshot = { ...read, spend: spendFor(read) }
    lastState = usageFileState(file)
    last = next
    const nextSignature = signature(next)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      onChange(next)
    }
    return next
  }

  /**
   * Works the index forward one chunk per tick until it has caught up.
   *
   * `setImmediate` rather than a loop: the first pass over 214 MB takes about a
   * second in total, and the window has to keep painting while it happens.
   */
  function scheduleCatchUp(): void {
    if (catchUp !== null) return
    catchUp = setImmediate(() => {
      catchUp = null
      let result
      try {
        result = index.pass()
      } catch (err) {
        console.warn(`usage index pass failed: ${String(err)}`)
        return
      }
      indexMs = result.ms
      if (!result.caughtUp) {
        scheduleCatchUp()
        return
      }
      // Only once the whole index is current: a partial estimate is wrong.
      if (result.rows > 0 || result.forgotten > 0 || last.spend === null) refresh()
    })
  }

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      try {
        refresh()
      } catch (err) {
        // A pass that throws must not take the interval with it: the next write
        // to the file is the next chance to get back in step.
        console.warn(`usage refresh failed: ${String(err)}`)
      }
    }, DEBOUNCE_MS)
  }

  function watchFile(): void {
    watcher?.close()
    watcher = null
    try {
      // The directory rather than the file, so a rewrite that replaces the
      // inode rather than appending to it still reports - the same reason the
      // history watch is on `dirname`. Non-recursive: this is the home
      // directory, and a recursive watch over it would fire on everything.
      watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
        if (name === null || basename(String(name)) === basename(file)) scheduleRefresh()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      // Left to the poll.
    }
  }

  return {
    refresh,
    snapshot: () => last,
    file: () => file,
    index,

    pointAt(next) {
      file = next ?? realFile
      lastState = null
      if (watcher !== null) watchFile()
      return refresh()
    },

    start() {
      if (watcher !== null || poll !== null) return
      watchFile()

      poll = setInterval(() => {
        // Size *and* mtime: the CLI rewrites this file in place, and a
        // refreshed percentage can land on exactly the same byte count.
        const state = usageFileState(file)
        if (sameState(state, lastState)) return
        lastState = state
        scheduleRefresh()
      }, POLL_MS)
      poll.unref()

      // The token index has no watch behind it. `fs.watch` over `projects/`
      // would have to be recursive to see a transcript grow, and a recursive
      // watch there fires on every token a live session writes - which is the
      // one thing the debounce cannot absorb. A ten-second stat sweep over 178
      // files costs less than that watch does when nothing is happening.
      scheduleCatchUp()
      indexPoll = setInterval(scheduleCatchUp, USAGE_INDEX_POLL_MS)
      indexPoll.unref()
    },

    stop() {
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (poll) clearInterval(poll)
      poll = null
      if (indexPoll) clearInterval(indexPoll)
      indexPoll = null
      if (catchUp) clearImmediate(catchUp)
      catchUp = null
      watcher?.close()
      watcher = null
    }
  }
}
