import { eq } from 'drizzle-orm'
import { PERMISSION_MODES, type PermissionMode, type SessionRecord, type SessionStatus } from '../types'
import type { Store } from './db'
import { sessions } from './schema'

/**
 * The session log: one row per `claude` process an earlier version of Helm ran
 * in its own process. Nothing writes it now; sessions run in the local host,
 * which keeps its own. A row that earlier version left claiming to be running
 * is marked lost once, at the next start (`reconcileRunningSessions`).
 */

/**
 * A session the previous run left claiming to be running, as the next one
 * found it: the row, and the two facts a restore needs that a tab does not.
 */
export interface LostSession {
  record: SessionRecord
  /** The conversation it was last in - after a `/clear`, not the one it began. */
  conversationId: string | null
  permissionMode: PermissionMode | null
}

type Row = typeof sessions.$inferSelect

function toRecord(row: Row): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    cwd: row.cwd,
    branch: row.branch,
    projectPath: row.projectPath,
    profileId: row.profileId,
    argv: row.argv,
    claudeSessionId: row.claudeSessionId,
    status: row.status as SessionStatus,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    exitCode: row.exitCode
  }
}

function permissionModeOf(value: string | null): PermissionMode | null {
  return value !== null && (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as PermissionMode)
    : null
}

/**
 * Marks sessions that were still running when their host went away, and
 * returns them, oldest first.
 *
 * Called once at startup. `ended_at` and `duration_ms` stay null: nobody
 * measured when those processes died, and a guessed duration in a table the
 * launcher
 * reports from is worse than an absent one. What is returned is what the
 * crash took, which is what the restore offer is made of.
 */
export function reconcileRunningSessions(store: Store): LostSession[] {
  const rows = store.db
    .update(sessions)
    .set({ status: 'lost' })
    .where(eq(sessions.status, 'running'))
    .returning()
    .all()
  return rows
    .sort((a, b) => a.id - b.id)
    .map((row) => ({
      record: toRecord(row),
      conversationId: row.lastClaudeSessionId ?? row.claudeSessionId,
      // Read tolerantly: a mode a later CLI dropped is a row to reopen asking
      // first, not one to refuse.
      permissionMode: permissionModeOf(row.permissionMode)
    }))
}
