import { and, desc, eq, sql } from 'drizzle-orm'
import type { SessionRecord, SessionStatus } from '../types'
import type { Store } from './db'
import { sessions } from './schema'

/**
 * The session log: one row per hosted `claude` process.
 *
 * The host owns the process, so the host owns the record - core just knows the
 * shape and the transitions. There are exactly three: a row is created running,
 * and it leaves that state either because the process exited (`finishSession`)
 * or because the app that was watching it did not survive to see it end
 * (`reconcileRunningSessions`, at the next launch).
 */

export interface NewSession {
  name: string
  cwd: string
  projectPath?: string | null
  profileId?: number | null
  /** Argv after the executable, as spawned. */
  argv?: string[]
}

type Row = typeof sessions.$inferSelect

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    projectPath: row.projectPath,
    profileId: row.profileId,
    argv: row.argv,
    status: row.status as SessionStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    exitCode: row.exitCode
  }
}

export function startSession(store: Store, input: NewSession): SessionRecord {
  const row = store.db
    .insert(sessions)
    .values({
      name: input.name,
      cwd: input.cwd,
      projectPath: input.projectPath ?? null,
      profileId: input.profileId ?? null,
      argv: input.argv ?? [],
      status: 'running'
    })
    .returning()
    .get()
  return toRecord(row)
}

/**
 * Records how a session ended.
 *
 * The duration is measured here rather than by the caller because `started_at`
 * is written by SQLite's clock: subtracting a JS `Date.now()` from it would mix
 * two clocks, and on a machine whose time drifts or steps mid-session that
 * difference shows up as a negative duration.
 *
 * Idempotent - a second call for the same id is ignored, so an exit reported by
 * both the process's own `onExit` and a shutdown sweep does not overwrite the
 * real exit code with the sweep's.
 */
export function finishSession(
  store: Store,
  id: number,
  outcome: { exitCode: number | null }
): SessionRecord | null {
  const row = store.db
    .update(sessions)
    .set({
      status: 'exited',
      exitCode: outcome.exitCode,
      endedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      durationMs: sql`CAST(
        (julianday(strftime('%Y-%m-%dT%H:%M:%fZ','now')) - julianday(${sessions.startedAt}))
        * 86400000 AS INTEGER
      )`
    })
    .where(and(eq(sessions.id, id), eq(sessions.status, 'running')))
    .returning()
    .get()
  return row ? toRecord(row) : null
}

/**
 * Marks sessions that were still running when their host went away.
 *
 * Called once at startup. `ended_at` and `duration_ms` stay null: nobody
 * measured when those processes died, and a guessed duration in a table the
 * launcher
 * reports from is worse than an absent one.
 */
export function reconcileRunningSessions(store: Store): number {
  const rows = store.db
    .update(sessions)
    .set({ status: 'lost' })
    .where(eq(sessions.status, 'running'))
    .returning({ id: sessions.id })
    .all()
  return rows.length
}

export interface SessionQuery {
  limit?: number
  status?: SessionStatus
  /** Only sessions launched against this project. */
  projectPath?: string
}

/** Newest first. */
export function readSessions(store: Store, query: SessionQuery = {}): SessionRecord[] {
  const filters = [
    query.status ? eq(sessions.status, query.status) : undefined,
    query.projectPath ? eq(sessions.projectPath, query.projectPath) : undefined
  ].filter((f) => f !== undefined)

  return store.db
    .select()
    .from(sessions)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(sessions.startedAt), desc(sessions.id))
    .limit(query.limit ?? 200)
    .all()
    .map(toRecord)
}

/** Names currently taken, for `uniqueSessionName` to launch beside. */
export function runningSessionNames(store: Store): string[] {
  return store.db
    .select({ name: sessions.name })
    .from(sessions)
    .where(eq(sessions.status, 'running'))
    .all()
    .map((r) => r.name)
}
