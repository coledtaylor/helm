import type {
  AppSettings,
  CachedProject,
  DiscoveryResult,
  FilesStatus,
  GitState,
  LiveSession,
  Profile,
  RestorableSession,
  RestoreOffer,
  SavedPaneLayout,
  SessionActivityState,
  SessionRecord,
  SessionResources,
  SessionsOverview,
  WriteConfigResult
} from '@helm/core'
import { CLAUDE_TESTED_RANGE } from '../../claude'
import type {
  ClaudeAuth,
  ClaudeStatus,
  EffectiveViewRequest,
  LaunchedProfile,
  LaunchedSession,
  ScanStatus
} from '../../ipc'
import type * as P from '../protocol'

export {
  historyPageFromHost,
  historyQueryForHost,
  historySessionFromHost,
  historySummaryFromHost,
  unreadableUsage,
  usageFromHost
} from './history'
export {
  deliveryFromHost,
  isBackgroundPage,
  logFromHost,
  pluginFromHost,
  uiFromHost,
  withBackgroundReports
} from './plugins'

/**
 * The host's rows and states in the window's vocabulary. Nothing here reaches
 * Node, so main and the window's host adapters share it.
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

/**
 * What each hosted session is holding, field by field. Every nullable field
 * is carried as it came: the host's "could not look" (null) and "nothing
 * there" ([]) stay apart all the way to the pane.
 */
export function resourcesFromHost(sets: readonly P.SessionResources[]): SessionResources[] {
  return sets.map((set) => ({
    id: set.id,
    rootPid: set.rootPid,
    processes:
      set.processes === null
        ? null
        : set.processes.map((process) => ({
            pid: process.pid,
            parentPid: process.parentPid,
            name: process.name,
            commandLine: process.commandLine,
            depth: process.depth,
            ports: process.ports === null ? null : [...process.ports]
          })),
    rootSeen: set.rootSeen,
    ports:
      set.ports === null
        ? null
        : set.ports.map((port) => ({
            port: port.port,
            pid: port.pid,
            process: port.process,
            addresses: [...port.addresses]
          })),
    opaque: set.opaque,
    atMs: set.atMs
  }))
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

/**
 * The settings the host keeps for every client: the folders it scans, the
 * projects pinned out of their harness, and whether setup was finished. Every
 * other setting is Helm's own, the window's, or one Helm tells the host on
 * every connect (`hostSettingsFor`).
 */
export const HOST_WORKSPACE_KEYS = ['scanRoots', 'pinnedProjects', 'firstRunCompletedAt'] as const

export type HostWorkspaceKey = (typeof HOST_WORKSPACE_KEYS)[number]

/** Helm's settings with the host's workspace keys laid over, or Helm's own while there are none. */
export function settingsWithHost(own: AppSettings, host: P.HostSettings | null): AppSettings {
  if (host === null) return own
  return {
    ...own,
    scanRoots: host.scanRoots,
    pinnedProjects: host.pinnedProjects,
    firstRunCompletedAt: host.firstRunCompletedAt
  }
}

/** A window's settings patch, split into what the host keeps and what Helm keeps. */
export function splitSettingsPatch(patch: Partial<AppSettings>): {
  host: P.HostSettingsPatch
  own: Partial<AppSettings>
} {
  const host: P.HostSettingsPatch = {}
  const own: Partial<AppSettings> = { ...patch }
  if (patch.scanRoots !== undefined) host.scanRoots = patch.scanRoots
  if (patch.pinnedProjects !== undefined) host.pinnedProjects = patch.pinnedProjects
  if (patch.firstRunCompletedAt !== undefined) host.firstRunCompletedAt = patch.firstRunCompletedAt
  for (const key of HOST_WORKSPACE_KEYS) delete own[key]
  return { host, own }
}

/** A repository's state: one git answered has no `error` at all, as Helm's own discovery says. */
export function gitStateFromHost(state: P.GitState | null | undefined): GitState | null {
  if (state === null || state === undefined) return null
  const { error, ...rest } = state
  return error === null ? rest : { ...rest, error }
}

/** Git state by project path. */
export function gitStatesFromHost(states: Partial<Record<string, P.GitState | null>>): Record<string, GitState | null> {
  const out: Record<string, GitState | null> = {}
  for (const [path, state] of Object.entries(states)) out[path] = gitStateFromHost(state)
  return out
}

export function discoveryFromHost(result: P.DiscoveryResult): DiscoveryResult {
  return { ...result, projects: result.projects.map((project) => ({ ...project, git: gitStateFromHost(project.git) })) }
}

export function cachedProjectsFromHost(rows: readonly P.CachedProject[]): CachedProject[] {
  return rows.map((row) => ({ ...row, git: gitStateFromHost(row.git) }))
}

/** A folder's git letters, by root-relative path; every path the host names has one. */
export function filesStatusFromHost(status: P.FilesStatus): FilesStatus {
  if (status.files === null) return { ...status, files: null }
  const files: Record<string, P.GitFileState> = {}
  for (const [path, state] of Object.entries(status.files)) if (state !== undefined) files[path] = state
  return { ...status, files }
}

/** A scan's state: a scan that did not fail has no `error` at all, as Helm's own scan says. */
export function scanStatusFromHost(status: P.ScanStatus): ScanStatus {
  return status.error === null ? { running: status.running } : { running: status.running, error: status.error }
}

const AUTH: Record<'true' | 'false', ClaudeAuth> = { true: 'authenticated', false: 'unauthenticated' }

/**
 * What the host found of Claude Code, in the setup pane's words. A host with
 * no Claude Code backend has found nothing about it, which is Unknown - not
 * "not installed" - with the sentence that says why.
 */
export function claudeStatusFromHost(status: P.BackendStatus | undefined): ClaudeStatus {
  if (status === undefined) {
    const why = 'The local host has no Claude Code backend, so whether Claude Code is installed is unknown.'
    return {
      path: null,
      source: null,
      version: null,
      semver: null,
      tested: false,
      testedRange: { ...CLAUDE_TESTED_RANGE },
      configDir: '',
      configDirExists: false,
      auth: 'unknown',
      authSignal: why,
      error: why
    }
  }
  return {
    path: status.path,
    source: status.source,
    version: status.version,
    semver: status.semver,
    tested: status.tested,
    testedRange: status.testedRange,
    configDir: status.configDir ?? '',
    configDirExists: status.configDirExists,
    auth: status.signedIn.state === 'known' ? AUTH[status.signedIn.value ? 'true' : 'false'] : 'unknown',
    authSignal: status.signInSignal,
    error: status.error
  }
}
