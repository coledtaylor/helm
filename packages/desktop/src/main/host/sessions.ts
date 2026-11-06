import { randomBytes } from 'node:crypto'
import {
  sessionLabel,
  type AppSettings,
  type SavedPaneLayout,
  type SessionActivityState,
  type SessionRecord,
  type SessionsOverview
} from '@helm/core'
import type {
  ActivityService,
  Confirm,
  ConfirmRequest,
  QuitConfirm,
  RestoreService,
  SessionHost
} from './session-host'
import { CLAUDE_CODE_BACKEND } from '../../shared/host/backend'
import type { EventChannel, EventPayload, QuitAnswer } from '../../shared/ipc'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type { HostQuitPart } from './remote'
import type * as P from './protocol'
import {
  activityFromHost,
  historySessionFromHost,
  launchedFromHost,
  launchedProfileFromHost,
  offerFromHost,
  overviewFromHost,
  sessionFromHost
} from './records'
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
 * A launch with a saved profile names the host's profile, and the host
 * composes it (`profile:launch`, or `session:launch` with its id): with the
 * setting on, profiles live in the host (`profiles.ts`). A session a plugin
 * starts, once the user agreed in Helm's dialog, is handed to the host as the
 * dialog showed it - the folder, the name, the first message - with nothing
 * composed here.
 *
 * The browser tools: the host serves `helm-browser` to its sessions and relays
 * each call here (`browser-tools.ts`), where Helm's own tools answer it. A
 * running session's identity at those tools is a random key minted here, held
 * only in main and dropped when the session ends, which also ends every page
 * the user shared with it. The host holds the session's token.
 *
 * The plugins' tools: the host serves each plugin's tool server and relays
 * each call here (`plugin-tools.ts`), naming the session as the plugin knows
 * it - an id the host minted at launch, its label and its folder - never the
 * host's row id, its token or anything of its conversation. A session a
 * plugin's page asked for, which the host started once the user agreed, is
 * adopted here (`adoptSession`) so the window opens it as a tab.
 */

/** The one backend Helm launches. */
export { CLAUDE_CODE_BACKEND }

/**
 * What Helm writes to the host on every connect: the `claude` its sessions
 * run - the one chosen in Settings, or the one Helm finds - the shell a
 * terminal opens, the ceiling its transcript archive is held to, whether its
 * sessions get the browser tools and whether those are held to this machine,
 * whether they get the session tools, and whether they can start agents of
 * their own, with the four limits on a family of them. The host serves that
 * last family and judges every start against the numbers it was last told;
 * Helm's own process serves none of it.
 */
export function hostSettingsFor(settings: AppSettings, discovered: string | null): P.HostSettingsPatch {
  const claude = settings.claudePath ?? discovered
  return {
    ...(claude === null ? {} : { backendPaths: { [CLAUDE_CODE_BACKEND]: claude } }),
    terminalShell: settings.terminalShell,
    transcriptArchiveMaxBytes: settings.transcriptArchiveMaxBytes,
    browserMcp: settings.browserMcp,
    browserMcpLocalOnly: settings.browserMcpLocalOnly,
    sessionMcp: settings.sessionMcp,
    sessionAgents: settings.sessionAgents,
    agentChildrenPerParent: settings.agentChildrenPerParent,
    agentSessionsPerHost: settings.agentSessionsPerHost,
    agentDepth: settings.agentDepth,
    agentStartsPerParent: settings.agentStartsPerParent
  }
}

export type Emit = <K extends EventChannel>(channel: K, payload: EventPayload<K>) => void

export interface HostSessionsDeps {
  link: HostLink
  /**
   * Carries each running session's terminal for the window. Absent when the
   * window carries its own over its own connection (`renderer/src/app/host`),
   * and main keeps only what it needs itself: the running count its quit asks
   * about, the browser tools' identities, and the plugins' sessions.
   */
  streams?: TerminalStreams
  /** Sends an event to the window. */
  emit: Emit
  confirm: Confirm
  /**
   * The quit question, with Keep running and quit beside End and quit. Absent,
   * it is `confirm`'s yes or no, which never keeps them.
   */
  confirmQuit?: QuitConfirm
  /**
   * Shows the OS notification for a session that ended where nobody saw it.
   * Absent when the window hears the host's word itself and hands it to main.
   */
  notify?: (record: SessionRecord) => void
  /** Whether Helm's window is in front, so what is on screen is seen at all. */
  windowFocused: () => boolean
  /**
   * Lists the host's sessions again whenever their activity or overview moves,
   * which the host sends at once after a launch or an exit: so sessions the
   * window started on its own connection are counted here too.
   */
  relist?: boolean
  /** The pane layout the last run saved, which the restore offer is placed by. */
  layout: SavedPaneLayout | null
  /** The discovered project at a folder, by the path discovery spells it, or null. */
  knownProject: (cwd: string) => string | null
  /** After the host's session activity or overview moved, for plugins listing sessions. */
  onActivityChange?: () => void
  /** Whether Helm's browser tools are on in Settings; off, no session has an identity at them. */
  browserTools?: () => boolean
  /** A session's identity at the browser tools has ended with it: its shares end too. */
  browserIdentityEnded?: (key: string) => void
  log: (line: string) => void
}

