import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * `profiles` and `config_snapshots` are not read by any surface yet - they exist
 * so that M3 (profiles) and M5 (snapshot every config write) start from a
 * migrated schema rather than a schema change on a database that already holds
 * a user's data.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

/**
 * A saved launch composition: cwd, overlays, access dirs, model flags. Stored
 * as JSON columns rather than join tables - a profile is edited and launched
 * whole, never queried by its parts, and YAML export (SPEC 3) is a straight
 * serialisation of this row.
 */
export const profiles = sqliteTable(
  'profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    root: text('root').notNull(),
    /** JSON array of project paths composed via `--plugin-dir`. */
    overlays: text('overlays', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /** JSON array of paths passed to `--add-dir`. */
    access: text('access', { mode: 'json' }).$type<string[]>().notNull().default([]),
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),
    agent: text('agent'),
    /** JSON array of MCP server names. */
    mcp: text('mcp', { mode: 'json' }).$type<string[]>().notNull().default([]),
    openingPrompt: text('opening_prompt'),
    /** Launcher ordering; null means unpinned. */
    pinnedOrder: integer('pinned_order'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now)
  },
  (t) => [uniqueIndex('profiles_name_unique').on(t.name)]
)

/**
 * Every project discovery has ever seen. Cached so the launcher paints before
 * the first scan finishes, and so a project that has gone missing can be shown
 * as missing rather than silently vanishing.
 */
export const projects = sqliteTable(
  'projects',
  {
    path: text('path').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['harness', 'repo', 'folder'] }).notNull(),
    harnessPath: text('harness_path'),
    hasClaudeDir: integer('has_claude_dir', { mode: 'boolean' }).notNull().default(false),
    /** JSON `ClaudeInventory`. */
    inventory: text('inventory', { mode: 'json' }).notNull(),
    /** JSON `GitState`, or null for a directory that is not a repo. */
    git: text('git', { mode: 'json' }),
    lastSeenAt: text('last_seen_at').notNull().default(now)
  },
  (t) => [index('projects_harness_idx').on(t.harnessPath)]
)

/**
 * A copy of a config file taken immediately before Helm overwrites it (M5).
 * Content is stored inline: `.claude` files are small, and a snapshot that
 * depends on the file still being on disk is not a snapshot.
 */
export const configSnapshots = sqliteTable(
  'config_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Project the file belongs to; not a foreign key, so a snapshot outlives
     * the project row if the directory is removed. */
    projectPath: text('project_path').notNull(),
    /** Path relative to the project root, e.g. `.claude/settings.json`. */
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    /** sha256 of `content`, so an unchanged write can skip a row. */
    contentHash: text('content_hash').notNull(),
    /** What caused the snapshot: `edit`, `import`, `revert`. */
    reason: text('reason').notNull(),
    createdAt: text('created_at').notNull().default(now)
  },
  (t) => [index('config_snapshots_file_idx').on(t.projectPath, t.filePath, t.createdAt)]
)

/**
 * Every hosted `claude` process Helm has spawned, with how it ended.
 *
 * Written on spawn rather than on exit: a row that exists only once a process
 * has terminated cannot answer "what is running right now", and it loses the
 * session entirely if the app dies first. The cost is that a crash leaves rows
 * claiming to be running, which the next launch reconciles to `lost`.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Passed to the CLI as `-n`; what `/resume` shows later. */
    name: text('name').notNull(),
    cwd: text('cwd').notNull(),
    /** Path of the discovered project, or null for a cwd chosen another way. */
    projectPath: text('project_path'),
    /** The profile this was launched from. Deliberately not a foreign key - a
     * session row is history, and deleting a profile does not unmake it. */
    profileId: integer('profile_id'),
    /** JSON array of the argv after the executable. */
    argv: text('argv', { mode: 'json' }).$type<string[]>().notNull().default([]),
    status: text('status', { enum: ['running', 'exited', 'lost'] })
      .notNull()
      .default('running'),
    startedAt: text('started_at').notNull().default(now),
    endedAt: text('ended_at'),
    durationMs: integer('duration_ms'),
    exitCode: integer('exit_code')
  },
  // M4 lists sessions newest-first across every project, which is the one query
  // this table is going to be asked for at any size.
  (t) => [index('sessions_started_idx').on(t.startedAt), index('sessions_status_idx').on(t.status)]
)

