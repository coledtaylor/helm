import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrate, type MigrationOutcome } from './migrate'
import * as schema from './schema'

export type HelmDatabase = BetterSQLite3Database<typeof schema>

export interface OpenStoreOptions {
  /** Absolute path to the database file, or `:memory:` for tests. */
  file: string
  /**
   * Called with every statement the driver prepares. Off unless something is
   * being diagnosed - and a sink rather than a boolean, because where a log
   * line should go is the host's decision, not core's.
   *
   * Typed the way better-sqlite3 declares it (`console.log`-shaped), so a
   * caller can pass `console.log` directly.
   */
  onStatement?: ((message?: unknown, ...rest: unknown[]) => void) | undefined
}

export interface Store {
  db: HelmDatabase
  /** The driver handle, for pragmas and the migrator. */
  raw: Database.Database
  file: string
  migrations: MigrationOutcome
  close: () => void
}

/**
 * Opens the database, applies pragmas, and migrates it forward. Callers hand in
 * the path: `core` has no opinion about where an app puts its data, which is
 * what lets the portable and installed layouts differ without touching this
 * file.
 */
export function openStore(opts: OpenStoreOptions): Store {
  const inMemory = opts.file === ':memory:'
  if (!inMemory) mkdirSync(dirname(opts.file), { recursive: true })

  const raw = new Database(opts.file, opts.onStatement ? { verbose: opts.onStatement } : {})

  // WAL lets a read (the launcher repainting) proceed while a write (a scan
  // landing) is in flight. It has no meaning for an in-memory database.
  if (!inMemory) raw.pragma('journal_mode = WAL')
  // WAL's durability knob: NORMAL fsyncs at checkpoints rather than at every
  // commit. The cost of losing the last transaction to a power cut is one
  // rescan, which is cheap; the cost of a fsync per commit is a visibly slower
  // scan write-back.
  raw.pragma('synchronous = NORMAL')
  raw.pragma('foreign_keys = ON')
  // Do not fail instantly if another connection holds the write lock.
  raw.pragma('busy_timeout = 5000')

  const migrations = migrate(raw)
  const db = drizzle(raw, { schema })

  return {
    db,
    raw,
    file: opts.file,
    migrations,
    close: () => raw.close()
  }
}
