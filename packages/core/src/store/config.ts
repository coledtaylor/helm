import type { ConfigWriteReason } from '../types'
import type { Store } from './db'

/**
 * The config versions an older install kept: a snapshot of each `~/.claude`
 * file taken before the config console replaced it. The copy into the host
 * reads them (`copy.ts`); this writer stays so the copy's tests can plant what
 * such an install left behind.
 */

export interface NewConfigSnapshot {
  /** The scope's base directory. */
  scopePath: string
  /** Relative to `scopePath`, forward-slashed. */
  filePath: string
  /** The bytes as they were before the write. Empty for a new file. */
  content: string
  /** sha256 of `content`, computed by the caller from the same bytes. */
  contentHash: string
  reason: ConfigWriteReason
}

/** Takes the row and returns its id. */
export function insertConfigSnapshot(store: Store, input: NewConfigSnapshot): number {
  const result = store.raw
    .prepare(
      `INSERT INTO config_snapshots (project_path, file_path, content, content_hash, reason)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.scopePath, input.filePath, input.content, input.contentHash, input.reason)
  return Number(result.lastInsertRowid)
}
