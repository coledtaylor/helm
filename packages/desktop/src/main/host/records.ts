import type {
  LiveSession,
  RestorableSession,
  RestoreOffer,
  SavedPaneLayout,
  SessionActivityState,
  SessionRecord,
  SessionsOverview
} from '@helm/core'
import type { LaunchedSession } from '../../shared/ipc'
import type * as P from './protocol'

/**
 * The host's rows and states in the window's vocabulary.
 *
 * The protocol is backend-neutral: Claude Code's session id is a
 * `conversationId` and a session names its backend. The window still speaks
 * the words it was written in (`claudeSessionId`, `helmSessionId`), so this
 * is where one becomes the other, field by field, and nowhere else.
 */

export function sessionFromHost(record: P.SessionRecord): SessionRecord {
  return {
    id: record.id,
    name: record.name,
    label: record.label,
    cwd: record.cwd,
    branch: record.branch,
    projectPath: record.projectPath,
    profileId: record.profileId,
    argv: record.argv,
    claudeSessionId: record.conversationId,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode
  }
}

export function launchedFromHost(launched: P.LaunchedSession): LaunchedSession {
  return {
    session: sessionFromHost(launched.session),
    overlays: launched.overlays,
    composedInstructions: launched.composedInstructions,
    warnings: launched.warnings
  }
}

export function activityFromHost(states: readonly P.SessionActivityState[]): SessionActivityState[] {
  return states.map((state) => ({
    id: state.id,
    activity: state.activity,
    waitingFor: state.waitingFor,
    claudeSessionId: state.conversationId
  }))
}

function liveFromHost(session: P.LiveSession): LiveSession {
  return {
    helmSessionId: session.hostSessionId,
    pid: session.pid,
    registered: session.registered,
    cwd: session.cwd,
    name: session.name,
    activity: session.activity,
    waitingFor: session.waitingFor,
    statusSinceMs: session.statusSinceMs,
    version: session.version,
    entrypoint: session.entrypoint,
    startedAtMs: session.startedAtMs,
    claudeSessionId: session.conversationId
  }
}

export function overviewFromHost(overview: P.SessionsOverview): SessionsOverview {
  return { sessions: overview.sessions.map(liveFromHost), readAtMs: overview.readAtMs }
}

/**
 * The host's offer, with the pane layout this window last saved: the layout is
 * per device (it stays in Helm's database), and it names each session by the
 * host's row id, which is the id the window's tabs carry.
 */
export function offerFromHost(offer: P.RestoreOffer, layout: SavedPaneLayout | null): RestoreOffer {
  const sessions: RestorableSession[] = offer.sessions.map((session) => ({
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    branch: session.branch,
    profile: session.profile,
    profileGone: session.profileGone,
    lastAt: session.lastAt,
    blocked: session.blocked
  }))
  return { sessions, elsewhere: offer.elsewhere, layout }
}
