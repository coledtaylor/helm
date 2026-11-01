import type { UsageRow } from '../usage/transcripts'
import type { ArchiveMessage, ArchiveSessionState } from '../types'
import { decodeBody } from './archive'
import type { Store } from './db'

/**
 * Read-only pages over what only Helm's own database holds, for copying it into
 * a local host's database.
 *
 * The host rebuilds most of `helm.db` from Claude Code's tree on its own: the
 * prompts and sessions from `history.jsonl`, usage and the archive from the
 * transcripts still on disk, and every cursor. What it cannot rebuild is what
 * outlived its source or never had one:
 *
 * - archived conversations (`transcript_sessions`, `transcript_messages`),
 *   whose transcripts Claude Code has since reaped, evicted rows included so
 *   History can still say the conversation was dropped to stay under the limit;
 * - their usage (`usage_messages`), for the same reason;
 * - the names given to sessions in History (`history_names`), authored rather
 *   than derived;
 * - the config console's file versions (`config_snapshots`).
 *
 * Every function here is a SELECT. Nothing in this file writes the database it
 * reads, so a copy that stops part way, or runs twice, leaves `helm.db` exactly
 * as it was. Each page is bounded by a row count and by bytes of text, so one
 * page fits in one protocol frame and reading it does not hold the caller for
 * long; a conversation larger than one page goes in several parts, the last
 * one flagged, so the receiver can write the conversation's row only once all
 * of its messages are in.
 *
 * Message text is decompressed here because the receiver stores it its own
 * way. It is the user's: a caller logs the counts these return, never a body.
 */

/** How much one page may carry. A page always carries at least one row. */
export interface CopyBudget {
  /** Bytes of text (message text, snapshot content), as UTF-8. */
  maxBytes: number
  /** Rows of any kind, a conversation's own row counted as one. */
  maxRows: number
  /**
   * Bytes of text one row may carry, as UTF-8; `MAX_COPIED_TEXT_BYTES` when
   * absent. A page always carries its first row however large, so this is
   * what keeps any page inside one protocol frame.
   */
  maxTextBytes?: number
}

/**
 * About 4 MiB of text or 2,000 rows: well under the protocol's 16 MiB frame,
 * whose strings are UTF-8 as they are (CBOR), and small enough that the
 * receiver's transaction for one page does not keep its other requests waiting.
 */
export const DEFAULT_COPY_BUDGET: CopyBudget = { maxBytes: 4 * 1024 * 1024, maxRows: 2000 }

/**
 * The most text one row carries: 8 MiB. A page holds at most the larger of
 * this and its budget's `maxBytes`, plus its rows' short fields, so it always
 * fits the protocol's 16 MiB frame.
 *
 * A message longer than this is sent cut short, ending with a line saying so,
 * rather than stopping every copy at it: the rest of the conversation, and of
 * the archive, is worth more than the end of one message. A config file
 * version longer than this is left out and counted instead, because restoring
 * part of a file would write a file that never existed.
 */
export const MAX_COPIED_TEXT_BYTES = 8 * 1024 * 1024

/** The first whole characters of `text` that fit in `limit` UTF-8 bytes. */
function utf8Prefix(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  let end = Math.max(0, limit)
  // Never end inside a character: back off continuation bytes (10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString('utf8')
}

const MIB = 1024 * 1024

/**
 * `text` cut to at most `limit` UTF-8 bytes, ending with a line that says it
 * was cut and how long it was; the text itself is never described.
 */
function cutShort(text: string, size: number, limit: number): string {
  const note = `\n\n[Cut short when Helm copied it into the local host: the message held ${(size / MIB).toFixed(1)} MiB, more than one batch carries.]`
  return utf8Prefix(text, limit - Buffer.byteLength(note, 'utf8')) + note
}

/** How many rows each table holds, for the line that says what was copied. */
export interface CopyCounts {
  /** Conversations still holding their messages. */
  archivedConversations: number
  /** Conversations the archive's limit dropped; their row is all that is left. */
  evictedConversations: number
  messages: number
  usageMessages: number
  sessionNames: number
  configSnapshots: number
}

