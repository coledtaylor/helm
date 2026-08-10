import type {
  AppSettings,
  CachedProject,
  DiscoveryResult,
  GitState,
  HistoryPage,
  HistoryProject,
  HistoryPrompt,
  HistoryQuery,
  HistorySession,
  HistorySummary,
  Profile,
  ProfileDraft,
  SessionRecord,
  ThemePreference
} from '@helm/core'
import type { ProbeOp, TermCreateOptions } from './protocol'

/**
 * The whole renderer <-> main surface, in one place.
 *
 * Every channel is declared here and nowhere else. The preload builds its API
 * from these maps and the main process registers against them, so a channel
 * that is not in this file cannot be sent, and a handler whose payload has
 * drifted from its caller is a type error rather than an `undefined` at
 * runtime. This is what "all communication goes through the typed contract"
 * means in practice - not a convention, a shape the compiler checks.
 *
 * Three categories, because they have genuinely different semantics:
 *   Requests - renderer asks, main answers  (ipcRenderer.invoke)
 *   Sends    - renderer tells, no answer    (ipcRenderer.send)
 *   Events   - main pushes to the renderer  (webContents.send)
 */

export type AppMode = 'dev' | 'portable' | 'installed'

export interface AppInfo {
  version: string
  mode: AppMode
  dataDir: string
  dbFile: string
  /** Migration tags this build applied or found already applied. */
  migrations: string[]
  versions: {
    electron: string
    chrome: string
    node: string
  }
  /**
   * `claude --version`, or null if the CLI was not found. Helm warns and keeps
   * going: the CLI is required to launch a session, not to browse config.
   */
  claudeVersion: string | null
  /** Windows build number; xterm uses it to pick ConPTY quirk handling. */
  windowsBuild: number | null
}

export interface ScanRequest {
  /** Read git state during the scan. A first paint skips it and refreshes after. */
  includeGit?: boolean
}

export interface ScanStatus {
  running: boolean
  /** Set when the last scan failed outright rather than returning errors. */
  error?: string
}

export interface TermCreatedInfo {
  rendererKind: 'webgl' | 'dom'
  cols: number
  rows: number
  unicodeVersion: string
}

export interface StartSessionRequest {
  /** Working directory for the session. Claude Code resolves `.claude/` from it. */
  cwd: string
  /** The discovered project this is, when it is one. Recorded, not used to launch. */
  projectPath?: string | null
  /** Basis for the `-n` name. Made unique against the running sessions. */
  name?: string
  /** Initial grid, from the pane that will host it. */
  cols: number
  rows: number
}

/**
 * Launching a profile is a different request from launching a project: the
 * profile supplies the cwd, the overlays and every flag, so the renderer sends
 * an id and a grid and nothing else. Sending the composition from the renderer
 * would put the argv in the window, where it can drift from what was saved.
 */
export interface LaunchProfileRequest {
  profileId: number
  cols: number
  rows: number
}

/** What a launch composed, for the pane to report before the TUI paints. */
export interface LaunchedProfile {
  session: SessionRecord
  profile: Profile
  /** Plugin namespaces the session was given, e.g. `['atlas']`. */
  overlays: string[]
  /** Whether composed project instructions were passed. */
  composedInstructions: boolean
  /** Non-fatal problems: a missing overlay directory, an empty `.claude/`. */
  warnings: string[]
}

export interface SaveProfileRequest {
  /** Absent to create; present to update in place. */
  id?: number | null
  draft: ProfileDraft
}

export interface SaveProfileResult {
  profile: Profile | null
  /** Field-level problems. Non-empty means nothing was written. */
  problems: string[]
}

export interface ImportProfileResult {
  profile: Profile | null
  /** Set when the user cancelled the file picker. */
  cancelled: boolean
  /** Set when the file was not a profile. */
  error?: string
  /** The name it had to be given because one was taken. */
  renamedTo?: string
}

export interface ExportProfileResult {
  /** Where it was written, or null if the user cancelled. */
  file: string | null
}

/**
 * Reopening a conversation from the session index.
 *
 * Only an id and a grid: the working directory, the argv and whether it is
 * even possible are all decided in the main process from the indexed row.
 * Sending the cwd from the renderer would let a stale list resume a session
 * into the wrong directory, where `--resume` silently finds nothing.
 */
export interface ResumeSessionRequest {
  sessionId: string
  cols: number
  rows: number
}

export interface ResumedSession {
  session: SessionRecord
  /** The indexed row it came from, for the pane to caption before the TUI paints. */
  history: HistorySession
}

export interface CloseSessionRequest {
  id: number
  /**
   * Skip the "this session is still running" confirmation. Set when the caller
   * has already asked - closing the window, for one, where the user answered
   * about all of them at once.
   */
  force?: boolean
}

