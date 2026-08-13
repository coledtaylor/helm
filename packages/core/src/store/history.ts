import { basename } from 'node:path'
import type { TranscriptFile, HistoryTail } from '../discovery/history'
import type {
  ArchiveSessionState,
  HistoryPage,
  HistoryProject,
  HistoryPrompt,
  HistoryQuery,
  HistorySession,
  HistorySummary
} from '../types'
import { searchArchive, type ArchiveMatch } from './archive'
import type { Store } from './db'

/**
 * The session index: `~/.claude/history.jsonl` and the surviving transcripts,
 * mirrored into SQLite so the launcher can search and group 799 sessions
 * instead of re-parsing 875 KB per keystroke.
 *
 * Written with the driver rather than through Drizzle. Two of the statements
 * here - the aggregate rebuild and the substring search - are an
 * `INSERT ... SELECT ... ON CONFLICT` and a `LIKE ... ESCAPE`, neither of which
 * the query builder expresses; splitting the work so that half went through it
 * would buy nothing and hide where the cost is.
 */

const DEFAULT_LIMIT = 2000

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface HistoryIndexInput {
  /** The history file these lines came from; also the cursor's key. */
  file: string
  tail: HistoryTail
  /** Session ids that still have a transcript, keyed by lowercased id. */
  transcripts: Map<string, TranscriptFile>
  /**
   * Answers "is this recorded working directory still there". Injected so the
   * check runs inside the same transaction as everything else it has to agree
   * with, and so a test can answer it without a filesystem.
   */
  directoryExists: (path: string) => boolean
}

/** Bytes of `file` already consumed, or 0 if it has never been indexed. */
export function historyCursor(store: Store, file: string): number {
  const row = store.raw
    .prepare('SELECT bytes FROM history_index WHERE file = ?')
    .get(file) as { bytes: number } | undefined
  return row?.bytes ?? 0
}

/**
 * Applies one pass over the history file and the transcript directory.
 *
 * Everything happens in a single transaction, so a reader in the window never
 * sees an index that has the new prompts but not the aggregate built from
 * them - under WAL it sees the whole previous state until this commits.
 *
 * The aggregate is rebuilt in full rather than only for the sessions this pass
 * touched. It is one GROUP BY over the prompt table - a few milliseconds at
 * 3,470 rows - and the alternative is arithmetic that has to stay correct
 * across resets, re-reads and the same session appearing in two passes.
 */
export function indexHistory(store: Store, input: HistoryIndexInput): HistorySummary {
  const { file, tail, transcripts, directoryExists } = input

  const apply = store.raw.transaction(() => {
    if (tail.reset) {
      store.raw.prepare('DELETE FROM history_prompts').run()
      store.raw.prepare('DELETE FROM history_sessions').run()
    }

    if (tail.lines.length > 0) {
      const next = store.raw
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM history_prompts')
        .get() as { seq: number }
      const insert = store.raw.prepare(
        'INSERT INTO history_prompts (seq, session_id, project, at, text) VALUES (?, ?, ?, ?, ?)'
      )
      let seq = next.seq
      for (const line of tail.lines) {
        insert.run(seq++, line.sessionId, line.project, line.timestamp, line.display)
      }
    }

    if (tail.reset || tail.lines.length > 0) {
      rebuildSessions(store)
    }

    // Always, even when no prompt was added: a transcript can be reaped, and a
    // project directory deleted, without the history file changing at all.
    applyTranscripts(store, transcripts)
    applyProjectExistence(store, directoryExists)

    store.raw
      .prepare(
        `INSERT INTO history_index (file, bytes, indexed_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(file) DO UPDATE SET
           bytes = excluded.bytes, indexed_at = excluded.indexed_at`
      )
      .run(file, tail.bytes)
  })
  apply()

  const summary = historySummary(store, file)
  return tail.error === undefined ? summary : { ...summary, error: tail.error }
}

/**
 * Recomputes every session row from the prompts.
 *
 * `project` and `first_prompt` are taken from the session's earliest prompt by
 * joining back on its `seq`, not with a bare column beside the aggregate:
 * SQLite would accept that and pick an arbitrary row, which is the kind of
 * thing that is right until the day it is not.
 *
 * The conflict clause deliberately leaves the transcript columns alone - they
 * are owned by `applyTranscripts`, which knows what is on disk. Overwriting
 * them here would mark every session reaped on every pass.
 */