export function countCopyableData(store: Store): CopyCounts {
  const count = (sql: string): number => (store.raw.prepare(sql).get() as { n: number }).n
  return {
    archivedConversations: count(
      "SELECT COUNT(*) AS n FROM transcript_sessions WHERE state = 'archived'"
    ),
    evictedConversations: count(
      "SELECT COUNT(*) AS n FROM transcript_sessions WHERE state = 'evicted'"
    ),
    messages: count('SELECT COUNT(*) AS n FROM transcript_messages'),
    usageMessages: count('SELECT COUNT(*) AS n FROM usage_messages'),
    sessionNames: count('SELECT COUNT(*) AS n FROM history_names'),
    configSnapshots: count('SELECT COUNT(*) AS n FROM config_snapshots')
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** A conversation's `transcript_sessions` row, every figure as it is stored. */
export interface CopiedConversation {
  sessionId: string
  sourceFile: string
  state: ArchiveSessionState
  firstAt: number | null
  lastAt: number | null
  messageCount: number
  rawBytes: number
  storedBytes: number
  capturedAt: string
  evictedAt: string | null
}

/** Every conversation the archive has a row for, and whether it still has its messages. */
export interface ConversationKey {
  sessionId: string
  state: ArchiveSessionState
}

/** Every archived and evicted conversation, in session order. */
export function readConversationKeys(store: Store): ConversationKey[] {
  const rows = store.raw
    .prepare('SELECT session_id, state FROM transcript_sessions ORDER BY session_id')
    .all() as Array<{ session_id: string; state: ArchiveSessionState }>
  return rows.map((row) => ({ sessionId: row.session_id, state: row.state }))
}

/**
 * One conversation's messages, or part of them.
 *
 * `conversation` is the same row on every part. `last` is true on the part that
 * ends the conversation, which for an evicted one is its only part, with no
 * messages.
 */
export interface ConversationPart {
  conversation: CopiedConversation
  /** 0 for the first part of a conversation. */
  part: number
  messages: ArchiveMessage[]
  last: boolean
}

/**
 * Where the next page starts. Pass back the `next` a page returned; null starts
 * at the first conversation.
 */
export interface ConversationCursor {
  /** The conversation the last page ended in. */
  sessionId: string
  /**
   * Set when that conversation is not finished: the last message sent, by the
   * order messages are read in (`at`, then the row id), and the part number
   * the next part takes. Null when the conversation was finished.
   */
  within: { at: number; id: number; part: number } | null
}

export interface ConversationPage {
  parts: ConversationPart[]
  /** Null once every conversation has been read. */
  next: ConversationCursor | null
  /** Messages on this page sent cut short (`MAX_COPIED_TEXT_BYTES`). */
  cut: number
}

export interface ConversationPageOptions {
  budget?: CopyBudget
  /**
   * Only these conversations (lower-case session ids); every other one is
   * skipped. Absent means all of them.
   */
  only?: ReadonlySet<string>
}

interface SessionRow {
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

interface CopyMessageRow {
  id: number
  uuid: string
  role: 'user' | 'assistant'
  at: number
  body: Buffer
  compressed: number
}

const SESSION_COLUMNS = `session_id, source_file, state, first_at, last_at,
  message_count, raw_bytes, stored_bytes, captured_at, evicted_at`

function toConversation(row: SessionRow): CopiedConversation {
  return {
    sessionId: row.session_id,
    sourceFile: row.source_file,
    state: row.state,
    firstAt: row.first_at,
    lastAt: row.last_at,
    messageCount: row.message_count,
    rawBytes: row.raw_bytes,
    storedBytes: row.stored_bytes,
    capturedAt: row.captured_at,
    evictedAt: row.evicted_at
  }
}

/**
 * The next page of conversations, in session order, each with its messages in
 * the order they happened.
 *
 * Read in one read transaction, so a page is one consistent view of the
 * database even if something writes it between statements.
 */
export function readConversationPage(
  store: Store,
  cursor: ConversationCursor | null,
  options: ConversationPageOptions = {}
): ConversationPage {
  const budget = options.budget ?? DEFAULT_COPY_BUDGET
  const maxText = budget.maxTextBytes ?? MAX_COPIED_TEXT_BYTES
  const only = options.only

  const sessionAt = store.raw.prepare(
    `SELECT ${SESSION_COLUMNS} FROM transcript_sessions WHERE session_id = ?`
  )
  const sessionAfter = store.raw.prepare(
    `SELECT ${SESSION_COLUMNS} FROM transcript_sessions
     WHERE session_id > ? ORDER BY session_id LIMIT 1`
  )
  const messagesFrom = store.raw.prepare(
    `SELECT id, uuid, role, at, body, compressed FROM transcript_messages
     WHERE session_id = ? AND (at > ? OR (at = ? AND id > ?))
     ORDER BY at, id
     LIMIT ?`
  )

  const read = store.raw.transaction((): ConversationPage => {
    const parts: ConversationPart[] = []
    let rows = 0
    let bytes = 0
    let cut = 0
    const full = (): boolean => rows >= budget.maxRows || bytes >= budget.maxBytes

    const start = { at: Number.MIN_SAFE_INTEGER, id: 0, part: 0 }
    // The conversation to resume part way through, if it is still there;
    // otherwise the first one after the cursor.
    let from = start
    let session: SessionRow | undefined
    if (cursor !== null && cursor.within !== null) {
      session = sessionAt.get(cursor.sessionId) as SessionRow | undefined
      if (session !== undefined) from = cursor.within
    }
    // The last conversation this page finished or skipped.
    let done = cursor?.sessionId ?? ''
    if (session === undefined) session = sessionAfter.get(done) as SessionRow | undefined

    while (session !== undefined) {
      if (only !== undefined && !only.has(session.session_id)) {
        done = session.session_id
        session = sessionAfter.get(done) as SessionRow | undefined
        continue
      }
      // A new conversation starts only while the page has room for it.
      if (parts.length > 0 && full()) return { parts, next: { sessionId: done, within: null }, cut }

      const conversation = toConversation(session)
      const messages: ArchiveMessage[] = []
      let last = { at: from.at, id: from.id }
      let finished = true
      if (session.state === 'archived') {
        // One row more than there is room for says whether the conversation
        // goes on past this page without a second query.
        const room = Math.max(1, budget.maxRows - rows - 1)
        const found = messagesFrom.all(
          session.session_id,
          from.at,
          from.at,
          from.id,
          room + 1
        ) as CopyMessageRow[]
        let taken = 0
        for (const row of found) {
          let text = decodeBody(row.body, row.compressed === 1)
          let size = Buffer.byteLength(text, 'utf8')
          const tooLong = size > maxText
          if (tooLong) {
            text = cutShort(text, size, maxText)
            size = Buffer.byteLength(text, 'utf8')
          }
          // Always at least one message per page, or a page could never make
          // progress past it; `maxText` bounds how large that one is.
          const anything = parts.length > 0 || messages.length > 0
          if (taken === room || (anything && bytes + size > budget.maxBytes)) {
            finished = false
            break
          }
          if (tooLong) cut++
          messages.push({ uuid: row.uuid, role: row.role, at: row.at, text })
          bytes += size
          rows++
          taken++
          last = { at: row.at, id: row.id }
        }
      }

      if (finished) rows++ // The conversation's own row goes with its last part.
      parts.push({ conversation, part: from.part, messages, last: finished })
      if (!finished) {
        return {
          parts,
          next: { sessionId: session.session_id, within: { ...last, part: from.part + 1 } },
          cut
        }
      }

      from = start
      done = session.session_id
      session = sessionAfter.get(done) as SessionRow | undefined
    }

    return { parts, next: null, cut }
  })
  return read()
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface UsagePage {
  rows: UsageRow[]
  /** The uuid to pass back for the next page; null once every row was read. */
  next: string | null
}

/** The next `limit` usage rows in uuid order, after `afterUuid` (null for the first page). */
export function readUsagePage(
  store: Store,
  afterUuid: string | null,
  limit = DEFAULT_COPY_BUDGET.maxRows
): UsagePage {
  const take = Math.max(1, limit)
  const found = store.raw
    .prepare(
      `SELECT uuid, at, model, input_tokens, output_tokens,
              cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens
       FROM usage_messages WHERE uuid > ? ORDER BY uuid LIMIT ?`
    )
    .all(afterUuid ?? '', take + 1) as Array<{
    uuid: string
    at: number
    model: string
    input_tokens: number
    output_tokens: number
    cache_write_5m_tokens: number
    cache_write_1h_tokens: number
    cache_read_tokens: number
  }>
  const more = found.length > take
  const rows = found.slice(0, take).map((row) => ({
    uuid: row.uuid,
    at: row.at,
    model: row.model,
    input: row.input_tokens,
    output: row.output_tokens,
    cacheWrite5m: row.cache_write_5m_tokens,
    cacheWrite1h: row.cache_write_1h_tokens,
    cacheRead: row.cache_read_tokens
  }))
  return { rows, next: more ? (rows[rows.length - 1]?.uuid ?? null) : null }
}

// ---------------------------------------------------------------------------
// Session names
// ---------------------------------------------------------------------------

export interface CopiedSessionName {
  /** Lower-cased, as it is stored. */
  sessionId: string
  name: string
  renamedAt: string
}

/** Every name given to a session in History. Names are short and few, so one read. */
export function readSessionNames(store: Store): CopiedSessionName[] {
  const rows = store.raw
    .prepare('SELECT session_id, name, renamed_at FROM history_names ORDER BY session_id')
    .all() as Array<{ session_id: string; name: string; renamed_at: string }>
  return rows.map((row) => ({
    sessionId: row.session_id,
    name: row.name,
    renamedAt: row.renamed_at
  }))
}

// ---------------------------------------------------------------------------
// Config file versions
// ---------------------------------------------------------------------------

/** A `config_snapshots` row, with its content. */
export interface CopiedConfigSnapshot {
  /** This database's id; the receiver gives the row its own. */
  id: number
  scopePath: string
  filePath: string
  content: string
  contentHash: string
  /**
   * As stored (a `ConfigWriteReason`), and not narrowed, so a reason a later
   * build added survives the copy.
   */
  reason: string
  createdAt: string
}

export interface ConfigSnapshotPage {
  rows: CopiedConfigSnapshot[]
  /** The id to pass back for the next page; null once every row was read. */
  next: number | null
  /** Versions on this page left out as longer than `MAX_COPIED_TEXT_BYTES`. */
  skipped: number
}

/** The next config file versions in id order, after `afterId` (null for the first page). */
export function readConfigSnapshotPage(
  store: Store,
  afterId: number | null,
  budget: CopyBudget = DEFAULT_COPY_BUDGET
): ConfigSnapshotPage {
  const select = store.raw.prepare(
    `SELECT id, project_path, file_path, content, content_hash, reason, created_at
     FROM config_snapshots WHERE id > ? ORDER BY id LIMIT ?`
  )
  const found = select.all(afterId ?? 0, Math.max(1, budget.maxRows) + 1) as Array<{
    id: number
    project_path: string
    file_path: string
    content: string
    content_hash: string
    reason: string
    created_at: string
  }>

  const maxText = budget.maxTextBytes ?? MAX_COPIED_TEXT_BYTES
  const rows: CopiedConfigSnapshot[] = []
  let bytes = 0
  let skipped = 0
  /** The last row this page took or left out, which the next page starts after. */
  let read: number | null = null
  let more = false
  for (const [index, row] of found.entries()) {
    const size = Buffer.byteLength(row.content, 'utf8')
    if (index >= Math.max(1, budget.maxRows) || (rows.length > 0 && bytes + size > budget.maxBytes)) {
      more = true
      break
    }
    read = row.id
    if (size > maxText) {
      skipped++
      continue
    }
    rows.push({
      id: row.id,
      scopePath: row.project_path,
      filePath: row.file_path,
      content: row.content,
      contentHash: row.content_hash,
      reason: row.reason,
      createdAt: row.created_at
    })
    bytes += size
  }
  return { rows, next: more ? read : null, skipped }
}
