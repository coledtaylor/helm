import { deflateRawSync, inflateRawSync } from 'node:zlib'
import type { ArchiveTail } from '../archive/transcript'
import type {
  ArchiveMessage,
  ArchiveSessionState,
  ArchiveStats,
  ArchivedConversation
} from '../types'
import type { Store } from './db'

/**
 * The transcript archive: the conversations out of `~/.claude/projects`, kept
 * after Claude Code deletes them.
 *
 * Written with the driver rather than through Drizzle for the reason
 * `history.ts` and `usage.ts` are: the insert is an `INSERT ... ON CONFLICT DO
 * NOTHING` over a batch, the search is an FTS5 `MATCH` against a virtual table
 * drizzle-kit cannot model at all, and the eviction is a loop over an ordered
 * SUM. None of those is expressible in the query builder, and splitting the
 * work so half went through it would buy nothing and hide where the cost is.
 *
 * Read-only with respect to Claude Code's tree, absolutely and without
 * exception. Nothing in this file opens a `.claude` path for writing; the only
 * thing it does with one is read bytes and store what it read.
 */

/**
 * Below this, compressing costs more than it saves.
 *
 * Raw deflate on a short string routinely comes out longer than the input - the
 * Huffman table has to go somewhere - so each body is stored whichever way is
 * smaller and says which it was. That is also why `stored_bytes` is a column
 * rather than something derived from `raw_bytes`: the ceiling is enforced
 * against what is actually in the database.
 */
const COMPRESS_ABOVE_BYTES = 120

interface Encoded {
  body: Buffer
  compressed: boolean
  rawBytes: number
  storedBytes: number
}

function encodeBody(text: string): Encoded {
  const raw = Buffer.from(text, 'utf8')
  if (raw.length <= COMPRESS_ABOVE_BYTES) {
    return { body: raw, compressed: false, rawBytes: raw.length, storedBytes: raw.length }
  }
  const packed = deflateRawSync(raw)
  if (packed.length >= raw.length) {
    return { body: raw, compressed: false, rawBytes: raw.length, storedBytes: raw.length }
  }
  return { body: packed, compressed: true, rawBytes: raw.length, storedBytes: packed.length }
}

