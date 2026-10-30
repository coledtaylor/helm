import type {
  HistoryPage,
  HistoryQuery,
  HistorySession,
  HistorySummary,
  LiveSession,
  Profile,
  RestorableSession,
  RestoreOffer,
  SavedPaneLayout,
  SessionActivityState,
  SessionRecord,
  SessionsOverview,
  UsageSnapshot,
  WriteConfigResult
} from '@helm/core'
import type { EffectiveViewRequest, LaunchedProfile, LaunchedSession } from '../../shared/ipc'
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

/** A saved profile: the protocol's and the window's are the same fields. */
export function profileFromHost(profile: P.Profile): Profile {
  return {
    id: profile.id,
    name: profile.name,
    root: profile.root,
    overlays: profile.overlays,
    access: profile.access,
    model: profile.model,
    effort: profile.effort,
    permissionMode: profile.permissionMode,
    agent: profile.agent,
    mcp: profile.mcp,
    openingPrompt: profile.openingPrompt,
    pinnedOrder: profile.pinnedOrder,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

export function launchedProfileFromHost(launched: P.LaunchedProfile): LaunchedProfile {
  return {
    session: sessionFromHost(launched.session),
    profile: profileFromHost(launched.profile),
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

/** What the history index holds; "the record could be read" is no `error` at all. */
export function historySummaryFromHost(summary: P.HistorySummary): HistorySummary {
  return {
    sessions: summary.sessions,
    prompts: summary.prompts,
    projects: summary.projects,
    resumable: summary.resumable,
    latestAt: summary.latestAt,
    historyFile: summary.historyFile,
    indexedBytes: summary.indexedBytes,
    ...(summary.error === null ? {} : { error: summary.error })
  }
}

/**
 * A conversation in the host's index. Every one the window lists is Claude
 * Code's, so the backend is not carried; a listing with no search has no
 * `match` at all, as Helm's own index answers.
 */
export function historySessionFromHost(session: P.HistorySession): HistorySession {
  return {
    sessionId: session.sessionId,
    project: session.project,
    projectName: session.projectName,
    promptCount: session.promptCount,
    firstAt: session.firstAt,
    lastAt: session.lastAt,
    firstPrompt: session.firstPrompt,
    title: session.title,
    titleFallback: session.titleFallback,
    label: session.label,
    transcriptFile: session.transcriptFile,
    transcriptBytes: session.transcriptBytes,
    projectExists: session.projectExists,
    archive: session.archive,
    archivedMessages: session.archivedMessages,
    ...(session.match === null ? {} : { match: session.match })
  }
}

export function historyPageFromHost(page: P.HistoryPage): HistoryPage {
  return { sessions: page.sessions.map(historySessionFromHost), total: page.total, tookMs: page.tookMs }
}

/** The window's query, with every field it left out said as null. */
export function historyQueryForHost(query: HistoryQuery): P.HistoryQuery {
  return {
    search: query.search ?? null,
    scope: query.scope ?? null,
    project: query.project ?? null,
    resumableOnly: query.resumableOnly ?? null,
    limit: query.limit ?? null
  }
}

/**
 * The reading the status bar shows: `backend`'s, out of the host's one per
 * backend. A host with none for it has not read any, which is a reading that
 * paints nothing and says why, never a zero.
 */
export function usageFromHost(readings: readonly P.UsageSnapshot[], backend: string): UsageSnapshot {
  const reading = readings.find((candidate) => candidate.backend === backend)
  if (reading === undefined) {
    return unreadableUsage('The local host has no usage reading for Claude Code.')
  }
  return {
    file: reading.file,
    fetchedAtMs: reading.fetchedAtMs,
    limits: reading.limits,
    problem: reading.problem,
    spend: reading.spend
  }
}

/** A reading of nothing, with the sentence that says why. */
export function unreadableUsage(detail: string): UsageSnapshot {
  return { file: '', fetchedAtMs: null, limits: [], problem: { kind: 'unreadable', detail }, spend: null }
}

/**
 * A config write's answer: a write with no conflict or no other refusal has
 * neither at all, as Helm's own writer answers.
 */
export function writeConfigResultFromHost(result: P.WriteConfigResult): WriteConfigResult {
  return {
    ok: result.ok,
    file: result.file,
    snapshotId: result.snapshotId,
    unchanged: result.unchanged,
    ...(result.conflict === null ? {} : { conflict: result.conflict }),
    ...(result.error === null ? {} : { error: result.error })
  }
}

/** The window's request for an effective view, with every field it left out said. */
export function effectiveRequestForHost(request: EffectiveViewRequest): P.EffectiveViewRequest {
  return {
    profileId: request.profileId ?? null,
    cwd: request.cwd ?? null,
    overlays: request.overlays ?? []
  }
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
