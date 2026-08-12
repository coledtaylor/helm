import { watch, statSync, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import {
  claudeHome,
  directoryExists,
  historyCursor,
  historyFileIn,
  indexHistory,
  projectsDirIn,
  readHistoryTail,
  scanTranscripts,
  type HistorySummary,
  type Store
} from '@helm/core'

/**
 * Keeping the session index level with a file Helm does not own.
 *
 * `history.jsonl` is written by every `claude` on the machine, including the
 * ones started from a terminal while Helm is open - so the launcher is only
 * honest if it notices those. Two mechanisms, because they fail differently:
 *
 *   `fs.watch` on the containing directory fires within milliseconds, and is
 *   documented as not available everywhere. The directory rather than the file
 *   so that a rotation - the file being replaced rather than appended to -
 *   still reports, which a watch on the inode does not.
 *
 *   A stat poll every few seconds costs one syscall and covers the case where
 *   the watch never fires at all.
 *
 * Both funnel into the same debounced refresh, which is incremental: only the
 * bytes appended since the last pass are read.
 */

/** Long enough for a burst of appends to settle, short enough to feel immediate. */
const DEBOUNCE_MS = 150

/**
 * The backstop, not the mechanism. Four seconds keeps the criterion ("within
 * seconds") true even on a filesystem where `fs.watch` is silent. All it does
 * is stat the file, so the cost of it being redundant is one syscall.
 */
const POLL_MS = 4000

/**
 * How often a pass runs with nothing to read. A transcript being reaped and a
 * project directory being deleted change what can be resumed without touching
 * the history file, so the index has to look occasionally on its own - but the
 * pass costs tens of milliseconds of SQLite, which is not something to spend
 * every four seconds for a change that happens weekly.
 */
const SWEEP_EVERY = 15

export interface HistoryService {
  /** Reads whatever has appeared since the last pass and returns the totals. */
  refresh: () => HistorySummary
  /** Last known totals, without touching the disk. */
  summary: () => HistorySummary
  /** Begins watching. Safe to call twice. */
  start: () => void
  stop: () => void
  /** The file being indexed; the resume path and the UI both name it. */
  file: string
}

export interface HistoryServiceDeps {
  store: Store
  /** Called after any pass that changed the totals. */
  onChange: (summary: HistorySummary) => void
  /** Overridden by `--history-check` to index a fixture instead of the real tree. */
  home?: string | undefined
}

export function createHistoryService({
  store,
  onChange,
  home = claudeHome()
}: HistoryServiceDeps): HistoryService {
  const file = historyFileIn(home)
  const projectsDir = projectsDirIn(home)

  let last: HistorySummary = {
    sessions: 0,
    prompts: 0,
    projects: 0,
    resumable: 0,
    latestAt: null,
    historyFile: file,
    indexedBytes: historyCursor(store, file)
  }
  let watcher: FSWatcher | null = null
  let poll: NodeJS.Timeout | null = null
  let debounce: NodeJS.Timeout | null = null
  let lastSize = -1

  function refresh(): HistorySummary {
    const tail = readHistoryTail(file, historyCursor(store, file))
    const transcripts = scanTranscripts(projectsDir)
    const next = indexHistory(store, { file, tail, transcripts, directoryExists })
    const changed =
      next.sessions !== last.sessions ||
      next.prompts !== last.prompts ||
      next.resumable !== last.resumable ||
      next.indexedBytes !== last.indexedBytes ||
      next.error !== last.error
    last = next
    if (changed) onChange(next)
    return next
  }

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = null
      try {
        refresh()
      } catch (err) {
        // A pass that throws must not take the interval with it: the next
        // append is the next chance to get back in step.
        console.warn(`history index refresh failed: ${String(err)}`)
      }
    }, DEBOUNCE_MS)
  }

  return {
    file,
    refresh,
    summary: () => last,

    start() {
      if (watcher !== null || poll !== null) return

      try {
        // Non-recursive: the directory holds the whole `.claude` tree, and a
        // recursive watch over `projects/` would fire on every token a live
        // session writes to its transcript.
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

      let ticks = 0
      poll = setInterval(() => {
        ticks++
        // Size, not mtime: an append always changes it, and a stat that reports
        // no change costs nothing further. A file that cannot be stat'd reads
        // as -1, which is a change the next pass will report as an error.
        let size: number
        try {
          size = statSync(file).size
        } catch {
          size = -1
        }
        if (size !== lastSize) {
          lastSize = size
          scheduleRefresh()
          return
        }
        if (ticks % SWEEP_EVERY !== 0) return
        try {
          refresh()
        } catch {
          // As above: a failed pass is not a reason to stop looking.
        }
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
