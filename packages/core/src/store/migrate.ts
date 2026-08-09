import type { Database } from 'better-sqlite3'
import { MIGRATIONS } from './migrations.generated'

/**
 * Applies the embedded migration set. Idempotent: each migration's tag is
 * recorded, and an already-recorded tag is skipped.
 *
 * Deliberately not drizzle's `migrate()` - that one resolves a folder of `.sql`
 * files at runtime, which a packaged app cannot rely on. Same generated SQL,
 * same ordering, no filesystem.
 */

const JOURNAL_TABLE = '__helm_migrations'

export interface MigrationOutcome {
  applied: string[]
  alreadyApplied: string[]
}

export function migrate(db: Database): MigrationOutcome {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
      tag TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)

  const done = new Set(
    db
      .prepare(`SELECT tag FROM ${JOURNAL_TABLE}`)
      .all()
      .map((r) => (r as { tag: string }).tag)
  )
  const record = db.prepare(`INSERT INTO ${JOURNAL_TABLE} (tag, applied_at) VALUES (?, ?)`)

  const outcome: MigrationOutcome = { applied: [], alreadyApplied: [] }

  for (const migration of MIGRATIONS) {
    if (done.has(migration.tag)) {
      outcome.alreadyApplied.push(migration.tag)
      continue
    }
    // One transaction per migration: a failure leaves the database on the last
    // complete version rather than half way through a schema change.
    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement)
      record.run(migration.tag, new Date().toISOString())
    })
    run()
    outcome.applied.push(migration.tag)
  }

  return outcome
}

/** Tags this build knows about, in order. Surfaced in the app's about panel. */
export function knownMigrations(): string[] {
  return MIGRATIONS.map((m) => m.tag)
}
