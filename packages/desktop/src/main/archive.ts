import { watch, type FSWatcher } from 'node:fs'
import {
  archiveCursor,
  archiveTranscriptFile,
  archivedBytes,
  evictToCeiling,
  forgetArchiveFiles,
  indexedArchiveFiles,
  readArchiveStats,
  readArchiveTail,
  scanTranscripts,
  type ArchiveStats,
  type Store,
  type TranscriptFile
} from '@helm/core'

/**
 * Keeping the conversations Claude Code is about to delete.
 *
 * Measured 2026-08-08: `history.jsonl` recorded 744 sessions across 35 projects
 * and 68 transcripts survived - 91% of the conversations reaped, with every one
 * of their prompts still on disk. The archive is what closes that gap, and it
 * is **not** opt-in for exactly that reason: a default-off setting would go on
 * losing conversations for as long as it sat off, and by then there is nothing
 * to turn on for.
 *
 * ## This is a second consumer of a walk Helm already does
 *
 * The session index walks `projects/*` on every pass - `scanTranscripts` -
 * because it has to know which sessions can still be resumed. That walk returns
 * exactly what the archive needs and keyed by exactly the right thing: the
 * session id, which is what `history_sessions` joins on. So the history service
 * hands its map straight to `consume()` and this file does no walk of its own
 * on that path.
 *
 * It is deliberately **not** the usage index's walk, which is the other
 * candidate and the wrong one. `scanUsageTranscripts` descends into
 * `<session>/subagents/agent-*.jsonl` on purpose, because those tokens are real
 * spend - and those files are not sessions, have no id to join on, and would
 * arrive here as conversations belonging to nobody.
 *
 * What is *not* shared with the usage index is the read, and that was a
 * measurement rather than an oversight. The two cursors cannot be one: on any
 * database that predates this feature `usage_index` is already at EOF, so a
 * shared cursor would mean the archive could only ever capture what was
 * appended after it shipped - the 21,952 messages already on disk would be
 * unreachable. Two cursors means the first catch-up reads the tree twice, once
 * each, which is about a second of I/O spread over a handful of ticks and
 * happens exactly once. In the steady state - both cursors at EOF, a live
 * session appending 4 KB - it is two 4 KB reads instead of one. The complexity
 * of splitting one read between two parsers at two different offsets buys that
 * 4 KB and is not worth it.
 *
 * ## Everything here is read-only with respect to `~/.claude`
 *
 * Nothing in this file or anything it calls opens a path under that tree for
 * writing. `pnpm transcript-check`'s T-5 hashes the whole fixture tree before
 * and after a full pass and requires the two to be identical, because a rule
 * nothing measures is a rule that lasts until the next refactor.
 */

/**
 * How much a single catch-up pass will read before yielding.
 *
 * The usage index's number, for the same reason and over the same bytes: the
 * first pass reads 311 MB, and doing that in one turn would freeze the window
 * at startup.
 */
const CHUNK_BYTES = 16 * 1024 * 1024

/**
 * How long a burst of transcript writes is allowed to settle.
 *
 * A live session appends to its transcript continuously, so this is a trailing
 * debounce with a ceiling on how long it may be pushed out - a pure trailing
 * debounce under a steady write stream never fires at all.
 */
const DEBOUNCE_MS = 1500
const MAX_DEBOUNCE_MS = 10_000

/**
 * The floor on how often the watch may drive a pass.
 *
 * The pass it drives is the session index's, which is deliberately *not* run on
 * every tick - `SWEEP_EVERY` in `history.ts` holds it to once a minute because
 * it costs tens of milliseconds of SQLite. Fifteen seconds is four times more
 * often than that and two orders of magnitude inside the criterion this feature
 * has to meet ("within minutes of session activity"), which is the trade: a
 * conversation that ends and is reaped is unrecoverable, and a millisecond of
 * SQLite is not.
 */
const MIN_PASS_MS = 15_000

export interface ArchivePass {
  /** Transcripts whose tails were read this pass. */
  files: number
  /** Messages added. Duplicates from a fork are not counted. */
  messages: number
  /** Bytes actually read off disk - the number that says a pass was incremental. */
  bytesRead: number
  /** Cursors dropped for transcripts Claude Code has reaped. */
  forgotten: number
  /** Sessions the ceiling dropped, oldest first. */
  evicted: string[]
  /** Stored bytes after the pass. At or under the ceiling unless nothing was left. */
  storedBytes: number
  /** True when everything on disk is now archived. */
  caughtUp: boolean
  ms: number
}

