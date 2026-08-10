import {
  forgetUsageFiles,
  indexUsageFile,
  indexedUsageFiles,
  readUsageSpend,
  readUsageTail,
  scanUsageTranscripts,
  usageCursor,
  type Store,
  type UsageSpend
} from '@helm/core'

/**
 * Keeping the token index level with 178 transcripts Helm does not own.
 *
 * The same shape as the session index, applied to many files instead of one:
 * a byte cursor per transcript, tail reads because a transcript is append-only
 * while its session runs, and the aggregate in SQLite. What it buys is measured
 * - a full parse of every transcript is 1,018 ms over 214 MB, and the status
 * bar cannot spend that on a repaint, or on a keystroke, or at all.
 *
 * Two things here that the single-file indexes do not need:
 *
 *   The first pass is **chunked**. It reads 214 MB and writes 22,180 rows, and
 *   doing that in one turn would freeze the window for a second at startup. A
 *   pass stops after a byte budget and schedules the next one, so the main
 *   process stays responsive while the index catches up behind the app.
 *
 *   Transcripts are **reaped** on Claude Code's schedule, so the file list is
 *   re-read rather than assumed. A cursor for a file that has gone is dropped;
 *   the rows it produced stay, because the tokens were still spent.
 */

/**
 * How much a single catch-up pass will read before yielding.
 *
 * Sixteen megabytes is roughly 70 ms of parsing at the rate measured here -
 * long enough that the first index finishes in a handful of ticks, short enough
 * that no single one of them is a visible stall.
 */
const CHUNK_BYTES = 16 * 1024 * 1024

/** How often the index looks for transcripts that have grown. */
const POLL_MS = 10_000

export interface UsageIndexPass {
  /** Files whose tails were read this pass. */
  files: number
  /** Rows added to the index. Duplicates from a fork are not counted. */
  rows: number
  /** Cursors dropped for transcripts Claude Code has reaped. */
  forgotten: number
  /** True when everything on disk is now indexed. */
  caughtUp: boolean
  ms: number
}

export interface UsageIndexDeps {
  store: Store
  projectsDir: string
}

export interface UsageIndex {
  /** One chunk of work. Call again while `caughtUp` is false. */
  pass: () => UsageIndexPass
  /** Session / today / 7-day totals from whatever is indexed right now. */
  spend: (sessionResetsAtMs: number | null, indexMs: number) => UsageSpend
  /** Whether the first catch-up has finished. */
  ready: () => boolean
  /** Milliseconds the last pass took. */
  lastPassMs: () => number
}

/**
 * Local midnight, in the main process's own timezone.
 *
 * Computed rather than taken as `now - 24h`, because "today" means the calendar
 * day the user is in - and computed in the main process rather than the window
 * because that is where the index lives, and the two are the same machine.
 */
export function localMidnight(nowMs: number): number {
  const date = new Date(nowMs)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function createUsageIndex({ store, projectsDir }: UsageIndexDeps): UsageIndex {
  let caughtUp = false
  let lastPassMs = 0

  function pass(): UsageIndexPass {
    const started = performance.now()
    const onDisk = scanUsageTranscripts(projectsDir)
    const known = indexedUsageFiles(store)

    // A cursor whose file is gone: Claude Code reaped the transcript. Drop the
    // cursor so the table does not grow forever with paths that cannot be read;
    // the rows stay, because the tokens were spent whether or not the record of
    // them survives. This is also the argument for the transcript archive
    // backlog - without it, usage history is a 26-day window.
    const present = new Set(onDisk.map((t) => t.file))
    const gone = [...known.keys()].filter((file) => !present.has(file))
    const forgotten = forgetUsageFiles(store, gone)

    let files = 0
    let rows = 0
    let budget = CHUNK_BYTES
    let remaining = false

    for (const transcript of onDisk) {
      const cursor = known.get(transcript.file) ?? usageCursor(store, transcript.file)
      // Equal means nothing appended. Smaller means the file was replaced,
      // which `readUsageTail` reports as a reset and re-reads from zero.
      if (transcript.bytes === cursor) continue
      if (budget <= 0) {
        remaining = true
        break
      }

      const tail = readUsageTail(transcript.file, cursor)
      if (tail.error !== undefined) {
        // A transcript that cannot be read right now - being written, locked,
        // removed between the scan and the read - is not a reason to stop.
        continue
      }
      rows += indexUsageFile(store, { file: transcript.file, tail })
      files++
      budget -= Math.max(0, transcript.bytes - cursor)
    }

    caughtUp = !remaining
    lastPassMs = performance.now() - started
    return { files, rows, forgotten, caughtUp, ms: lastPassMs }
  }

  return {
    pass,
    ready: () => caughtUp,
    lastPassMs: () => lastPassMs,
    spend: (sessionResetsAtMs, indexMs) => {
      const nowMs = Date.now()
      return readUsageSpend(store, {
        nowMs,
        sessionResetsAtMs,
        todayStartMs: localMidnight(nowMs),
        indexMs
      })
    }
  }
}

export const USAGE_INDEX_POLL_MS = POLL_MS