function decodeBody(body: Buffer | Uint8Array, compressed: boolean): string {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (!compressed) return buffer.toString('utf8')
  try {
    return inflateRawSync(buffer).toString('utf8')
  } catch {
    // A body that cannot be inflated is one row of one conversation, and
    // throwing here would take a whole transcript view down with it. The
    // conversation is worth more than the message.
    return ''
  }
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

/** Bytes of `file` already archived, or 0 if it has never been read. */
export function archiveCursor(store: Store, file: string): number {
  const row = store.raw
    .prepare('SELECT bytes FROM transcript_index WHERE file = ?')
    .get(file) as { bytes: number } | undefined
  return row?.bytes ?? 0
}

/** Every transcript path the archive has a cursor for. */
export function indexedArchiveFiles(store: Store): Map<string, number> {
  const rows = store.raw.prepare('SELECT file, bytes FROM transcript_index').all() as Array<{
    file: string
    bytes: number
  }>
  return new Map(rows.map((row) => [row.file, row.bytes]))
}

/**
 * Forgets cursors for transcripts that are no longer on disk.
 *
 * The archived conversations stay - that is the entire feature. What goes is
 * the cursor, so the table does not grow for ever with paths that cannot be
 * read.
 */
export function forgetArchiveFiles(store: Store, files: readonly string[]): number {
  if (files.length === 0) return 0
  const drop = store.raw.prepare('DELETE FROM transcript_index WHERE file = ?')
  let removed = 0
  const apply = store.raw.transaction(() => {
    for (const file of files) removed += drop.run(file).changes
  })
  apply()
  return removed
}

/** What a session's archive currently is, or null if there has never been one. */
export function archiveStateOf(store: Store, sessionId: string): ArchiveSessionState | null {
  const row = store.raw
    .prepare('SELECT state FROM transcript_sessions WHERE session_id = ?')
    .get(sessionId.toLowerCase()) as { state: ArchiveSessionState } | undefined
  return row?.state ?? null
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ArchiveInput {
  /** The transcript these messages came from; also the cursor's key. */
  file: string
  /** The session the file is named for, used when a row does not declare one. */
  sessionId: string
  tail: ArchiveTail
}

export interface ArchiveWrite {
  /** Messages added. Duplicates from a fork are not counted. */
  messages: number
  /** Bytes those messages take in the database, after compression. */
  storedBytes: number
  /** Sessions touched, so a caller can report which conversations moved. */
  sessions: string[]
  /** True when the tail belonged to a session the ceiling has already dropped. */
  skippedEvicted: boolean
}

/**
 * Applies one transcript's tail.
 *
 * `ON CONFLICT(uuid) DO NOTHING` is what makes this idempotent, and it is doing
 * real work rather than guarding a case that cannot happen - see
 * `usage.ts`'s note on forks re-offering rows that are already stored.
 *
 * A tail belonging to an **evicted** session is consumed and thrown away: the
 * cursor still advances, so the pass does not read it again, and nothing is
 * stored, because re-capturing what the ceiling just dropped is how a bounded
 * archive turns into a loop.
 */
export function archiveTranscriptFile(store: Store, input: ArchiveInput): ArchiveWrite {
  const { file, tail } = input
  const result: ArchiveWrite = {
    messages: 0,
    storedBytes: 0,
    sessions: [],
    skippedEvicted: false
  }

  const apply = store.raw.transaction(() => {
    if (tail.reset) {
      // The file is not the one the cursor belonged to. The messages it
      // produced are still valid where they overlap - their uuids will simply
      // conflict - so nothing is deleted; the cursor going back to zero
      // re-offers them all.
      store.raw.prepare('DELETE FROM transcript_index WHERE file = ?').run(file)
    }

    const touched = new Set<string>()
    if (tail.rows.length > 0) {
      const evicted = new Set(
        (
          store.raw
            .prepare("SELECT session_id FROM transcript_sessions WHERE state = 'evicted'")
            .all() as Array<{ session_id: string }>
        ).map((row) => row.session_id)
      )

      const insertMessage = store.raw.prepare(
        `INSERT INTO transcript_messages
           (uuid, session_id, role, at, body, compressed, raw_bytes, stored_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO NOTHING`
      )
      const insertFts = store.raw.prepare('INSERT INTO transcript_fts(rowid, text) VALUES (?, ?)')

      for (const row of tail.rows) {
        if (evicted.has(row.sessionId)) {
          result.skippedEvicted = true
          continue
        }
        const encoded = encodeBody(row.text)
        const written = insertMessage.run(
          row.uuid,
          row.sessionId,
          row.role,
          row.at,
          encoded.body,
          encoded.compressed ? 1 : 0,
          encoded.rawBytes,
          encoded.storedBytes
        )
        if (written.changes === 0) continue
        // The index is written here rather than by a trigger because the text
        // is not in the row - `body` is a compressed blob. Same transaction, so
        // a message and its index entry cannot disagree. See `schema.ts`.
        insertFts.run(written.lastInsertRowid, row.text)
        result.messages++
        result.storedBytes += encoded.storedBytes
        touched.add(row.sessionId)
      }
    }

    for (const sessionId of touched) {
      store.raw
        .prepare(
          `INSERT INTO transcript_sessions
             (session_id, source_file, state, first_at, last_at,
              message_count, raw_bytes, stored_bytes, captured_at)
           SELECT ?, ?, 'archived', MIN(at), MAX(at),
                  COUNT(*), COALESCE(SUM(raw_bytes), 0), COALESCE(SUM(stored_bytes), 0),
                  strftime('%Y-%m-%dT%H:%M:%fZ','now')
           FROM transcript_messages WHERE session_id = ?
           ON CONFLICT(session_id) DO UPDATE SET
             source_file   = excluded.source_file,
             first_at      = excluded.first_at,
             last_at       = excluded.last_at,
             message_count = excluded.message_count,
             raw_bytes     = excluded.raw_bytes,
             stored_bytes  = excluded.stored_bytes`
        )
        .run(sessionId, file, sessionId)
      result.sessions.push(sessionId)
    }

    store.raw
      .prepare(
        `INSERT INTO transcript_index (file, bytes, messages, indexed_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(file) DO UPDATE SET
           bytes = excluded.bytes,
           messages = transcript_index.messages + excluded.messages,
           indexed_at = excluded.indexed_at`
      )
      .run(file, tail.bytes, result.messages)
  })
  apply()

  return result
}

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

export interface Eviction {
  /** Sessions dropped whole, oldest first. */
  sessions: string[]
  /** Messages deleted with them. */
  messages: number
  /** Stored bytes reclaimed. */
  bytes: number
  /** Stored bytes after the eviction, which must be at or under the ceiling. */
  storedBytes: number
}

/** Stored bytes the archive is currently using. What the ceiling is measured on. */
export function archivedBytes(store: Store): number {
  const row = store.raw
    .prepare(
      "SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM transcript_sessions WHERE state = 'archived'"
    )
    .get() as { n: number }
  return row.n
}

/**
 * Brings the archive back under `maxBytes` by dropping whole sessions,
 * oldest-last-message first.
 *
 * Whole sessions, never part of one. Half a conversation stored under a row
 * that says how many messages it has is a transcript that lies about being
 * complete, and there is no way for the surface to tell the user which half
 * they are reading. The ceiling is adjustable; this rule is not.
 *
 * The dropped session keeps its row. `state = 'evicted'` is what lets the pane
 * say "Helm had this and dropped it to stay under your limit" rather than "this
 * was reaped before Helm ever saw it", which are different facts about the same
 * missing conversation - and it is what stops the next pass archiving it again.
 */
export function evictToCeiling(store: Store, maxBytes: number): Eviction {
  const result: Eviction = { sessions: [], messages: 0, bytes: 0, storedBytes: 0 }

  const apply = store.raw.transaction(() => {
    let stored = archivedBytes(store)
    const oldest = store.raw.prepare(
      `SELECT session_id, stored_bytes, message_count
       FROM transcript_sessions
       WHERE state = 'archived'
       ORDER BY COALESCE(last_at, 0), session_id
       LIMIT 1`
    )
    // The messages go first: the FTS index is cleaned by the delete trigger on
    // that table, so removing the session row without them would leave a search
    // index pointing at nothing.
    const dropMessages = store.raw.prepare('DELETE FROM transcript_messages WHERE session_id = ?')
    const markEvicted = store.raw.prepare(
      `UPDATE transcript_sessions
       SET state = 'evicted',
           stored_bytes = 0,
           evicted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE session_id = ?`
    )

    while (stored > maxBytes) {
      const row = oldest.get() as
        | { session_id: string; stored_bytes: number; message_count: number }
        | undefined
      // Nothing left to drop. The archive is as small as this rule can make it,
      // and reporting that honestly is better than dropping something else.
      if (row === undefined) break
      dropMessages.run(row.session_id)
      markEvicted.run(row.session_id)
      result.sessions.push(row.session_id)
      result.messages += row.message_count
      result.bytes += row.stored_bytes
      stored -= row.stored_bytes
    }
    result.storedBytes = archivedBytes(store)
  })
  apply()

  return result
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface MessageRow {
  id: number
  uuid: string
  role: 'user' | 'assistant'
  at: number
  body: Buffer
  compressed: number
  raw_bytes: number
}

function toMessage(row: MessageRow): ArchiveMessage {
  return {
    uuid: row.uuid,
    role: row.role,
    at: row.at,
    text: decodeBody(row.body, row.compressed === 1)
  }
}

/**
 * One archived conversation, in the order it happened.
 *
 * Returns the row even when it has been evicted - with no messages and
 * `state: 'evicted'` - because "we had this" is the answer the surface needs to
 * paint, and an empty list with no row behind it says the opposite.
 */
export function readArchivedConversation(
  store: Store,
  sessionId: string
): ArchivedConversation | null {
  const key = sessionId.toLowerCase()
  const session = store.raw
    .prepare(
      `SELECT session_id, source_file, state, first_at, last_at,
              message_count, raw_bytes, stored_bytes, captured_at, evicted_at
       FROM transcript_sessions WHERE session_id = ?`
    )
    .get(key) as
    | {
        session_id: string
        source_file: string
        state: ArchiveSessionState
        first_at: number | null
        last_at: number | null
        message_count: number
        raw_bytes: number
        stored_bytes: number
        captured_at: string
        evicted_at: string | null
      }
    | undefined
  if (session === undefined) return null

  const rows =
    session.state === 'archived'
      ? (store.raw
          .prepare(
            `SELECT id, uuid, role, at, body, compressed, raw_bytes
             FROM transcript_messages WHERE session_id = ? ORDER BY at, id`
          )
          .all(key) as MessageRow[])
      : []

  return {
    sessionId: session.session_id,
    sourceFile: session.source_file,
    state: session.state,
    firstAt: session.first_at,
    lastAt: session.last_at,
    messageCount: session.message_count,
    rawBytes: session.raw_bytes,
    storedBytes: session.stored_bytes,
    capturedAt: session.captured_at,
    evictedAt: session.evicted_at,
    messages: rows.map(toMessage)
  }
}

/**
 * A search box's text, as an FTS5 query.
 *
 * Every token is quoted as a string literal, which makes FTS5's own syntax
 * inert: a `-` typed into a search box is a hyphen and not a NOT, and an
 * unbalanced `"` is a character and not a parse error. The last token carries a
 * prefix `*` so that typing feels live - `geofenc` finds `geofencing` while the
 * word is still being typed, which is the behaviour the prompt search gets from
 * `LIKE` for free and a tokenising index does not.
 *
 * Null when there is nothing to search for, which is not the same as a query
 * that matches nothing.
 */
export function archiveSearchQuery(search: string): string | null {
  const tokens = search.toLowerCase().match(/[\p{L}\p{N}_]+/gu)
  if (tokens === null || tokens.length === 0) return null
  return tokens
    .map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' AND ')
}

/** Sessions whose archived messages match, and the first matching message. */
export interface ArchiveMatch {
  sessionId: string
  /** The matching message's text, for the row's headline. */
  text: string
}

/**
 * Which archived conversations contain this, and where.
 *
 * Bounded rather than exhaustive: the caller is filtering a list, and the
 * hundredth message of the four-hundredth session changes nothing on screen.
 * `limit` is over *sessions*, and the first match within each is the one shown.
 */
export function searchArchive(
  store: Store,
  search: string,
  limit = 2000
): Map<string, ArchiveMatch> {
  const query = archiveSearchQuery(search)
  const found = new Map<string, ArchiveMatch>()
  if (query === null) return found

  let rows: Array<{ session_id: string; body: Buffer; compressed: number }>
  try {
    rows = store.raw
      .prepare(
        `SELECT m.session_id, m.body, m.compressed
         FROM transcript_fts f
         JOIN transcript_messages m ON m.id = f.rowid
         WHERE transcript_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, limit * 4) as Array<{ session_id: string; body: Buffer; compressed: number }>
  } catch {
    // FTS5 rejects some inputs whatever the quoting - a token of only combining
    // marks, for one. A search that cannot be parsed matches nothing, which is
    // the same answer the box would give anyway and not a reason to throw at a
    // keystroke.
    return found
  }

  for (const row of rows) {
    if (found.has(row.session_id)) continue
    found.set(row.session_id, {
      sessionId: row.session_id,
      text: decodeBody(row.body, row.compressed === 1)
    })
    if (found.size >= limit) break
  }
  return found
}

/** What the archive currently holds, for the settings pane and the checks. */
export function readArchiveStats(store: Store, maxBytes: number): ArchiveStats {
  const totals = store.raw
    .prepare(
      `SELECT
         SUM(CASE WHEN state = 'archived' THEN 1 ELSE 0 END)                 AS archived,
         SUM(CASE WHEN state = 'evicted'  THEN 1 ELSE 0 END)                 AS evicted,
         COALESCE(SUM(CASE WHEN state = 'archived' THEN message_count END), 0) AS messages,
         COALESCE(SUM(CASE WHEN state = 'archived' THEN raw_bytes END), 0)     AS raw_bytes,
         COALESCE(SUM(CASE WHEN state = 'archived' THEN stored_bytes END), 0)  AS stored_bytes,
         MIN(CASE WHEN state = 'archived' THEN last_at END)                  AS oldest_at,
         MAX(CASE WHEN state = 'archived' THEN last_at END)                  AS newest_at
       FROM transcript_sessions`
    )
    .get() as {
    archived: number | null
    evicted: number | null
    messages: number
    raw_bytes: number
    stored_bytes: number
    oldest_at: number | null
    newest_at: number | null
  }

  return {
    sessions: totals.archived ?? 0,
    evictedSessions: totals.evicted ?? 0,
    messages: totals.messages,
    rawBytes: totals.raw_bytes,
    storedBytes: totals.stored_bytes,
    maxBytes,
    oldestAt: totals.oldest_at,
    newestAt: totals.newest_at
  }
}

/**
 * Empties the archive. Only the checks call this, and they own their database.
 *
 * The message delete goes first so the FTS trigger un-indexes each row; a
 * `DELETE FROM transcript_fts` on a contentless table would be the other half
 * of the same job done twice.
 */
export function clearArchive(store: Store): void {
  const apply = store.raw.transaction(() => {
    store.raw.prepare('DELETE FROM transcript_messages').run()
    store.raw.prepare('DELETE FROM transcript_sessions').run()
    store.raw.prepare('DELETE FROM transcript_index').run()
  })
  apply()
}
