import { costOfTokens, priceFor, PRICE_TABLE_DATE } from '../usage/prices'
import type { UsageRow, UsageTail } from '../usage/transcripts'
import type { UsageSpend, UsageTokens, UsageWindowCost } from '../usage/shape'
import type { Store } from './db'

/**
 * The usage index: token counts from every transcript under
 * `~/.claude/projects`, mirrored into SQLite so a dollar estimate is a SUM over
 * an indexed range rather than a 1,018 ms parse of 214 MB.
 *
 * Written with the driver rather than through Drizzle for the same reason
 * `history.ts` is: the insert is an `INSERT ... ON CONFLICT DO NOTHING` over a
 * batch and the read is a grouped SUM over a range, neither of which the query
 * builder expresses, and splitting the work so half went through it would buy
 * nothing and hide where the cost is.
 */

/** Bytes of `file` already consumed, or 0 if it has never been indexed. */
export function usageCursor(store: Store, file: string): number {
  const row = store.raw
    .prepare('SELECT bytes FROM usage_index WHERE file = ?')
    .get(file) as { bytes: number } | undefined
  return row?.bytes ?? 0
}

export interface UsageIndexInput {
  file: string
  tail: UsageTail
}

/**
 * Applies one file's tail.
 *
 * `ON CONFLICT DO NOTHING` on the uuid is what makes this idempotent, and it is
 * doing real work rather than guarding a case that cannot happen: a fork copies
 * its parent's history into a new file, so the same message genuinely is on
 * disk twice, and a reset re-offers every row the file has ever had. Counting
 * either twice would inflate the estimate silently.
 */
export function indexUsageFile(store: Store, { file, tail }: UsageIndexInput): number {
  let inserted = 0

  const apply = store.raw.transaction(() => {
    if (tail.reset) {
      // The file is not the one the cursor belonged to. Its rows are still
      // valid where they overlap - the uuids will simply conflict - so nothing
      // is deleted; the cursor going back to zero re-offers them all.
      store.raw.prepare('DELETE FROM usage_index WHERE file = ?').run(file)
    }

    if (tail.rows.length > 0) {
      const insert = store.raw.prepare(
        `INSERT INTO usage_messages
           (uuid, at, model, input_tokens, output_tokens,
            cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO NOTHING`
      )
      for (const row of tail.rows) {
        const result = insert.run(
          row.uuid,
          row.at,
          row.model,
          row.input,
          row.output,
          row.cacheWrite5m,
          row.cacheWrite1h,
          row.cacheRead
        )
        inserted += result.changes
      }
    }

    store.raw
      .prepare(
        `INSERT INTO usage_index (file, bytes, rows, indexed_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(file) DO UPDATE SET
           bytes = excluded.bytes,
           rows = usage_index.rows + excluded.rows,
           indexed_at = excluded.indexed_at`
      )
      .run(file, tail.bytes, tail.rows.length)
  })
  apply()

  return inserted
}

/** Forgets a transcript Claude Code has reaped. Its messages are kept. */
export function forgetUsageFiles(store: Store, files: readonly string[]): number {
  if (files.length === 0) return 0
  const drop = store.raw.prepare('DELETE FROM usage_index WHERE file = ?')
  let removed = 0
  const apply = store.raw.transaction(() => {
    for (const file of files) removed += drop.run(file).changes
  })
  apply()
  return removed
}

/** Every transcript path the index has a cursor for. */
export function indexedUsageFiles(store: Store): Map<string, number> {
  const rows = store.raw.prepare('SELECT file, bytes FROM usage_index').all() as Array<{
    file: string
    bytes: number
  }>
  return new Map(rows.map((row) => [row.file, row.bytes]))
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface ModelRow {
  model: string
  n: number
  input: number
  output: number
  write5m: number
  write1h: number
  read: number
}

const EMPTY_TOKENS: UsageTokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }

/**
 * One window's cost, summed per model and priced per model.
 *
 * Per model rather than in aggregate because the rates differ by a factor of
 * ten across the models a single day's transcripts contain, and because a model
 * with no entry in the price table has to be reported rather than folded into
 * the total at somebody else's rate.
 */