export interface CloseSessionResult {
  /** False when the user declined the confirmation. */
  closed: boolean
}

// ---------------------------------------------------------------------------
// Renderer -> main, with a response
// ---------------------------------------------------------------------------

export interface IpcRequests {
  'app:info': { request: void; response: AppInfo }

  'settings:read': { request: void; response: AppSettings }
  'settings:write': { request: Partial<AppSettings>; response: AppSettings }

  /** Rows from the last scan, for painting before a fresh one finishes. */
  'discovery:cached': { request: void; response: CachedProject[] }
  'discovery:scan': { request: ScanRequest; response: DiscoveryResult }

  /** Best guesses for a first-run scan root; may be empty. */
  'roots:suggest': { request: void; response: string[] }
  /** Native directory picker. Returns the roots after the addition. */
  'roots:add': { request: void; response: string[] }
  'roots:remove': { request: { path: string }; response: string[] }

  /** What `theme: 'system'` currently resolves to on this machine. */
  'theme:resolved': { request: void; response: ResolvedTheme }

  /** Open a path in the OS file manager. */
  'shell:showItem': { request: { path: string }; response: void }

  /**
   * Spawn a hosted `claude`. Rejects with a readable message when the CLI
   * cannot be found or the pty will not open - the renderer has nowhere else to
   * learn that, and a tab holding a terminal that never started is worse than
   * no tab.
   */
  'session:start': { request: StartSessionRequest; response: SessionRecord }
  /** Terminate and forget. Confirms first if the process is still alive. */
  'session:close': { request: CloseSessionRequest; response: CloseSessionResult }
  /** Sessions this main process is currently hosting, for a renderer reload. */
  'session:list': { request: void; response: SessionRecord[] }

  'profile:list': { request: void; response: Profile[] }
  /** Create or update. Returns the problems instead of throwing for a draft
   * the form should show errors against rather than a dialog. */
  'profile:save': { request: SaveProfileRequest; response: SaveProfileResult }
  'profile:delete': { request: { id: number }; response: { deleted: boolean } }
  /** Rewrites the pin order from the given ids; anything omitted is unpinned. */
  'profile:pin': { request: { ids: number[] }; response: Profile[] }
  /** Native save dialog, then the YAML. */
  'profile:export': { request: { id: number }; response: ExportProfileResult }
  'profile:import': { request: void; response: ImportProfileResult }
  /**
   * Synthesise the overlays and spawn. Rejects with a readable message for the
   * same reason `session:start` does.
   */
  'profile:launch': { request: LaunchProfileRequest; response: LaunchedProfile }

  /**
   * The session index over `~/.claude/history.jsonl` (M4). Read-only: Helm
   * mirrors that file and never writes to it.
   */
  'history:summary': { request: void; response: HistorySummary }
  'history:sessions': { request: HistoryQuery; response: HistoryPage }
  'history:prompts': { request: { sessionId: string }; response: HistoryPrompt[] }
  'history:projects': { request: void; response: HistoryProject[] }
  /** Forces a pass now. The index also keeps itself current; this is the button. */
  'history:refresh': { request: void; response: HistorySummary }
  /**
   * Spawns `claude --resume <id>` in the directory history recorded. Rejects
   * with a readable sentence when the transcript or the directory has gone,
   * rather than opening a tab that prints "No conversation found" and exits.
   */
  'history:resume': { request: ResumeSessionRequest; response: ResumedSession }

  /** The terminal pane's clipboard, routed through Electron rather than the
   * async DOM Clipboard API, which needs a permission prompt and a focused
   * document - neither of which a hosted TUI can rely on. */
  'clipboard:read': { request: void; response: string }
  'clipboard:write': { request: string; response: void }
}

export type ResolvedTheme = 'light' | 'dark'

// ---------------------------------------------------------------------------
// Renderer -> main, fire and forget
// ---------------------------------------------------------------------------

export interface IpcSends {
  /** The renderer has mounted and can receive events. */
  'renderer:ready': void

  /** Terminal surface. High frequency, so one-way by design - a promise per
   * keystroke would put an IPC round trip in the echo path Spike C measured. */
  'pty:input': string
  'pty:resize': { cols: number; rows: number }
  'term:created': TermCreatedInfo
  'term:resized': void

  /** The app's equivalents, addressed to one session. Same reasoning. */
  'session:input': { id: number; data: string }
  'session:resize': { id: number; cols: number; rows: number }
  /**
   * Which session the user is actually looking at, or null for a non-terminal
   * tab. Only the renderer knows this, and the main process needs it to decide
   * whether an exit is worth a notification.
   */
  'session:focus': { id: number | null }

