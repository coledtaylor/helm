import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude Code's own record of what has been asked of it.
 *
 * Two files, and they do not agree with each other - which is the whole reason
 * this module exists:
 *
 *   `history.jsonl`      every prompt ever submitted, on every project, append
 *                        only, forever. 3,470 lines / 799 sessions / 37
 *                        projects on the machine this was written against.
 *   `projects/<dir>/`    the transcripts `--resume` actually reads. Reaped on
 *                        Claude Code's schedule: 105 of those 799 survive.
 *
 * So the prompt history is the list, and the transcript directory is the
 * question of what can still be opened. Helm reads both and writes to neither.
 */

/** `~/.claude`, or wherever the CLI has been pointed instead. */
export function claudeHome(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.trim() !== '' ? override : join(homedir(), '.claude')
}

export function historyFileIn(home: string): string {
  return join(home, 'history.jsonl')
}

export function projectsDirIn(home: string): string {
  return join(home, 'projects')
}

/** One line of `history.jsonl`, after the fields Helm uses have been checked. */
export interface HistoryLine {
  sessionId: string
  project: string
  timestamp: number
  display: string
}

export interface HistoryTail {
  lines: HistoryLine[]
  /**
   * Byte offset the next pass should resume from. Always the end of the last
   * complete line, so a read that caught the CLI mid-append does not consume
   * half a record and then parse the other half as a whole one.
   */
  bytes: number
  /**
   * The file is not the one the cursor belonged to - it shrank, or it is gone.
   * The caller has to discard what it had rather than append to it.
   */
  reset: boolean
  /** Lines that were not valid JSON, or lacked a field. Skipped, not fatal. */
  skipped: number
  /** Set when the file could not be read at all. */
  error?: string
}

/** JSON with the four fields Helm needs, and nothing assumed about the rest. */
function parseLine(raw: string): HistoryLine | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>

  const sessionId = record['sessionId']
  const project = record['project']
  const timestamp = record['timestamp']
  const display = record['display']

  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (typeof project !== 'string' || project === '') return null
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return null

  return {
    sessionId,
    project,
    timestamp,
    // A prompt submitted as an empty line is still a submission; only a
    // non-string is a record Helm cannot use.
    display: typeof display === 'string' ? display : ''
  }
}

/**
 * Reads the part of `history.jsonl` that has appeared since `fromBytes`.
 *
 * Incremental because the file only ever grows: re-reading 875 KB to learn
 * about one new prompt is affordable today and stops being so, and the cursor
 * costs one integer. The two things that would break a naive cursor are handled
 * explicitly - a file smaller than the cursor is a different file (rotated,
 * cleared, or a different `CLAUDE_CONFIG_DIR`) and forces a full reindex, and a
 * trailing fragment with no newline is left unconsumed for the next pass.
 *
 * Reading from a byte offset cannot split a UTF-8 sequence here, because every
 * offset this returns is the byte after a `\n`.
 */
export function readHistoryTail(file: string, fromBytes: number): HistoryTail {
  let size: number
  try {
    size = statSync(file).size
  } catch (err) {
    return {
      lines: [],
      bytes: 0,
      reset: true,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const reset = size < fromBytes
  const start = reset ? 0 : fromBytes
  if (size === start) return { lines: [], bytes: size, reset, skipped: 0 }

  const length = size - start
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  const fd = openSync(file, 'r')
  try {
    // `readSync` is allowed to return short. Loop rather than assume.
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
  } catch (err) {
    return {
      lines: [],
      bytes: fromBytes,
      reset: false,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    closeSync(fd)
  }

  const chunk = buffer.subarray(0, read)
  // Everything after the final newline is a record still being written. Its
  // byte length - not its character length - is what the cursor has to be held
  // back by.
  const lastBreak = chunk.lastIndexOf(0x0a)
  const complete = lastBreak < 0 ? Buffer.alloc(0) : chunk.subarray(0, lastBreak + 1)

  const lines: HistoryLine[] = []
  let skipped = 0
  for (const raw of complete.toString('utf8').split('\n')) {
    if (raw.trim() === '') continue
    const parsed = parseLine(raw)
    if (parsed === null) skipped++
    else lines.push(parsed)
  }

  return { lines, bytes: start + complete.length, reset, skipped }
}

/** A transcript file that is still on disk. */
export interface TranscriptFile {
  sessionId: string
  file: string
  bytes: number
  modifiedMs: number
}

/**
 * Session ids that still have a transcript, keyed by id.
 *
 * Found by walking `projects/*` rather than by deriving a path from the
 * project a session recorded, because the two do not always agree. The
 * directory name is built from whatever casing the CLI was invoked with, and
 * `history.jsonl` records its own: two transcripts on this machine live under
 * `...-repos-atlas-reporting` for sessions whose recorded project is
 * `...\repos\atlas-reporting`. A derived path misses them and reports a
 * resumable conversation as reaped. The id is the join key that always holds.
 *
 * Only the top level of each project directory is read. Below it are
 * `<sessionId>/subagents/agent-*.jsonl` and `tool-results/`, whose names are
 * not session ids - hence the UUID shape test rather than a bare `.jsonl`
 * check.
 */
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

export function scanTranscripts(projectsDir: string): Map<string, TranscriptFile> {
  const found = new Map<string, TranscriptFile>()

  let dirs: string[]
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No projects directory means no transcripts, which is a true answer and
    // not an error: every session is then history-only.
    return found
  }

  for (const dir of dirs) {
    const full = join(projectsDir, dir)
    let names: string[]
    try {
      names = readdirSync(full)
    } catch {
      continue
    }
    for (const name of names) {
      if (!TRANSCRIPT_NAME.test(name)) continue
      const file = join(full, name)
      let stats
      try {
        stats = statSync(file)
      } catch {
        continue
      }
      if (!stats.isFile()) continue
      const sessionId = name.slice(0, -'.jsonl'.length).toLowerCase()
      // A session id can appear under two project directories when the same
      // folder was opened with different casing. Keep the larger file: it is
      // the one with the conversation in it.
      const existing = found.get(sessionId)
      if (existing && existing.bytes >= stats.size) continue
      found.set(sessionId, {
        sessionId,
        file,
        bytes: stats.size,
        modifiedMs: stats.mtimeMs
      })
    }
  }

  return found
}

/** Whether a recorded working directory is still a directory. */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
