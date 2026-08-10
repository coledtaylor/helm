import type { ConfigSnapshot, ConfigSnapshotMeta, ConfigWriteReason } from '../types'
import type { Store } from './db'

/**
 * The undo history behind every config write.
 *
 * `~/.claude` is Claude Code's and Helm only reads it - except here, which is
 * the whole point of M5 and exactly why this table is not optional. A snapshot
 * row is taken *before* the bytes are replaced, and the write is not attempted
 * if the row could not be written: a config editor that can lose a file the
 * user spent an afternoon on is worse than no config editor.
 *
 * Content is stored inline rather than as a path. A snapshot that depends on
 * the file still being on disk is not a snapshot, and `.claude` files are
 * kilobytes - the largest CLAUDE.md on the machine this was built against is
 * 18 KB.
 */

interface SnapshotRow {
  id: number
  project_path: string
  file_path: string
  content_hash: string
  bytes: number
  reason: string
  created_at: string
  content?: string
}

const REASONS = new Set<ConfigWriteReason>(['edit', 'create', 'restore', 'mcp', 'approve'])

function toReason(value: string): ConfigWriteReason {
  return REASONS.has(value as ConfigWriteReason) ? (value as ConfigWriteReason) : 'edit'
}

function toMeta(row: SnapshotRow): ConfigSnapshotMeta {
  return {
    id: row.id,
    scopePath: row.project_path,
    filePath: row.file_path,
    contentHash: row.content_hash,
    bytes: row.bytes,
    reason: toReason(row.reason),
    createdAt: row.created_at
  }
}

export interface NewConfigSnapshot {
  /** The scope's base directory. */
  scopePath: string
  /** Relative to `scopePath`, forward-slashed. */
  filePath: string
  /** The bytes as they are *now*, before the write. Empty for a new file. */
  content: string
  /** sha256 of `content`, computed by the caller from the same bytes. */
  contentHash: string
  reason: ConfigWriteReason
}

/** Takes the row. Returns its id, which the write path needs before it acts. */
export function insertConfigSnapshot(store: Store, input: NewConfigSnapshot): number {
  const result = store.raw
    .prepare(
      `INSERT INTO config_snapshots (project_path, file_path, content, content_hash, reason)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(input.scopePath, input.filePath, input.content, input.contentHash, input.reason)
  return Number(result.lastInsertRowid)
}

/**
 * One file's history, newest first, without the contents.
 *
 * The list is a sidebar of timestamps and sizes; loading every version's bytes
 * to draw it would mean reading the whole history of a file to show that it has
 * one. `readConfigSnapshot` fetches the bytes when a version is chosen.
 */
export function readConfigSnapshots(
  store: Store,
  scopePath: string,
  filePath: string,
  limit = 100
): ConfigSnapshotMeta[] {
  const rows = store.raw
    .prepare(
      `SELECT id, project_path, file_path, content_hash,
              length(content) AS bytes, reason, created_at
       FROM config_snapshots
       WHERE project_path = ? AND file_path = ?
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(scopePath, filePath, Math.max(1, limit)) as SnapshotRow[]
  return rows.map(toMeta)
}

export function readConfigSnapshot(store: Store, id: number): ConfigSnapshot | null {
  const row = store.raw
    .prepare(
      `SELECT id, project_path, file_path, content, content_hash,
              length(content) AS bytes, reason, created_at
       FROM config_snapshots WHERE id = ?`
    )
    .get(id) as SnapshotRow | undefined
  if (!row) return null
  return { ...toMeta(row), content: row.content ?? '' }
}

/** Every snapshot in the database, newest first. The console's global history. */
export function readAllConfigSnapshots(store: Store, limit = 200): ConfigSnapshotMeta[] {
  const rows = store.raw
    .prepare(
      `SELECT id, project_path, file_path, content_hash,
              length(content) AS bytes, reason, created_at
       FROM config_snapshots
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(Math.max(1, limit)) as SnapshotRow[]
  return rows.map(toMeta)
}

export function countConfigSnapshots(store: Store): number {
  const row = store.raw.prepare('SELECT COUNT(*) AS n FROM config_snapshots').get() as { n: number }
  return row.n
}
