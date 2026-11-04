import type { UsageTail } from '../usage/transcripts'
import type { Store } from './db'

/**
 * The usage index an install that ran sessions in Helm's own process kept:
 * token counts from every transcript under `~/.claude/projects`. The copy into
 * the host reads it (`copy.ts`); this writer stays so the copy's tests can
 * plant what such an install left behind.
 *
 * Written with the driver rather than through Drizzle: the insert is an
 * `INSERT ... ON CONFLICT DO NOTHING` over a batch, which the query builder
 * does not express.
 */

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
