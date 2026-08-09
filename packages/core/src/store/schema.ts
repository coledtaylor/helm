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

/** Single-row-per-key JSON blobs. See `AppSettings` for the key space. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now)
})