function windowCost(
  store: Store,
  fromMs: number,
  toMs: number,
  unpriced: Set<string>
): UsageWindowCost {
  const rows = store.raw
    .prepare(
      `SELECT model,
              COUNT(*)                        AS n,
              SUM(input_tokens)               AS input,
              SUM(output_tokens)              AS output,
              SUM(cache_write_5m_tokens)      AS write5m,
              SUM(cache_write_1h_tokens)      AS write1h,
              SUM(cache_read_tokens)          AS read
       FROM usage_messages
       WHERE at >= ? AND at <= ?
       GROUP BY model`
    )
    .all(fromMs, toMs) as ModelRow[]

  const tokens: UsageTokens = { ...EMPTY_TOKENS }
  let dollars = 0
  let messages = 0

  for (const row of rows) {
    tokens.input += row.input
    tokens.output += row.output
    tokens.cacheWrite += row.write5m + row.write1h
    tokens.cacheRead += row.read
    messages += row.n

    // Priced at the midpoint of the window: within a window no rate changes,
    // and a promotional rate that ends inside one is a fraction of a cent.
    const rate = priceFor(row.model, Math.round((fromMs + toMs) / 2))
    if (rate === null) {
      // Only worth reporting if it actually cost something.
      if (row.input + row.output + row.write5m + row.write1h + row.read > 0) {
        unpriced.add(row.model)
      }
      continue
    }
    dollars += costOfTokens(
      {
        input: row.input,
        output: row.output,
        cacheWrite5m: row.write5m,
        cacheWrite1h: row.write1h,
        cacheRead: row.read
      },
      rate
    )
  }

  return { tokens, dollars, messages }
}

export interface UsageSpendQuery {
  nowMs: number
  /**
   * When the plan's 5-hour window resets, from `cachedUsageUtilization`. The
   * session total is then the same window the session *percentage* describes,
   * which is the only way the two figures can be read side by side. Null falls
   * back to the last five hours.
   */
  sessionResetsAtMs: number | null
  /** How long the session window is. Five hours, per the plan's own limits. */
  sessionWindowMs?: number
  /** Local midnight, computed by the caller from its own timezone. */
  todayStartMs: number
  /** How long the last pass took, for the report. */
  indexMs: number
}

const FIVE_HOURS_MS = 5 * 3_600_000

/**
 * Session, today and 7-day totals, in tokens and estimated dollars.
 *
 * Three windows because they are the three a transcript index can honestly
 * fill. Note what is *not* here: a daily *percentage*. The real plan windows
 * are 5-hour and 7-day, `extra_usage.daily` is null with credits disabled, and
 * a "today" figure is therefore only expressible in tokens or estimated
 * dollars - which is exactly why the mode that offers it is the dollar one.
 */
export function readUsageSpend(store: Store, query: UsageSpendQuery): UsageSpend {
  const { nowMs, todayStartMs, indexMs } = query
  const windowMs = query.sessionWindowMs ?? FIVE_HOURS_MS
  const sessionStart =
    query.sessionResetsAtMs === null ? nowMs - windowMs : query.sessionResetsAtMs - windowMs

  const unpriced = new Set<string>()
  const spend: UsageSpend = {
    session: windowCost(store, sessionStart, nowMs, unpriced),
    today: windowCost(store, todayStartMs, nowMs, unpriced),
    week: windowCost(store, nowMs - 7 * 24 * 3_600_000, nowMs, unpriced),
    pricedAt: PRICE_TABLE_DATE,
    unpricedModels: [...unpriced].sort(),
    indexMs
  }
  return spend
}

/** Rows in the index, for the checks and for "is there anything to show". */
export function countUsageMessages(store: Store): number {
  const row = store.raw.prepare('SELECT COUNT(*) AS n FROM usage_messages').get() as { n: number }
  return row.n
}

/** Every row, oldest first. Only the checks read this. */
export function readUsageMessages(store: Store, fromMs: number, toMs: number): UsageRow[] {
  const rows = store.raw
    .prepare(
      `SELECT uuid, at, model, input_tokens, output_tokens,
              cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens
       FROM usage_messages WHERE at >= ? AND at <= ? ORDER BY at`
    )
    .all(fromMs, toMs) as Array<{
    uuid: string
    at: number
    model: string
    input_tokens: number
    output_tokens: number
    cache_write_5m_tokens: number
    cache_write_1h_tokens: number
    cache_read_tokens: number
  }>

  return rows.map((row) => ({
    uuid: row.uuid,
    at: row.at,
    model: row.model,
    input: row.input_tokens,
    output: row.output_tokens,
    cacheWrite5m: row.cache_write_5m_tokens,
    cacheWrite1h: row.cache_write_1h_tokens,
    cacheRead: row.cache_read_tokens
  }))
}