function rebuildSessions(store: Store): void {
  store.raw
    .prepare(
      `INSERT INTO history_sessions (
         session_id, project, project_key, prompt_count,
         first_at, last_at, first_prompt,
         transcript_file, transcript_bytes, project_exists
       )
       SELECT a.session_id, f.project, lower(f.project), a.n,
              a.first_at, a.last_at, f.text,
              NULL, NULL, 0
       FROM (
         SELECT session_id,
                COUNT(*) AS n,
                MIN(at)  AS first_at,
                MAX(at)  AS last_at,
                MIN(seq) AS first_seq
         FROM history_prompts
         GROUP BY session_id
       ) a
       JOIN history_prompts f ON f.seq = a.first_seq
       ON CONFLICT(session_id) DO UPDATE SET
         project      = excluded.project,
         project_key  = excluded.project_key,
         prompt_count = excluded.prompt_count,
         first_at     = excluded.first_at,
         last_at      = excluded.last_at,
         first_prompt = excluded.first_prompt`
    )
    .run()

  // A session can only lose all its prompts by the file being rewritten, which
  // resets the table anyway - but a row with nothing behind it would be a
  // session the launcher offers and cannot explain.
  store.raw
    .prepare(
      `DELETE FROM history_sessions
       WHERE session_id NOT IN (SELECT session_id FROM history_prompts)`
    )
    .run()
}

/** What is on disk now, not what was on disk when the row was written. */
function applyTranscripts(store: Store, transcripts: Map<string, TranscriptFile>): void {
  store.raw
    .prepare('UPDATE history_sessions SET transcript_file = NULL, transcript_bytes = NULL')
    .run()

  const mark = store.raw.prepare(
    `UPDATE history_sessions
     SET transcript_file = ?, transcript_bytes = ?
     WHERE lower(session_id) = ?`
  )
  for (const transcript of transcripts.values()) {
    mark.run(transcript.file, transcript.bytes, transcript.sessionId)
  }
}