  /** Spike harness: the renderer's answer to a `probe:req`. */
  'probe:res': { id: number; value: unknown }
}

// ---------------------------------------------------------------------------
// Main -> renderer
// ---------------------------------------------------------------------------

export interface IpcEvents {
  'discovery:updated': DiscoveryResult
  /**
   * Git state only, keyed by project path. Pushed when the window regains
   * focus: the renderer cannot detect that reliably (a window raised behind the
   * app never fires a DOM `focus`, and `visibilitychange` does not fire for a
   * merely-obscured window), but the main process is told directly.
   */
  'git:updated': Record<string, GitState | null>
  'scan:status': ScanStatus
  'settings:changed': AppSettings
  /** The whole list after any write, so every surface showing profiles agrees
   * without each of them refetching. */
  'profiles:changed': Profile[]
  'theme:changed': { preference: ThemePreference; resolved: ResolvedTheme }
  /**
   * The session index moved. Pushed rather than polled: the file is shared
   * with every `claude` on the machine, so the change that matters most is the
   * one Helm did not cause.
   */
  'history:changed': HistorySummary

  'term:create': TermCreateOptions
  'term:write': string
  'term:resize': { cols: number; rows: number }

  /** Process output, addressed to the pane hosting that session. */
  'session:data': { id: number; data: string }
  /** The finished row, exit code and measured duration included. */
  'session:exit': SessionRecord
  /** Bring a session's tab forward - sent when its exit notification is clicked. */
  'session:activate': { id: number }

  /** Spike harness: main asks the renderer to inspect the live terminal. */
  'probe:req': { id: number; req: ProbeOp }
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

export type RequestChannel = keyof IpcRequests
export type RequestPayload<K extends RequestChannel> = IpcRequests[K]['request']
export type RequestResult<K extends RequestChannel> = IpcRequests[K]['response']

export type SendChannel = keyof IpcSends
export type SendPayload<K extends SendChannel> = IpcSends[K]

export type EventChannel = keyof IpcEvents
export type EventPayload<K extends EventChannel> = IpcEvents[K]

/** The object the preload exposes. The renderer sees exactly this and nothing
 * else - no `ipcRenderer`, no `require`, no Node globals. */
export interface HelmBridge {
  invoke<K extends RequestChannel>(
    channel: K,
    ...args: RequestPayload<K> extends void ? [] : [payload: RequestPayload<K>]
  ): Promise<RequestResult<K>>

  send<K extends SendChannel>(
    channel: K,
    ...args: SendPayload<K> extends void ? [] : [payload: SendPayload<K>]
  ): void

  /** Returns an unsubscribe function. */
  on<K extends EventChannel>(channel: K, listener: (payload: EventPayload<K>) => void): () => void
}

/**
 * Channel name lists, used by the preload to build the bridge.
 *
 * Written as `Record<Channel, true>` rather than an array so the compiler
 * enforces both directions: a channel added to the types but not listed here is
 * a missing property, and a name listed here that is not a channel is an excess
 * property. An array with `satisfies` would only catch the second.
 */
export const REQUEST_CHANNELS = Object.keys({
  'app:info': true,
  'settings:read': true,
  'settings:write': true,
  'discovery:cached': true,
  'discovery:scan': true,
  'roots:suggest': true,
  'roots:add': true,
  'roots:remove': true,
  'theme:resolved': true,
  'shell:showItem': true,
  'session:start': true,
  'session:close': true,
  'session:list': true,
  'profile:list': true,
  'profile:save': true,
  'profile:delete': true,
  'profile:pin': true,
  'profile:export': true,
  'profile:import': true,
  'profile:launch': true,
  'history:summary': true,
  'history:sessions': true,
  'history:prompts': true,
  'history:projects': true,
  'history:refresh': true,
  'history:resume': true,
  'clipboard:read': true,
  'clipboard:write': true
} satisfies Record<RequestChannel, true>) as RequestChannel[]

export const SEND_CHANNELS = Object.keys({
  'renderer:ready': true,
  'pty:input': true,
  'pty:resize': true,
  'term:created': true,
  'term:resized': true,
  'session:input': true,
  'session:resize': true,
  'session:focus': true,
  'probe:res': true
} satisfies Record<SendChannel, true>) as SendChannel[]

export const EVENT_CHANNELS = Object.keys({
  'discovery:updated': true,
  'git:updated': true,
  'scan:status': true,
  'settings:changed': true,
  'profiles:changed': true,
  'theme:changed': true,
  'history:changed': true,
  'term:create': true,
  'term:write': true,
  'term:resize': true,
  'session:data': true,
  'session:exit': true,
  'session:activate': true,
  'probe:req': true
} satisfies Record<EventChannel, true>) as EventChannel[]