export interface HostSessions {
  sessions: SessionHost
  restore: RestoreService
  activity: ActivityService
  /** The window gained or lost focus: what its user can see has changed. */
  refocus: () => void
  /**
   * A session the host started for this window outside a launch made here: one
   * a plugin's page asked for, started once the user agreed. Kept, its
   * terminal carried, and returned as the window shows it.
   */
  adoptSession: (row: P.SessionRecord) => SessionRecord
  /**
   * Asks what quitting does to the running sessions this device started
   * that it would end - End and quit, Keep running and quit, or Cancel -
   * saying how many and on which host. `local` false leaves out this PC's
   * host (its setting keeps them); `remote` are the hosts on other computers
   * whose setting ends them. Answers End at once when there are none.
   */
  askQuit: (options?: { local?: boolean; remote?: readonly HostQuitPart[] }) => Promise<QuitAnswer>
}

const sessionsWord = (count: number): string => `${String(count)} session${count === 1 ? '' : 's'}`

/** `a`, `a and b`, `a, b and c`. */
function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`
}

/**
 * The quit question for `live`, the running sessions this device started in
 * this PC's host that a quit would end, and `remote`, those on each host on
 * another computer whose setting ends them: how many, and on which host.
 */
export function quitQuestion(live: readonly SessionRecord[], remote: readonly HostQuitPart[] = []): ConfirmRequest {
  const others = remote.filter((part) => part.sessions.length > 0)
  if (others.length > 0) {
    const where = [
      ...(live.length > 0 ? [{ count: live.length, host: 'this PC’s host' }] : []),
      ...others.map((part) => ({ count: part.sessions.length, host: part.name }))
    ]
    const total = where.reduce((sum, part) => sum + part.count, 0)
    const message =
      where.length === 1
        ? `Quitting Helm ends ${sessionsWord(total)} on ${where[0]?.host ?? ''}.`
        : `Quitting Helm ends ${sessionsWord(total)}: ${listed(where.map((part) => `${String(part.count)} on ${part.host}`))}.`
    const them = total === 1 ? 'it' : 'them'
    return {
      kind: 'quit',
      message,
      detail:
        `End and quit stops ${them}. Keep running and quit leaves ${them} running where ${total === 1 ? 'it is' : 'they are'}, ` +
        'this once. Settings › Sessions and Settings › Hosts set what quitting does on each host.',
      confirmLabel: 'End and quit',
      keepLabel: 'Keep running and quit',
      sessions: [...live],
      otherNames: others.flatMap((part) => part.sessions.map((session) => `${session.name} on ${part.name}`))
    }
  }
  const count = live.length
  return {
    kind: 'quit',
    message: `Quitting Helm ends ${String(count)} session${count === 1 ? '' : 's'} on this PC’s host.`,
    detail:
      'End and quit stops ' +
      (count === 1 ? 'it' : 'them') +
      '. Keep running and quit leaves ' +
      (count === 1 ? 'it' : 'them') +
      ' running in the host, back in ' +
      (count === 1 ? 'its tab' : 'their tabs') +
      ' when Helm opens again. Settings › Sessions sets what quitting does.',
    confirmLabel: 'End and quit',
    keepLabel: 'Keep running and quit',
    sessions: [...live]
  }
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
  /** Each running session's key at the browser tools, minted when first asked for. */
  const openerKeys = new Map<number, string>()
  /**
   * The listed sessions another device started, which quitting Helm leaves
   * running and so does not ask about. Empty while the host has not said:
   * then every running session counts, as asking too much is the safe side.
   */
  let startedElsewhere = new Set<number>()

  /** Which of `rows` another device started, by the host's word on this device's own. */
  async function learnStartedElsewhere(connection: HostConnection, rows: readonly P.SessionRecord[]): Promise<void> {
    let own: readonly P.DeviceSession[] | null
    try {
      own = await connection.request('host:deviceSessions', null)
    } catch (error) {
      deps.log(`host: host:deviceSessions failed (${(error as Error).message})`)
      own = null
    }
    if (own === null) {
      startedElsewhere = new Set()
      return
    }
    const ownIds = new Set(own.map((session) => session.id))
    startedElsewhere = new Set(rows.map((row) => row.id).filter((id) => !ownIds.has(id)))
  }

  /** Ends a session's identity at the browser tools, if it had one. */
  const dropOpener = (id: number): void => {
    const key = openerKeys.get(id)
    if (key === undefined) return
    openerKeys.delete(id)
    deps.browserIdentityEnded?.(key)
  }

  const browserToolsOn = (): boolean => deps.browserTools?.() ?? false

  const announce = (): void => {
    for (const listener of changed) listener()
  }

  const host = (): Promise<HostConnection> => link.connection()

  /** A session the window should show: listed, kept, and its terminal carried. */
  const adopt = (record: SessionRecord): SessionRecord => {
    records.set(record.id, record)
    if (isRunning(record)) streams?.open('session:data', record.id)
    else dropOpener(record.id)
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
    streams?.close('session:data', record.id)
    dropOpener(record.id)
    // A session whose tab was closed has nobody to tell.
    if (!records.has(record.id)) return
    records.set(record.id, record)
    deps.emit('session:exit', record)
    announce()
  }

  link.onConnected(async (connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    const failed = (channel: string) => (error: Error) => deps.log(`host: ${channel} ended (${error.message})`)
    const notify = deps.notify
    subscriptions = [
      connection.subscribe('session:exit', { event: onExit, error: failed('session:exit') }),
      ...(notify === undefined
        ? []
        : [
            connection.subscribe('session:notify', {
              event: (row) => {
                const record = sessionFromHost(row)
                if (records.has(record.id)) notify(record)
              },
              error: failed('session:notify')
            }),
            connection.subscribe('session:activate', {
              event: ({ id }) => deps.emit('session:activate', { id }),
              error: failed('session:activate')
            })
          ]),
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
    const listed = await connection.request('session:list', null)
    for (const row of listed) adopt(sessionFromHost(row))
    await learnStartedElsewhere(connection, listed)
    announce()
    sendFocus()
  })

  let relisting = false
  let relistAgain = false
  /** Adopts what the host lists now; one list at a time, and once more if asked meanwhile. */
  async function relist(): Promise<void> {
    if (relisting) {
      relistAgain = true
      return
    }
    relisting = true
    try {
      do {
        relistAgain = false
        const connection = link.current()
        if (connection === null) return
        const rows = await connection.request('session:list', null)
        for (const row of rows) adopt(sessionFromHost(row))
        await learnStartedElsewhere(connection, rows)
      } while (relistAgain)
    } catch (error) {
      deps.log(`host: session:list failed (${(error as Error).message})`)
    } finally {
      relisting = false
    }
  }

  function setStates(next: readonly P.SessionActivityState[]): void {
    states = activityFromHost(next)
    deps.emit('session:activity', states)
    deps.onActivityChange?.()
    if (deps.relist === true) void relist()
  }

  function setOverview(next: P.SessionsOverview): void {
    overview = overviewFromHost(next)
    deps.emit('sessions:overview', overview)
    deps.onActivityChange?.()
    if (deps.relist === true) void relist()
  }

  const running = (): SessionRecord[] => [...records.values()].filter(isRunning)
  /** The running sessions this device started: what quitting Helm ends. */
  const runningHere = (): SessionRecord[] => running().filter((record) => !startedElsewhere.has(record.id))

  const confirmQuit: QuitConfirm =
    deps.confirmQuit ?? (async (request) => ((await deps.confirm(request)) ? 'end' : 'cancel'))

  const askQuit = ({
    local = true,
    remote = []
  }: { local?: boolean; remote?: readonly HostQuitPart[] } = {}): Promise<QuitAnswer> => {
    const live = local ? runningHere() : []
    const elsewhere = remote.reduce((sum, part) => sum + part.sessions.length, 0)
    return live.length + elsewhere === 0 ? Promise.resolve('end') : confirmQuit(quitQuestion(live, remote))
  }

  /** A session with no profile and nothing composed: a folder, a name, and maybe a first message. */
  async function startPlain(req: {
    cwd: string
    projectPath: string | null
    name: string | null
    openingPrompt: string | null
    cols: number
    rows: number
  }): Promise<SessionRecord> {
    const connection = await host()
    const row = await connection.request('session:start', {
      cwd: req.cwd,
      projectPath: req.projectPath,
      name: req.name,
      backend: CLAUDE_CODE_BACKEND,
      profileId: null,
      overlays: null,
      extraFolders: null,
      model: null,
      effort: null,
      agent: null,
      permissionMode: null,
      openingPrompt: req.openingPrompt,
      cols: req.cols,
      rows: req.rows
    })
    const record = adopt(sessionFromHost(row))
    announce()
    return record
  }

  const sessions: SessionHost = {
    start: (req) =>
      startPlain({
        cwd: req.cwd,
        projectPath: req.projectPath ?? null,
        name: req.name ?? null,
        openingPrompt: null,
        cols: req.cols,
        rows: req.rows
      }),

    // What the dialog showed, and nothing else: the host makes the name
    // unique and puts the prompt last on the command line, as `claude -n
    // <name> <prompt>` reads in the dialog.
    startWithPrompt: (req) =>
      startPlain({
        cwd: req.cwd,
        // A folder Helm knows as a project is recorded as one, so the session
        // is that project's in the sidebar and its crumb.
        projectPath: deps.knownProject(req.cwd),
        name: req.name,
        openingPrompt: req.prompt,
        cols: req.cols,
        rows: req.rows
      }),

    async launch(req) {
      const connection = await host()
      const launched = launchedFromHost(
        await connection.request('session:launch', {
          cwd: req.cwd,
          projectPath: req.projectPath ?? null,
          name: req.name ?? null,
          profileId: req.profileId,
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

    async launchProfile(req) {
      const connection = await host()
      const launched = launchedProfileFromHost(
        await connection.request('profile:launch', { profileId: req.profileId, cols: req.cols, rows: req.rows })
      )
      adopt(launched.session)
      announce()
      return launched
    },

    async resume(req) {
      const connection = await host()
      const resumed = await connection.request('history:resume', {
        sessionId: req.sessionId,
        cols: req.cols,
        rows: req.rows
      })
      const session = adopt(sessionFromHost(resumed.session))
      announce()
      // The host's own history row for it: with sessions in the host, the
      // window's history pane lists the host's index too.
      return { session, history: historySessionFromHost(resumed.history) }
    },

    async close(req) {
      const entry = records.get(req.id)
      if (entry === undefined) return { closed: true }
      if (isRunning(entry) && req.force !== true) {
        const agreed = await deps.confirm({
          kind: 'close-session',
          message: `“${sessionLabel(entry)}” is still running.`,
          detail: `Closing the tab ends the Claude Code session in ${entry.cwd}.`,
          folder: entry.cwd,
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
      dropOpener(req.id)
      streams?.close('session:data', req.id)
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
      streams?.write('session:data', id, data)
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

    browserOpener(id) {
      const record = records.get(id)
      if (!browserToolsOn() || record === undefined || !isRunning(record)) return null
      let key = openerKeys.get(id)
      if (key === undefined) {
        key = randomBytes(32).toString('hex')
        openerKeys.set(id, key)
      }
      return { key, name: sessionLabel(record) }
    },

    browserSessions: () =>
      browserToolsOn() ? running().map((record) => ({ session: record.id, name: sessionLabel(record) })) : [],

    onChanged(listener) {
      changed.add(listener)
    },

    setFocus(ids) {
      focused = [...ids]
      sendFocus()
    },

    runningCount: () => runningHere().length,

    // Yes only to End and quit: the answer that ends what this device started.
    confirmCloseAll: async () => (await askQuit()) === 'end',

    shutdown() {
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
      streams?.closeAll()
      for (const id of [...openerKeys.keys()]) dropOpener(id)
      // Every session ends with the quit, as Helm's own do, so nothing is left
      // for the window's close to ask about while the host stops them.
      records.clear()
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

  const adoptSession = (row: P.SessionRecord): SessionRecord => {
    const record = adopt(sessionFromHost(row))
    announce()
    return record
  }

  return { sessions, restore, activity, refocus: sendFocus, adoptSession, askQuit }
}