/**
 * Every prompt `~/.claude/history.jsonl` has ever recorded, on any project.
 *
 * A mirror of a file Helm does not own, kept in SQLite so it can be searched
 * and grouped rather than re-parsed per keystroke. `seq` is submission order,
 * assigned by the indexer as lines arrive - the file has no id of its own, and
 * the timestamp is not unique enough to order by on its own.
 */
export const historyPrompts = sqliteTable(
  'history_prompts',
  {
    seq: integer('seq').primaryKey(),
    sessionId: text('session_id').notNull(),
    /** Working directory as recorded, casing and all. */
    project: text('project').notNull(),
    /** Epoch milliseconds. */
    at: integer('at').notNull(),
    text: text('text').notNull()
  },
  // The search is a substring match, which no index can serve - so the index
  // that matters is the one that turns a matched session back into its
  // prompts, and the one that finds a session's opening prompt.
  (t) => [index('history_prompts_session_idx').on(t.sessionId, t.seq)]
)

/**
 * One row per session in `history_prompts`, aggregated, plus what the disk
 * currently says about resuming it.
 *
 * Derived rather than authoritative: everything except the transcript columns
 * is recomputed from `history_prompts`, and the transcript columns are
 * recomputed from `projects/*`. The table exists because the launcher's default
 * view is 799 sessions ordered by recency, and doing that as a GROUP BY on
 * every repaint is work with a known answer.
 */
export const historySessions = sqliteTable(
  'history_sessions',
  {
    sessionId: text('session_id').primaryKey(),
    project: text('project').notNull(),
    /** Lowercased `project`. The same folder gets recorded under more than one
     * casing, and grouping by the raw string splits it in two. */
    projectKey: text('project_key').notNull(),
    promptCount: integer('prompt_count').notNull(),
    firstAt: integer('first_at').notNull(),
    lastAt: integer('last_at').notNull(),
    firstPrompt: text('first_prompt').notNull(),
    /** Null once Claude Code has reaped it; the session is then history-only. */
    transcriptFile: text('transcript_file'),
    transcriptBytes: integer('transcript_bytes'),
    projectExists: integer('project_exists', { mode: 'boolean' }).notNull().default(false)
  },
  (t) => [
    index('history_sessions_last_idx').on(t.lastAt),
    index('history_sessions_project_idx').on(t.projectKey, t.lastAt)
  ]
)

/**
 * How much of the history file has been consumed, so the next pass reads only
 * what has appeared since. Keyed by path: pointing `CLAUDE_CONFIG_DIR` at a
 * different tree is a different cursor, not a corrupt one.
 */
export const historyIndex = sqliteTable('history_index', {
  file: text('file').primaryKey(),
  bytes: integer('bytes').notNull(),
  indexedAt: text('indexed_at').notNull().default(now)
})

/**
 * One assistant message's token usage, out of a transcript under `projects/`.
 *
 * Rows rather than pre-summed buckets. The windows this answers - the 5-hour
 * one aligned with the plan's own reset time, local midnight to now, a rolling
 * 7 days - all slide, and none of them land on an hour boundary, so a bucketed
 * table would be wrong by up to a bucket at every edge. 22,180 rows over the
 * surviving 26 days is small enough that a SUM over an index on `at` is not
 * worth optimising away.
 *
 * The primary key is the transcript row's own uuid, which is what makes the
 * index idempotent: a forked conversation copies its parent's history into a
 * new file, and re-reading a file from zero re-offers rows already counted.
 */
export const usageMessages = sqliteTable(
  'usage_messages',
  {
    uuid: text('uuid').primaryKey(),
    /** Epoch ms. */
    at: integer('at').notNull(),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Split by TTL: a 5-minute write is 1.25x base input, an hour is 2x. */
    cacheWrite5mTokens: integer('cache_write_5m_tokens').notNull().default(0),
    cacheWrite1hTokens: integer('cache_write_1h_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0)
  },
  // Every query this table serves is a range over `at`, grouped by model.
  (t) => [index('usage_messages_at_idx').on(t.at, t.model)]
)

/**
 * How much of each transcript has been consumed. Keyed by path, like
 * `history_index`, so pointing at a different tree is a different cursor rather
 * than a corrupt one.
 */
export const usageIndex = sqliteTable('usage_index', {
  file: text('file').primaryKey(),
  bytes: integer('bytes').notNull(),
  /** Rows taken from this file. Lets a pass report progress without a COUNT. */
  rows: integer('rows').notNull().default(0),
  indexedAt: text('indexed_at').notNull().default(now)
})

/** Single-row-per-key JSON blobs. See `AppSettings` for the key space. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now)
})
