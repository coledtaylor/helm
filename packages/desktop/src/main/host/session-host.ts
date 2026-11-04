import type {
  LostSession,
  PluginSessionFacts,
  RestoreOffer,
  SessionActivityState,
  SessionRecord,
  SessionRegistryEntry,
  SessionsOverview
} from '@helm/core'
import type { BrowserOpener } from '../browser'
import type {
  BrowserShare,
  CloseSessionRequest,
  CloseSessionResult,
  LaunchedProfile,
  LaunchedSession,
  LaunchProfileRequest,
  LaunchSessionRequest,
  QuitAnswer,
  RenameSessionRequest,
  RestoreSessionsRequest,
  RestoreSessionsResult,
  ResumedSession,
  ResumeSessionRequest,
  StartSessionRequest
} from '../../shared/ipc'

/**
 * The shapes main's mirror of the local host's sessions takes
 * (`host/sessions.ts`), and the questions it asks before a session ends
 * (`host/confirm.ts`).
 */

/**
 * Optional taps for the check drivers.
 *
 * The app passes none. They exist because the two things this milestone has to
 * prove that leave no trace anywhere else - what a hosted session printed, and
 * whether an exit was judged worth a notification - are decided here and then
 * forgotten. A driver that asserted on screenshots instead would be asserting
 * on the wrong thing.
 */
export interface SessionObserver {
  onOutput?: (id: number, chunk: string) => void
  /** Called only when a notification was actually shown. */
  onNotified?: (record: SessionRecord) => void
}

/** A question that must be answered before a live session is ended. */
export interface ConfirmRequest {
  kind: 'close-session' | 'quit'
  message: string
  detail: string
  /**
   * What the agreeing button says. Carried on the request rather than derived
   * by each implementation, so the Helm dialog and the native fallback cannot
   * word the same decision two different ways.
   */
  confirmLabel: string
  /** The quit question's Keep running and quit; absent from a tab's close question. */
  keepLabel?: string
  /** The sessions the answer decides the fate of. */
  sessions: SessionRecord[]
  /** Those on hosts on other computers, by what their tab says and the host's name, listed after `sessions`. */
  otherNames?: readonly string[]
}

/** How the user is asked before Helm quits with sessions in the local host it would end. */
export type QuitConfirm = (request: ConfirmRequest) => Promise<QuitAnswer>

/**
 * How the user is asked. Injected rather than called directly so the driver can
 * answer it: a native modal has no automation surface, and a check that leaves
 * one open on screen also leaves it in the way of the app's own shutdown.
 */
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

