import {
  sessionLabel,
  type AppSettings,
  type HistorySession,
  type SavedPaneLayout,
  type SessionActivityState,
  type SessionRecord,
  type SessionsOverview
} from '@helm/core'
import type { ActivityService } from '../activity'
import type { RestoreService } from '../restore'
import type { Confirm, SessionHost } from '../sessions'
import type { EventChannel, EventPayload } from '../../shared/ipc'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import { activityFromHost, launchedFromHost, offerFromHost, overviewFromHost, sessionFromHost } from './records'
import type { TerminalStreams } from './streams'

/**
 * Helm's sessions when they run in the local host: the same `SessionHost`
 * the window has always talked to, answered by the host over the protocol.
 *
 * The host owns each session's process, its row and its terminal; this side
 * keeps what the window shows - the tabs it lists, as the host last said -
 * and carries each running session's terminal on a stream (`streams.ts`).
 *
 * What stays Helm's own, by design (P5): the confirmation before a running
 * session is ended, which Helm asks in its window and then tells the host to
 * end the session without asking again; and the notification for an exit
 * nobody saw, which the host judges from what this client says it can see
 * and Helm shows.
 *
 * Not through the host yet, and refused with one sentence rather than run
 * here: a launch with a saved profile and a session a plugin starts. Agent
 * tools are not given to these sessions, so nothing answers for a token.
 */

/** The one backend Helm launches. */
export const CLAUDE_CODE_BACKEND = 'claude-code'

const TURN_OFF = 'turn off “Run sessions in the local host” in Settings to use it.'

export const PROFILE_REFUSED = `Launching with a saved profile is not available through the local host yet; ${TURN_OFF}`
export const PLUGIN_START_REFUSED = `A plugin starting a session is not available through the local host yet; ${TURN_OFF}`

/**
 * What Helm writes to the host on every connect: the `claude` its sessions
 * run - the one chosen in Settings, or the one Helm finds - and the shell a
 * terminal opens.
 */
export function hostSettingsFor(settings: AppSettings, discovered: string | null): P.HostSettingsPatch {
  const claude = settings.claudePath ?? discovered
  return {
    ...(claude === null ? {} : { backendPaths: { [CLAUDE_CODE_BACKEND]: claude } }),
    terminalShell: settings.terminalShell
  }
}

export type Emit = <K extends EventChannel>(channel: K, payload: EventPayload<K>) => void

export interface HostSessionsDeps {
  link: HostLink
  streams: TerminalStreams
  /** Sends an event to the window. */
  emit: Emit
  confirm: Confirm
  /** Shows the OS notification for a session that ended where nobody saw it. */
  notify: (record: SessionRecord) => void
  /** Whether Helm's window is in front, so what is on screen is seen at all. */
  windowFocused: () => boolean
  /** The pane layout the last run saved, which the restore offer is placed by. */
  layout: SavedPaneLayout | null
  /** A conversation in Helm's history index, for what a resume says it reopened. */
  history: (sessionId: string) => HistorySession | null
  /** After the host's session activity or overview moved, for plugins listing sessions. */
  onActivityChange?: () => void
  log: (line: string) => void
}

export interface HostSessions {
  sessions: SessionHost
  restore: RestoreService
  activity: ActivityService
  /** The window gained or lost focus: what its user can see has changed. */
  refocus: () => void
}

const isRunning = (record: SessionRecord): boolean => record.status === 'running'