export interface ArchiveServiceDeps {
  store: Store
  /** `~/.claude/projects`, or wherever `CLAUDE_CONFIG_DIR` puts it. */
  projectsDir: string
  /** Read through a function: the ceiling can change while the app is running. */
  maxBytes: () => number
  /** Called after any pass that changed what the archive holds. */
  onChange: (stats: ArchiveStats) => void
}

export interface ArchiveService {
  /**
   * One pass over a walk somebody else did. The session index's `refresh` calls
   * this with the map it has just built.
   */
  consume: (transcripts: Map<string, TranscriptFile>) => ArchivePass
  /** One pass over a walk of this service's own. The start-up sweep. */
  sweep: () => ArchivePass
  /** What the archive holds right now. */
  stats: () => ArchiveStats
  /**
   * Begins watching `projects/` for transcripts that have grown.
   *
   * `wake` is what the watch calls, and it is the session index's refresh
   * rather than this service's `sweep`: one walk, two consumers. Safe to call
   * twice.
   */
  start: (wake: () => void) => void
  stop: () => void
  /** Whether the first catch-up has finished. */
  ready: () => boolean
}

export function createArchiveService({
  store,
  projectsDir,
  maxBytes,
  onChange
}: ArchiveServiceDeps): ArchiveService {
  let caughtUp = false
  let watcher: FSWatcher | null = null
  let debounce: NodeJS.Timeout | null = null
  let debounceSince = 0
  let lastPassAt = 0
  let lastSignature = ''
  let wake: (() => void) | null = null
  let catchUp: NodeJS.Immediate | null = null

  /**
   * Works the backlog forward one chunk per tick until it is gone.
   *
   * The usage index's shape and for the same reason: a first index over this
   * machine's 311 MB of transcripts is twenty chunks, and waiting for the
   * session index's own once-a-minute sweep to deliver them would mean twenty
   * minutes before the archive held anything. `setImmediate` rather than a loop
   * so the window keeps painting through it.
   *
   * It calls `wake` rather than `sweep`, so the catch-up rides the same walk
   * every other pass does. And it deliberately ignores `MIN_PASS_MS`: that
   * floor is there to stop a live session's writes driving passes, and a
   * backlog is not a live session - it happens once, on the first launch after
   * this shipped, and then never again.
   */
  function scheduleCatchUp(): void {
    if (catchUp !== null || wake === null || caughtUp) return
    const run = wake
    catchUp = setImmediate(() => {
      catchUp = null
      try {
        run()
      } catch (err) {
        console.warn(`transcript archive catch-up failed: ${String(err)}`)
      }
    })
  }

  function pass(transcripts: Map<string, TranscriptFile>): ArchivePass {
    const started = performance.now()
    lastPassAt = Date.now()

    const known = indexedArchiveFiles(store)
    const present = new Set([...transcripts.values()].map((t) => t.file))
    // A cursor whose file is gone: Claude Code reaped the transcript. The
    // cursor goes so the table does not grow for ever with paths that cannot be
    // read. The conversation stays, which is the entire point of this feature.
    const gone = [...known.keys()].filter((file) => !present.has(file))
    const forgotten = forgetArchiveFiles(store, gone)

    // Newest first, like the usage index and for a sharper reason here: if the
    // ceiling is going to bite on this pass, the conversations that get in
    // before it should be the recent ones.
    const ordered = [...transcripts.values()].sort((a, b) => b.modifiedMs - a.modifiedMs)

    let files = 0
    let messages = 0
    let bytesRead = 0
    let budget = CHUNK_BYTES
    let remaining = false

    for (const transcript of ordered) {
      const cursor = known.get(transcript.file) ?? archiveCursor(store, transcript.file)
      // Equal means nothing appended. Smaller means the file was replaced,
      // which `readArchiveTail` reports as a reset and re-reads from zero.
      if (transcript.bytes === cursor) continue
      if (budget <= 0) {
        remaining = true
        break
      }

      const tail = readArchiveTail(transcript.file, cursor, transcript.sessionId)
      if (tail.error !== undefined) {
        // A transcript that cannot be read right now - being written, locked,
        // removed between the walk and the read - is not a reason to stop.
        continue
      }
      const written = archiveTranscriptFile(store, {
        file: transcript.file,
        sessionId: transcript.sessionId,
        tail
      })
      messages += written.messages
      bytesRead += tail.read
      files++
      budget -= tail.read
    }

    // After the pass, not during it: a ceiling enforced per file would evict a
    // conversation to make room for one that has not finished arriving.
    const ceiling = maxBytes()
    const eviction =
      archivedBytes(store) > ceiling
        ? evictToCeiling(store, ceiling)
        : { sessions: [], messages: 0, bytes: 0, storedBytes: archivedBytes(store) }

    caughtUp = !remaining
    const result: ArchivePass = {
      files,
      messages,
      bytesRead,
      forgotten,
      evicted: eviction.sessions,
      storedBytes: eviction.storedBytes,
      caughtUp,
      ms: performance.now() - started
    }

    const stats = readArchiveStats(store, ceiling)
    const signature = JSON.stringify([
      stats.sessions,
      stats.evictedSessions,
      stats.messages,
      stats.storedBytes,
      stats.maxBytes
    ])
    if (signature !== lastSignature) {
      lastSignature = signature
      onChange(stats)
    }
    // More on disk than this chunk's budget covered. Come back on the next tick
    // rather than waiting for whatever would have driven the pass after this.
    if (!caughtUp) scheduleCatchUp()
    return result
  }

  function scheduleWake(wake: () => void): void {
    const now = Date.now()
    if (debounce === null) debounceSince = now
    else clearTimeout(debounce)

    // Trailing, but never pushed out past `MAX_DEBOUNCE_MS`: a session writing
    // steadily would otherwise reset the timer for ever and the archive would
    // hear about the conversation only once it stopped.
    const waited = now - debounceSince
    const settle = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DEBOUNCE_MS - waited))
    // And never closer to the last pass than the floor. Deferred rather than
    // dropped, which is the difference between a rate limit and a hole: an
    // append arriving two seconds after a pass has to be picked up fifteen
    // seconds later, not left until whenever the next append happens to be.
    const floor = Math.max(0, MIN_PASS_MS - (now - lastPassAt))

    debounce = setTimeout(
      () => {
        debounce = null
        try {
          wake()
        } catch (err) {
          // A pass that throws must not take the watch with it: the next append
          // is the next chance to get back in step.
          console.warn(`transcript archive pass failed: ${String(err)}`)
        }
      },
      Math.max(settle, floor)
    )
  }

  return {
    consume: pass,
    sweep: () => pass(scanTranscripts(projectsDir)),
    stats: () => readArchiveStats(store, maxBytes()),
    ready: () => caughtUp,

    start(onWake) {
      if (watcher !== null) return
      wake = onWake
      // The first pass has already run by now - it rode the session index's
      // start-up refresh - so this is only about the rest of the backlog.
      scheduleCatchUp()
      try {
        /*
         * Recursive, and this is the one place in Helm that watches `projects/`
         * that way.
         *
         * `usage.ts` says a recursive watch here "fires on every token a live
         * session writes - which is the one thing the debounce cannot absorb",
         * and chose a ten-second stat sweep instead. That is right for the
         * usage index, whose figures are already being polled on a timer and
         * whose worst case is a percentage a few seconds old. It is not right
         * here: the event this feature exists for is a conversation *ending*,
         * and after it ends there is a window before Claude Code reaps it and
         * nothing at all afterwards.
         *
         * The objection is answered rather than ignored. `scheduleWake` is a
         * trailing debounce with a hard ceiling, so a steady write stream
         * coalesces into one wake rather than starving the timer, and
         * `MIN_PASS_MS` puts a floor under how often a pass can run whatever
         * the watch does. The worst case is one pass every fifteen seconds
         * while somebody is working, which is four times the sweep the session
         * index already runs.
         */
        watcher = watch(projectsDir, { persistent: false, recursive: true }, (_event, name) => {
          if (name !== null && !String(name).endsWith('.jsonl')) return
          scheduleWake(onWake)
        })
        watcher.on('error', () => {
          // Documented as not available everywhere, and recursive watching is
          // the half most likely to be missing. The session index's own poll
          // still drives a pass every minute, so this degrades to "within a
          // minute" rather than to nothing.
          watcher?.close()
          watcher = null
        })
      } catch {
        watcher = null
      }
    },

    stop() {
      if (debounce) clearTimeout(debounce)
      debounce = null
      if (catchUp) clearImmediate(catchUp)
      catchUp = null
      wake = null
      watcher?.close()
      watcher = null
    }
  }
}