export interface SessionHost {
  start: (req: StartSessionRequest) => Promise<SessionRecord>
  /**
   * A session a plugin asked for and the user agreed to: a folder, a name and
   * a first message, said once as the session's opening prompt.
   */
  startWithPrompt: (req: { cwd: string; name: string; prompt: string; cols: number; rows: number }) => Promise<SessionRecord>
  /**
   * The new-session launcher's launch: a folder, a profile or none, an explicit
   * permission mode, and optionally a conversation to reopen there.
   */
  launch: (req: LaunchSessionRequest) => Promise<LaunchedSession>
  /** Synthesises the profile's overlays, then spawns against them. */
  launchProfile: (req: LaunchProfileRequest) => Promise<LaunchedProfile>
  /** Reopens a conversation from the history index in a new tab. */
  resume: (req: ResumeSessionRequest) => Promise<ResumedSession>
  /**
   * Reopens a conversation a crash took, as it was: in its own folder, with its
   * own profile and permission mode, under the name its tab had.
   */
  restore: (lost: LostSession, grid: { cols: number; rows: number }) => Promise<LaunchedSession>
  close: (req: CloseSessionRequest) => Promise<CloseSessionResult>
  /** Helm's own label for a tab. Never rewrites the `-n` name. */
  rename: (req: RenameSessionRequest) => SessionRecord
  /** Sessions this process is hosting, running or exited-but-not-yet-closed. */
  list: () => SessionRecord[]
  /**
   * Settles once `list` can be answered: once the first connection to the
   * local host has listed its sessions, or failed to.
   */
  settled: () => Promise<void>
  input: (id: number, data: string) => void
  resize: (id: number, cols: number, rows: number) => void
  /** The grid the pane last reported, which is what the pty is actually at. */
  grid: (id: number) => { cols: number; rows: number } | null
  /** OS process id, for asserting a session is really gone. */
  pid: (id: number) => number | null
  /**
   * The conversation a running session is in, as Claude Code's registry says,
   * written to its row when it moves - which a `/clear` does. What a restore
   * after a crash reopens.
   */
  noteConversation: (id: number, conversationId: string) => void
  /**
   * The session a bearer token was minted for, or null.
   *
   * **The whole of attribution at Helm's endpoint**, and it is answered from
   * this map rather than from bookkeeping of its own because this map is what
   * owns a token's lifetime: the same entry that hands the token out is the one
   * that revokes it when the session ends, so an answer here cannot outlive the
   * session it names. A caller never says which session it is; the token that
   * arrived does, and this is where that becomes a row.
   *
   * Null for an unknown token, for a session that has ended, and for a session
   * whose tools were never registered - all three are "Helm has no session for
   * this", which is the only honest answer to a token it does not know.
   */
  tokenHolder: (token: string) => SessionRecord | null
  /**
   * A running session's identity at the browser endpoint, for the user to
   * share a page with - or null for one that has ended or was started without
   * the browser tools.
   *
   * The other direction from `tokenHolder`, and the token goes no further than
   * the browser host it is handed to: the window names a session by its id,
   * and this is where an id becomes the identity the tools check.
   */
  browserOpener: (id: number) => BrowserOpener | null
  /** Every session `browserOpener` answers for, by id and label: the share menu. */
  browserSessions: () => BrowserShare[]
  /**
   * Every session started since Helm opened, running or ended, oldest first,
   * as a plugin may know it: by the id its tool calls carry, never by its row.
   * An ended session stays after its tab closes, up to a bounded number.
   */
  pluginSessions: () => PluginSessionFacts[]
  /**
   * Called whenever the set of hosted sessions changes - a spawn, an exit, a
   * close - so the activity poller re-reads at once instead of on its next tick.
   *
   * A callback rather than a direct call because the poller is created *after*
   * this host (it needs the window), and because this file has no business
   * knowing what else cares that a session started.
   */
  onChanged: (listener: () => void) => void
  /**
   * The sessions on screen - the front tab of each pane showing one. Decides
   * whether an exit notifies: an exit in a pane somebody is looking at needs
   * no toast to be seen.
   */
  setFocus: (ids: readonly number[]) => void
  runningCount: () => number
  /** Asks about every still-running session at once. True means go ahead. */
  confirmCloseAll: () => Promise<boolean>
  /** Synchronous teardown for app quit. */
  shutdown: () => void
}

/** Putting back what the host lost: its offer, and reopening what was asked for. */
export interface RestoreService {
  /** What there is to reopen, or null when there is nothing or it was answered. */
  offer: () => RestoreOffer | null | Promise<RestoreOffer | null>
  /**
   * Reopens the sessions asked for, one at a time, and answers the offer.
   * Asking for none is "not now".
   */
  restore: (req: RestoreSessionsRequest) => Promise<RestoreSessionsResult>
}

/** What each session is doing, as the host read it from the agent's own signals. */
export interface ActivityService {
  /** Everything currently known, for a renderer that has just (re)mounted. */
  states: () => SessionActivityState[]
  /** Every live Claude Code session on the machine, Helm's own marked. */
  overview: () => SessionsOverview
  /** Re-read now and push if anything moved. */
  refresh: () => void
  /** The raw records behind the current pass, for the check driver. */
  entries: () => SessionRegistryEntry[]
  stop: () => void
}