export function createHostSessions(deps: HostSessionsDeps): HostSessions {
  const { link, streams } = deps
  /** The tabs: every session the host listed or started, until its tab is closed. */
  const records = new Map<number, SessionRecord>()
  const grids = new Map<number, { cols: number; rows: number }>()
  let focused: readonly number[] = []
  const changed = new Set<() => void>()
  let states: SessionActivityState[] = []
  let overview: SessionsOverview = { sessions: [], readAtMs: 0 }
  let subscriptions: HostSubscription[] = []

  const announce = (): void => {
    for (const listener of changed) listener()
  }

  const host = (): Promise<HostConnection> => link.connection()

  /** A session the window should show: listed, kept, and its terminal carried. */
  const adopt = (record: SessionRecord): SessionRecord => {
    records.set(record.id, record)
    if (isRunning(record)) streams.open('session:data', record.id)
    return record
  }

  const sendFocus = (): void => {
    const connection = link.current()
    if (connection === null) return
    // A window that is not in front shows nothing anybody is watching.
    const ids = deps.windowFocused() ? [...focused] : []
    connection.request('session:focus', { ids }).catch((error: unknown) => {
      deps.log(`host: session:focus was not taken (${(error as Error).message})`)
    })
  }

  const onExit = (row: P.SessionRecord): void => {
    const record = sessionFromHost(row)
    streams.close('session:data', record.id)
    // A session whose tab was closed has nobody to tell.
    if (!records.has(record.id)) return
    records.set(record.id, record)
    deps.emit('session:exit', record)
    announce()
  }

  link.onConnected(async (connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    const failed = (channel: string) => (error: Error) => deps.log(`host: ${channel} ended (${error.message})`)
    subscriptions = [
      connection.subscribe('session:exit', { event: onExit, error: failed('session:exit') }),
      connection.subscribe('session:notify', {
        event: (row) => {
          const record = sessionFromHost(row)
          if (records.has(record.id)) deps.notify(record)
        },
        error: failed('session:notify')
      }),
      connection.subscribe('session:activate', {
        event: ({ id }) => deps.emit('session:activate', { id }),
        error: failed('session:activate')
      }),
      connection.subscribe('session:activity', {
        snapshot: (next) => setStates(next),
        event: (next) => setStates(next),
        error: failed('session:activity')
      }),
      connection.subscribe('sessions:overview', {
        snapshot: (next) => setOverview(next),
        event: (next) => setOverview(next),
        error: failed('sessions:overview')
      })
    ]
    for (const row of await connection.request('session:list', null)) adopt(sessionFromHost(row))
    announce()
    sendFocus()
  })

  function setStates(next: readonly P.SessionActivityState[]): void {
    states = activityFromHost(next)
    deps.emit('session:activity', states)
    deps.onActivityChange?.()
  }

  function setOverview(next: P.SessionsOverview): void {
    overview = overviewFromHost(next)
    deps.emit('sessions:overview', overview)
    deps.onActivityChange?.()
  }

  const running = (): SessionRecord[] => [...records.values()].filter(isRunning)

  const sessions: SessionHost = {
    async start(req) {
      const connection = await host()
      const row = await connection.request('session:start', {
        cwd: req.cwd,
        projectPath: req.projectPath ?? null,
        name: req.name ?? null,
        backend: CLAUDE_CODE_BACKEND,
        profileId: null,
        overlays: null,
        extraFolders: null,
        model: null,
        effort: null,
        agent: null,
        permissionMode: null,
        openingPrompt: null,
        cols: req.cols,
        rows: req.rows
      })
      const record = adopt(sessionFromHost(row))
      announce()
      return record
    },

    startWithPrompt: () => Promise.reject(new Error(PLUGIN_START_REFUSED)),

    async launch(req) {
      if (req.profileId !== null) throw new Error(PROFILE_REFUSED)
      const connection = await host()
      const launched = launchedFromHost(
        await connection.request('session:launch', {
          cwd: req.cwd,
          projectPath: req.projectPath ?? null,
          name: req.name ?? null,
          profileId: null,
          permissionMode: req.permissionMode,
          resume: req.resume,
          backend: CLAUDE_CODE_BACKEND,
          cols: req.cols,
          rows: req.rows
        })
      )
      adopt(launched.session)
      announce()
      return launched
    },

    launchProfile: () => Promise.reject(new Error(PROFILE_REFUSED)),

    async resume(req) {
      const connection = await host()
      const resumed = await connection.request('history:resume', {
        sessionId: req.sessionId,
        cols: req.cols,
        rows: req.rows
      })
      const session = adopt(sessionFromHost(resumed.session))
      announce()
      // What the window's history pane knows the conversation as; the host's
      // index reads the same history file.
      const history = deps.history(req.sessionId) ?? (resumed.history as unknown as HistorySession)
      return { session, history }
    },

    // A crash's sessions are offered back by the host (`restore` below).
    restore: () => Promise.reject(new Error('Sessions from before Helm closed are reopened through the local host.')),

    async close(req) {
      const entry = records.get(req.id)
      if (entry === undefined) return { closed: true }
      if (isRunning(entry) && req.force !== true) {
        const agreed = await deps.confirm({
          kind: 'close-session',
          message: `“${sessionLabel(entry)}” is still running.`,
          detail: `Closing the tab ends the Claude Code session in ${entry.cwd}.`,
          confirmLabel: 'End session',
          sessions: [entry]
        })
        if (!agreed) return { closed: false }
      }
      const current = records.get(req.id)
      if (current === undefined) return { closed: true }
      if (isRunning(current)) {
        // Helm has asked already, so the host is told not to ask again.
        await (await host()).request('session:close', { id: req.id, force: true })
      }
      records.delete(req.id)
      grids.delete(req.id)
      streams.close('session:data', req.id)
      if (focused.includes(req.id)) {
        focused = focused.filter((id) => id !== req.id)
        sendFocus()
      }
      announce()
      return { closed: true }
    },

    rename(req) {
      const entry = records.get(req.id)
      if (entry === undefined) throw new Error('That session is not running in the local host.')
      const trimmed = req.label?.trim()
      // Answered at once, as Helm's own rename is; the host's row follows.
      const renamed: SessionRecord = { ...entry, label: trimmed === undefined || trimmed === '' ? null : trimmed }
      records.set(req.id, renamed)
      announce()
      const failed = (error: unknown): void => deps.log(`host: session:rename failed (${(error as Error).message})`)
      const send = (connection: HostConnection): Promise<void> =>
        connection.request('session:rename', { id: req.id, label: renamed.label }).then((row) => {
          if (records.has(row.id)) records.set(row.id, sessionFromHost(row))
        }, failed)
      const current = link.current()
      if (current === null) void host().then(send, failed)
      else void send(current)
      return renamed
    },

    list: () => [...records.values()],

    settled: () => link.settled(),

    input(id, data) {
      streams.write('session:data', id, data)
    },

    resize(id, cols, rows) {
      if (!records.has(id)) return
      grids.set(id, { cols, rows })
      link
        .current()
        ?.request('session:resize', { id, cols, rows })
        .catch((error: unknown) => deps.log(`host: session:resize was not taken (${(error as Error).message})`))
    },

    grid: (id) => grids.get(id) ?? null,

    // The host owns the process.
    pid: () => null,

    // The host follows a session's conversation itself, from Claude Code's records.
    noteConversation: () => undefined,

    tokenHolder: () => null,
    browserOpener: () => null,
    browserSessions: () => [],
    pluginSessions: () => [],

    onChanged(listener) {
      changed.add(listener)
    },

    setFocus(ids) {
      focused = [...ids]
      sendFocus()
    },

    runningCount: () => running().length,

    confirmCloseAll() {
      const live = running()
      if (live.length === 0) return Promise.resolve(true)
      return deps.confirm({
        kind: 'quit',
        message:
          live.length === 1
            ? `“${live[0] ? sessionLabel(live[0]) : ''}” is still running.`
            : `${String(live.length)} Claude Code sessions are still running.`,
        detail: 'Quitting Helm ends them.',
        confirmLabel: live.length > 1 ? `End ${String(live.length)} sessions` : 'End session',
        sessions: live
      })
    },

    shutdown() {
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
      streams.closeAll()
    }
  }

  const restore: RestoreService = {
    async offer() {
      let connection: HostConnection
      try {
        connection = await host()
      } catch {
        // No host, no sessions of its to offer back.
        return null
      }
      const offer = await connection.request('session:restorable', null)
      return offer === null ? null : offerFromHost(offer, deps.layout)
    },

    async restore(req) {
      const connection = await host()
      const result = await connection.request('session:restore', { sessions: req.sessions })
      const restored = result.restored.map(({ from, launched }) => {
        const mapped = launchedFromHost(launched)
        adopt(mapped.session)
        return { from, launched: mapped }
      })
      if (restored.length > 0) announce()
      return { restored, failed: result.failed }
    }
  }

  const activity: ActivityService = {
    states: () => states,
    overview: () => overview,
    // The host reads its backends' records itself, and again at once after a
    // launch, a rename or an exit.
    refresh: () => undefined,
    entries: () => [],
    stop: () => undefined
  }

  return { sessions, restore, activity, refocus: sendFocus }
}
