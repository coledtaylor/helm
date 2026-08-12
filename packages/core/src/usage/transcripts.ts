import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readTail } from '../discovery/tail'

/**
 * Token usage, out of the transcripts Claude Code writes as it works.
 *
 * Every `assistant` row carries a `usage` object - 22,180 of 22,180 on the
 * machine this was written against - so the tokens are all there. What is not
 * there is a price: `spend.enabled` is false on a subscription plan, so a
 * dollar figure has to be Helm's own arithmetic over these rows against a price
 * table Helm carries. That is why everything downstream of this file is
 * labelled an estimate.
 *
 * The cost of doing it naively is measured: 178 files, 214 MB, 22,180 rows,
 * 1,018 ms for a full parse. Far too slow to sit behind a status bar, hence the
 * same treatment the session index gave `history.jsonl` - a per-file byte
 * cursor, tail reads,
 * and the aggregate in SQLite.
 */

/** One assistant message's tokens, priced separately by class. */
export interface UsageRow {
  /**
   * The transcript row's own uuid, and the dedup key. A forked conversation
   * copies its parent's history into a new file, so the same message can appear
   * twice on disk; 0 of 22,180 uuids collided otherwise, so this is safe as a
   * primary key.
   */
  uuid: string
  /** Epoch ms from the row's ISO `timestamp`. */
  at: number
  model: string
  input: number
  output: number
  /**
   * Cache writes, split by TTL, because they are priced differently: a
   * five-minute write is 1.25x base input and a one-hour write is 2x.
   */
  cacheWrite5m: number
  cacheWrite1h: number
  /** The class that dominates the volume - 390M in one day here - at 0.1x. */
  cacheRead: number
}

export interface UsageTail {
  rows: UsageRow[]
  bytes: number
  reset: boolean
  /** Lines that were not usable. Skipped, not fatal. */
  skipped: number
  error?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * One transcript line, if it is an assistant message with usage on it.
 *
 * Everything else in the file - `user`, `system`, `attachment`,
 * `file-history-snapshot`, `queue-operation` and a dozen more - is skipped
 * silently rather than counted as a failure, because it is not a failure: those
 * rows have no tokens to attribute.
 */
export function parseUsageLine(raw: string): UsageRow | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value)) return null
  if (value['type'] !== 'assistant') return null

  const uuid = value['uuid']
  if (typeof uuid !== 'string' || uuid === '') return null

  const message = value['message']
  if (!isObject(message)) return null
  const usage = message['usage']
  if (!isObject(usage)) return null

  const at = Date.parse(String(value['timestamp'] ?? ''))
  if (!Number.isFinite(at)) return null

  const model = message['model']
  if (typeof model !== 'string' || model === '') return null

  // `cache_creation` splits the write total by TTL. When it is absent the whole
  // total is a five-minute write, which is the default TTL - the conservative
  // reading, since it is the cheaper of the two.
  const creation = usage['cache_creation']
  const writeTotal = count(usage['cache_creation_input_tokens'])
  let write1h = 0
  let write5m = writeTotal
  if (isObject(creation)) {
    write1h = count(creation['ephemeral_1h_input_tokens'])
    write5m = count(creation['ephemeral_5m_input_tokens'])
    // Trust the total over the parts if they disagree: the total is the field
    // the API documents and the parts are a breakdown of it.
    const parts = write1h + write5m
    if (parts !== writeTotal) {
      if (parts === 0) write5m = writeTotal
      else if (writeTotal > parts) write5m += writeTotal - parts
    }
  }

  return {
    uuid,
    at,
    model,
    input: count(usage['input_tokens']),
    output: count(usage['output_tokens']),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: count(usage['cache_read_input_tokens'])
  }
}

/** The rows appended to one transcript since `fromBytes`. */
export function readUsageTail(file: string, fromBytes: number): UsageTail {
  const tail = readTail(file, fromBytes)
  if (tail.error !== undefined) {
    return { rows: [], bytes: tail.bytes, reset: tail.reset, skipped: 0, error: tail.error }
  }

  const rows: UsageRow[] = []
  let skipped = 0
  for (const raw of tail.text.split('\n')) {
    if (raw === '') continue
    // A cheap gate before the parse: most lines in a transcript are not
    // assistant messages, and `JSON.parse` on a 200 KB attachment row to
    // discover that is the difference between a fast pass and a slow one.
    if (!raw.includes('"assistant"')) continue
    const row = parseUsageLine(raw)
    if (row === null) skipped++
    else rows.push(row)
  }

  return { rows, bytes: tail.bytes, reset: tail.reset, skipped }
}

export interface TranscriptStat {
  file: string
  bytes: number
  mtimeMs: number
}

/**
 * Every transcript under `projects/`, at any depth.
 *
 * Deeper than the session index looks, and deliberately: a subagent writes to
 * `<sessionId>/subagents/agent-*.jsonl`, and those rows are real usage against
 * the same plan - 583 M tokens of the 4.86 B on this machine, 12%. The session
 * index ignores them because their names are not session ids; the usage index
 * must not, because the plan does not ignore them.
 */
export function scanUsageTranscripts(projectsDir: string): TranscriptStat[] {
  const found: TranscriptStat[] = []

  const walk = (dir: string, depth: number): void => {
    // `projects/<project>/<session>/subagents/` is three below the root; the
    // bound is here so a stray deep tree cannot turn a pass into a full walk.
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink()) walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      try {
        const stats = statSync(path)
        found.push({ file: path, bytes: stats.size, mtimeMs: stats.mtimeMs })
      } catch {
        continue
      }
    }
  }

  walk(projectsDir, 0)
  // Most recently written first: on a first index this puts the transcripts a
  // 7-day window actually needs in front of the 26-day tail.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return found
}