/** One stat per distinct recorded directory, not one per session. */
function applyProjectExistence(store: Store, exists: (path: string) => boolean): void {
  const rows = store.raw
    .prepare('SELECT DISTINCT project, project_key FROM history_sessions')
    .all() as Array<{ project: string; project_key: string }>

  const set = store.raw.prepare('UPDATE history_sessions SET project_exists = ? WHERE project_key = ?')
  for (const row of rows) {
    set.run(exists(row.project) ? 1 : 0, row.project_key)
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

interface SessionRow {
  session_id: string
  project: string
  prompt_count: number
  first_at: number
  last_at: number
  first_prompt: string
  transcript_file: string | null
  transcript_bytes: number | null
  project_exists: number
  archive_state: ArchiveSessionState | null
  archived_messages: number | null
  match?: string | null
}

function toSession(row: SessionRow): HistorySession {
  const session: HistorySession = {
    sessionId: row.session_id,
    project: row.project,
    projectName: basename(row.project) || row.project,
    promptCount: row.prompt_count,
    firstAt: row.first_at,
    lastAt: row.last_at,
    firstPrompt: row.first_prompt,
    transcriptFile: row.transcript_file,
    transcriptBytes: row.transcript_bytes,
    projectExists: row.project_exists === 1,
    archive: row.archive_state,
    archivedMessages: row.archived_messages
  }
  if (row.match !== undefined && row.match !== null) session.match = row.match
  return session
}

/**
 * The archive columns, joined onto every session read.
 *
 * A LEFT JOIN rather than a second query, because the list needs this on every
 * row it paints: which of the three states a session is in - resumable, kept
 * here, dropped for space - is a property of the row, not something to fetch
 * per selection. `history_sessions` is a table of ~800 rows and
 * `transcript_sessions` is keyed by the same id, so the join is an index lookup
 * per row.
 */
const ARCHIVE_JOIN = 'LEFT JOIN transcript_sessions a ON a.session_id = lower(s.session_id)'
const ARCHIVE_COLUMNS = `, a.state AS archive_state,
              CASE WHEN a.session_id IS NULL THEN NULL ELSE a.message_count END AS archived_messages`

/**
 * A substring of a prompt or a project path, as a LIKE pattern.
 *
 * FTS5 was the other option and is the wrong one here. This box filters a list
 * while you type, so `geofenc` has to match `geofencing` and `--resume` has to
 * match itself; a tokenising index matches whole words and would find neither.
 * The cost is a table scan, which at 3,470 rows and 284 KB of prompt text
 * measures around a millisecond - see `pnpm history-check`, which asserts on
 * it.
 */
function likePattern(search: string): string {
  const escaped = search.replace(/[\\%_]/g, (char) => `\\${char}`)
  return `%${escaped}%`
}

interface Filters {
  where: string
  params: Record<string, string | number>
  /** Bound positionally, ahead of the named parameters. See `readHistorySessions`. */
  ids: string[]
  searching: boolean
}

function buildFilters(query: HistoryQuery, archived: Map<string, ArchiveMatch> | null): Filters {
  const clauses: string[] = []
  const params: Record<string, string | number> = {}
  const ids: string[] = []

  const search = query.search?.trim() ?? ''

  if (search !== '' && archived !== null) {
    // The archive's answer, as a list of ids. Empty is a real answer - nothing
    // said that - and it has to produce no rows rather than no filter, hence
    // the `IN ()` that a zero-length list would not express: the impossible
    // clause is written explicitly.
    ids.push(...archived.keys())
    clauses.push(
      ids.length === 0
        ? '0'
        : `lower(s.session_id) IN (${ids.map(() => '?').join(', ')})`
    )
  } else if (search !== '') {
    params['like'] = likePattern(search)
    // The project counts as well as the prompt. "Every session in that
    // repository" is the same gesture as "the session where I asked about X",
    // and the project dropdown beside this box only answers the first once you
    // already know which project you want - which a history spanning dozens of
    // them is exactly the case you do not. Matched against `project_key`, which
    // is stored lower-cased, so the comparison does not depend on LIKE's
    // ASCII-only case folding.
    params['likeKey'] = likePattern(search.toLowerCase())
    clauses.push(
      `(s.session_id IN (SELECT session_id FROM history_prompts WHERE text LIKE @like ESCAPE '\\')
        OR s.project_key LIKE @likeKey ESCAPE '\\')`
    )
  }

  const project = query.project?.trim()
  if (project !== undefined && project !== '') {
    params['project'] = project.toLowerCase()
    clauses.push('s.project_key = @project')
  }

  if (query.resumableOnly === true) {
    clauses.push('s.transcript_file IS NOT NULL AND s.project_exists = 1')
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
    ids,
    searching: search !== ''
  }
}

/**
 * Most recently active first. `total` is the match count before `limit`.
 *
 * `scope: 'messages'` searches the archive instead of the prompts: FTS5 answers
 * with session ids, and this filters the list to them. The two scopes are kept
 * apart rather than unioned - see `HistorySearchScope` - and the shape of the
 * query is what enforces it, so a caller cannot accidentally get both.
 */
export function readHistorySessions(store: Store, query: HistoryQuery = {}): HistoryPage {
  const started = performance.now()
  const search = query.search?.trim() ?? ''
  const overMessages = query.scope === 'messages' && search !== ''
  const archived = overMessages ? searchArchive(store, search) : null

  const { where, params, ids, searching } = buildFilters(query, archived)
  const limit = Math.max(1, query.limit ?? DEFAULT_LIMIT)

  // Only computed when there is a prompt search to have matched: an unfiltered
  // listing pays nothing for a column it would not show, and a message search
  // already has its match in hand from FTS5.
  const matchColumn =
    searching && archived === null
      ? `, (SELECT p.text FROM history_prompts p
          WHERE p.session_id = s.session_id AND p.text LIKE @like ESCAPE '\\'
          ORDER BY p.seq LIMIT 1) AS match`
      : ''

  // Anonymous parameters first, then the named ones as the final argument -
  // better-sqlite3's own convention for a statement that carries both. The
  // anonymous ones are the archive's session ids, which cannot be named because
  // there is an unknown number of them.
  const rows = store.raw
    .prepare(
      `SELECT s.session_id, s.project, s.prompt_count, s.first_at, s.last_at,
              s.first_prompt, s.transcript_file, s.transcript_bytes,
              s.project_exists${ARCHIVE_COLUMNS}${matchColumn}
       FROM history_sessions s
       ${ARCHIVE_JOIN}
       ${where}
       ORDER BY s.last_at DESC, s.session_id
       LIMIT @limit`
    )
    .all(...ids, { ...params, limit }) as SessionRow[]

  const { total } = store.raw
    .prepare(
      `SELECT COUNT(*) AS total FROM history_sessions s ${ARCHIVE_JOIN} ${where}`
    )
    .get(...ids, params) as { total: number }

  const sessions = rows.map(toSession)
  if (archived !== null) {
    for (const session of sessions) {
      const hit = archived.get(session.sessionId.toLowerCase())
      if (hit !== undefined) session.match = hit.text
    }
  }

  return { sessions, total, tookMs: performance.now() - started }
}

/** Every prompt of one session, in submission order. */
export function readHistoryPrompts(store: Store, sessionId: string): HistoryPrompt[] {
  const rows = store.raw
    .prepare(
      `SELECT seq, session_id, at, text FROM history_prompts
       WHERE session_id = ? ORDER BY seq`
    )
    .all(sessionId) as Array<{ seq: number; session_id: string; at: number; text: string }>

  return rows.map((row) => ({
    sessionId: row.session_id,
    seq: row.seq,
    text: row.text,
    at: row.at
  }))
}

/** The recorded working directories, busiest-most-recent first. */
export function readHistoryProjects(store: Store): HistoryProject[] {
  const rows = store.raw
    .prepare(
      `SELECT project_key,
              MAX(project)      AS project,
              COUNT(*)          AS sessions,
              SUM(prompt_count) AS prompts,
              MAX(last_at)      AS last_at,
              SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                       THEN 1 ELSE 0 END) AS resumable,
              MAX(project_exists) AS exists_flag
       FROM history_sessions
       GROUP BY project_key
       ORDER BY last_at DESC`
    )
    .all() as Array<{
    project: string
    sessions: number
    prompts: number
    last_at: number
    resumable: number
    exists_flag: number
  }>

  return rows.map((row) => ({
    project: row.project,
    name: basename(row.project) || row.project,
    sessions: row.sessions,
    prompts: row.prompts,
    lastAt: row.last_at,
    resumable: row.resumable,
    exists: row.exists_flag === 1
  }))
}

export function historySummary(store: Store, file: string): HistorySummary {
  const totals = store.raw
    .prepare(
      `SELECT COUNT(*)                        AS sessions,
              COALESCE(SUM(prompt_count), 0)  AS prompts,
              COUNT(DISTINCT project_key)     AS projects,
              COALESCE(MAX(last_at), 0)       AS latest_at,
              SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                       THEN 1 ELSE 0 END)     AS resumable
       FROM history_sessions`
    )
    .get() as {
    sessions: number
    prompts: number
    projects: number
    latest_at: number
    resumable: number | null
  }

  return {
    sessions: totals.sessions,
    prompts: totals.prompts,
    projects: totals.projects,
    resumable: totals.resumable ?? 0,
    latestAt: totals.latest_at > 0 ? totals.latest_at : null,
    historyFile: file,
    indexedBytes: historyCursor(store, file)
  }
}

/** One session by id, or null. The resume path's lookup. */
export function readHistorySession(store: Store, sessionId: string): HistorySession | null {
  const row = store.raw
    .prepare(
      `SELECT s.session_id, s.project, s.prompt_count, s.first_at, s.last_at, s.first_prompt,
              s.transcript_file, s.transcript_bytes, s.project_exists${ARCHIVE_COLUMNS}
       FROM history_sessions s ${ARCHIVE_JOIN} WHERE s.session_id = ?`
    )
    .get(sessionId) as SessionRow | undefined
  return row ? toSession(row) : null
}
