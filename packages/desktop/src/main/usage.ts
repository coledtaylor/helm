import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  claudeConfigFileIn,
  claudeHome,
  readUsage,
  usageFileState,
  type UsageFileState,
  type UsageSnapshot
} from '@helm/core'

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
  start: () => void
  stop: () => void
}

export interface UsageServiceDeps {
  /** Called after any pass whose reading differs from the one before it. */
  onChange: (snapshot: UsageSnapshot) => void
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

export function createUsageService({ onChange, home }: UsageServiceDeps): UsageService {
  const realFile = claudeConfigFileIn(home ?? claudeHome())

  let file = realFile
  let last: UsageSnapshot = { file, fetchedAtMs: null, limits: [], problem: null, spend: null }
  let lastSignature = ''
  let lastState: UsageFileState | null = null

  let watcher: FSWatcher | null = null
  let poll: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null

  function refresh(): UsageSnapshot {
    const next = readUsage(file)
    lastState = usageFileState(file)
    last = next
    const nextSignature = signature(next)
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature
      onChange(next)
    }
    return next
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
    },

    stop() {
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (poll) clearInterval(poll)
      poll = null
      watcher?.close()
      watcher = null
    }
  }
}
