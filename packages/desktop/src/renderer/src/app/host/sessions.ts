import { sessionLabel, type SessionActivityState, type SessionRecord, type SessionsOverview } from '@helm/core/types'
import { CLAUDE_CODE_BACKEND } from '../../../../shared/host/backend'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import {
  activityFromHost,
  historySessionFromHost,
  launchedFromHost,
  launchedProfileFromHost,
  offerFromHost,
  overviewFromHost,
  sessionFromHost
} from '../../../../shared/host/records'
import { createHostResources } from '../../../../shared/host/resources'
import { createTerminalStreams } from '../../../../shared/host/streams'
import type { HelmBridge, SessionConfirmRequest, StartSessionRequest } from '../../../../shared/ipc'
import { createLocalEvents } from './events'
import type { HostReach } from './history'
import type { HostAdapter } from './router'
import { createTerminalsAdapter, type ShellShelf } from './terminals'

/**
 * Sessions and terminals, over the
 * window's own connection: the host owns each session's process, its row and
 * its terminal, and every client sees every session it runs. Which of them
 * have a tab here is this device's own (its saved layout), so the window says
 * (`show`) and the adapter carries only those sessions' terminals, each on a
 * stream of its own. The host starts each new stream with a redraw of the
 * terminal's screen as it is, so a page that has just loaded, or a session
 * opened here from the sessions pane, draws what is there and then streams.
 * A tab closed with the session kept running lets its stream go (`release`).
 *
 * Asked in the window: the question before a running session's tab is closed,
 * after which the host is told to end it without asking again; a question the
 * host asks for another client's close; and main's question before Helm quits
 * with sessions running, which main sends on `windowSessions:quitConfirm`
 * because it is main that holds the quit.
 *
 * Shown by main: the OS notification for an exit nobody saw. The host judges
 * that from what this window says is on screen, and says nothing is while the
 * window is not in front; the window hands the host's word to main
 * (`windowSessions:notify`), and a click on it comes back as
 * `windowSessions:activate`.
 *
 * Every read goes through `link.connection()`, so a read asked before the
 * window has reached the host waits for the host's answer, and when the host
 * cannot be reached it rejects with the link's sentence, never an empty list.
 *
 * When the host goes without a stop or a quit (it crashed or was killed), its
 * sessions keep running in its session keeper. Each stream ends with the
 * connection, so a tab keeps its last screen and its keys reach nothing, under
 * the host-stopped notice. Once the link has reconnected, the new host's list
 * is the word on each: one still running is carried again on a new stream,
 * which starts with the host's redraw of its screen as it is now; one that
 * exited meanwhile, or went with its keeper, is told on `session:exit` as the
 * host lists it. Nothing is resumed here: the host offers back only what it
 * lost, and the window asks for that offer after each reconnect and each
 * session lost at runtime.
 */

/** Whether the window is in front, and word when that changes. */
export interface WindowFront {
  focused(): boolean
  onChange(listener: () => void): void
}

export interface SessionsAdapterDeps {
  link: HostReach
  /** The preload's bridge, for what main keeps: the quit question, notifications, the last run's layout. */
  own: Pick<HelmBridge, 'invoke' | 'send' | 'on'>
  front: WindowFront
  shelf: ShellShelf | null
  /** What the window calls the host these sessions run on, read when asked; this PC's (`LOCAL_HOST_NAME`) by default. */
  hostName?: () => string
  log?: (line: string) => void
}

type Question = Omit<SessionConfirmRequest, 'id'>

/** The sessions and terminals adapters, and the way in for a session the host started for someone else. */
export type SessionsAdapters = HostAdapter[] & {
  /** A session the host started for a plugin: kept with the window's tabs, its terminal carried. */
  adopt(row: P.SessionRecord): SessionRecord
  /**
   * The sessions this window shows: those with a tab, and the children a
   * parent's tab shows. Each running one not carried yet is carried from here
   * on, on a new stream that starts with its screen, and one the last call named
   * that this does not is let go.
   */
  show(ids: readonly number[]): void
  /** A tab closed with its session kept running: its terminal is no longer carried. */
  release(id: number): void
}

const isRunning = (record: SessionRecord): boolean => record.status === 'running'

/** How the window names this PC's own host in a question; a host on another computer goes by its name. */
export const LOCAL_HOST_NAME = 'this PC’s host'

export function createSessionsAdapters(deps: SessionsAdapterDeps): SessionsAdapters {
  const { link, own } = deps
  const log = deps.log ?? (() => undefined)
  const hostName = deps.hostName ?? (() => LOCAL_HOST_NAME)
  const host = (): Promise<HostConnection> => link.connection()

  let current: HostConnection | null = null
  link.onConnected((connection) => {
    current = connection
    void connection.ended.then(() => {
      if (current === connection) current = null
    })
  })

  const events = createLocalEvents(() => {
    void host().catch(() => undefined)
  })
  let shellStreamClosed: (id: number, reason: string | null, connectionEnded: boolean) => void = () => undefined
  const streams = createTerminalStreams({
    connection: () => current,
    deliver: (channel, id, data) => events.tell(channel, { id, data }),
    closed: (channel, id, reason, connectionEnded) => {
      if (channel === 'pterm:data') shellStreamClosed(id, reason, connectionEnded)
    },
    log
  })
  const resources = createHostResources({
    link: { connection: host, current: () => current, onConnected: (listener) => link.onConnected(listener) },
    emit: (channel, sets) => events.tell(channel, sets),
    log
  })

  /** Every session the host listed or this window started, until it is ended here. */
  const records = new Map<number, SessionRecord>()
  /** The sessions with a tab in this window, whose terminals are carried while they run. */
  const shown = new Set<number>()
  let focused: readonly number[] = []
  let states: SessionActivityState[] = []
  let overview: SessionsOverview = { sessions: [], readAtMs: 0 }
  let subscriptions: HostSubscription[] = []
  /** The connection's first list, which `session:list` waits for. */
  let listed: Promise<void> = Promise.resolve()

  /** Carries a session's terminal while it runs and has a tab here. */
  const carry = (record: SessionRecord): void => {
    if (isRunning(record) && shown.has(record.id)) streams.open('session:data', record.id)
  }

  /** A session started here, which opens in a tab here. */
  const adopt = (record: SessionRecord): SessionRecord => {
    records.set(record.id, record)
    shown.add(record.id)
    carry(record)
    return record
  }

  /** A session that was running here has ended: the window hears it as it would the host's `session:exit`. */
  const ended = (record: SessionRecord): void => {
    records.set(record.id, record)
    streams.close('session:data', record.id)
    events.tell('session:exit', record)
  }

  /**
   * Adopts what the host lists. A session running here that the host lists
   * ended (it exited while the window had no host, or went with its keeper) is
   * told as ended. With `whole`, the list is a new host's word on every
   * session, so one running here that it does not list at all is lost.
   */
  const adoptAll = (rows: readonly P.SessionRecord[], whole: boolean): void => {
    const listed = new Set<number>()
    for (const row of rows) {
      const record = sessionFromHost(row)
      listed.add(record.id)
      const known = records.get(record.id)
      if (known !== undefined && isRunning(known) && !isRunning(record)) {
        ended(record)
        continue
      }
      // A rename answered here at once keeps its label until the host's row follows.
      if (known === undefined || known.status !== record.status) records.set(record.id, record)
      carry(records.get(record.id)!)
    }
    if (!whole) return
    for (const record of [...records.values()]) {
      if (isRunning(record) && !listed.has(record.id)) ended({ ...record, status: 'lost', exitCode: null })
    }
  }

  const sendFocus = (): void => {
    const connection = current
    if (connection === null) return
    // A window that is not in front shows nothing anybody is watching.
    const ids = deps.front.focused() ? [...focused] : []
    connection.request('session:focus', { ids }).catch((error: unknown) => {
      log(`host: session:focus was not taken (${(error as Error).message})`)
    })
  }
  deps.front.onChange(sendFocus)

  // Questions asked in the window, each answered once, by the id it was asked
  // with. `keep` is the quit question's Keep running and quit.
  const questions = new Map<number, (agreed: boolean, keep: boolean) => void>()
  let nextQuestion = 1
  const ask = (question: Question, answered: (agreed: boolean, keep: boolean) => void): void => {
    if (events.count('session:confirm') === 0) {
      // Nobody to ask: what is running stays running.
      log(`host: nothing in the window could ask “${question.message}”`)
      answered(false, false)
      return
    }
    const id = nextQuestion++
    questions.set(id, answered)
    events.tell('session:confirm', { id, ...question })
  }
  const asking = (question: Question): Promise<boolean> =>
    new Promise((resolve) => ask(question, (agreed) => resolve(agreed)))

  let relisting: Promise<void> | null = null
  let relistAgain = false
  /**
   * Adopts what the host lists now: a session started elsewhere, such as one a
   * plugin asked for or a parent's agent tool. Settles once a list asked for
   * after this call has been adopted, whoever else was already asking.
   */
  function relist(): Promise<void> {
    if (relisting !== null) {
      relistAgain = true
      return relisting
    }
    let finished: () => void = () => undefined
    const settled = new Promise<void>((resolve) => {
      finished = resolve
    })
    relisting = settled
    void (async (): Promise<void> => {
      try {
        do {
          relistAgain = false
          const connection = current
          if (connection === null) return
          adoptAll(await connection.request('session:list', null), false)
        } while (relistAgain)
      } catch (error) {
        log(`host: session:list failed (${(error as Error).message})`)
      } finally {
        relisting = null
        finished()
      }
    })()
    return settled
  }

  const onExit = (row: P.SessionRecord): void => {
    const record = sessionFromHost(row)
    streams.close('session:data', record.id)
    // A session whose tab was closed has nobody to tell.
    if (!records.has(record.id)) return
    records.set(record.id, record)
    events.tell('session:exit', record)
  }

  link.onConnected((connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    // Every terminal is carried afresh on this connection: the host starts each
    // new stream with a redraw of the screen as it is.
    for (const record of records.values()) streams.close('session:data', record.id)
    const failed = (channel: string) => (error: Error) => log(`host: ${channel} ended (${error.message})`)
    const setStates = (next: readonly P.SessionActivityState[], moved: boolean): void => {
      states = activityFromHost(next)
      // A window hearing of a session it does not know asks for the list at
      // once, so what the host lists is adopted before the word goes out.
      if (moved) void relist().then(() => events.tell('session:activity', states))
      else events.tell('session:activity', states)
    }
    const setOverview = (next: P.SessionsOverview, moved: boolean): void => {
      overview = overviewFromHost(next)
      events.tell('sessions:overview', overview)
      if (moved) void relist()
    }
    subscriptions = [
      connection.subscribe('session:exit', { event: onExit, error: failed('session:exit') }),
      connection.subscribe('session:notify', {
        event: (row) => {
          const record = sessionFromHost(row)
          if (shown.has(record.id)) own.send('windowSessions:notify', record)
        },
        error: failed('session:notify')
      }),
      connection.subscribe('session:activate', {
        event: ({ id }) => events.tell('session:activate', { id }),
        error: failed('session:activate')
      }),
      connection.subscribe('session:confirm', {
        // Another client closed a session without asking first: asked here too.
        event: ({ id, ...question }) =>
          ask(question, (agreed) => {
            connection.request('session:confirmed', { id, agreed }).catch((error: unknown) => {
              log(`host: session:confirmed was not taken (${(error as Error).message})`)
            })
          }),
        error: failed('session:confirm')
      }),
      connection.subscribe('session:activity', {
        snapshot: (next) => setStates(next, false),
        event: (next) => setStates(next, true),
        error: failed('session:activity')
      }),
      connection.subscribe('sessions:overview', {
        snapshot: (next) => setOverview(next, false),
        event: (next) => setOverview(next, true),
        error: failed('sessions:overview')
      })
    ]
    listed = connection.request('session:list', null).then(
      (rows) => {
        adoptAll(rows, true)
        sendFocus()
      },
      (error: unknown) => log(`host: session:list failed (${(error as Error).message})`)
    )
  })

  /** A session with no profile and nothing composed. */
  async function startPlain(req: StartSessionRequest): Promise<SessionRecord> {
    const row = await (
      await host()
    ).request('session:start', {
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
    return adopt(sessionFromHost(row))
  }

  // Main's question before it quits, and a click on a notification, both
  // heard once the window listens for questions and activations.
  let quitHeard = false
  const confirmRoute = events.listen('session:confirm')
  let activateHeard = false
  const activateRoute = events.listen('session:activate')

  const sessions: HostAdapter = {
    requests: {
      'session:start': startPlain,
      'session:launch': async (req) => {
        const launched = launchedFromHost(
          await (
            await host()
          ).request('session:launch', {
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
        return launched
      },
      'profile:launch': async (req) => {
        const launched = launchedProfileFromHost(
          await (await host()).request('profile:launch', { profileId: req.profileId, cols: req.cols, rows: req.rows })
        )
        adopt(launched.session)
        return launched
      },
      'history:resume': async (req) => {
        const resumed = await (
          await host()
        ).request('history:resume', { sessionId: req.sessionId, cols: req.cols, rows: req.rows })
        const session = adopt(sessionFromHost(resumed.session))
        return { session, history: historySessionFromHost(resumed.history) }
      },
      'session:restorable': async () => {
        let connection: HostConnection
        try {
          connection = await host()
        } catch {
          // No host, no sessions of its to offer back.
          return null
        }
        const offer = await connection.request('session:restorable', null)
        if (offer === null) return null
        return offerFromHost(offer, await own.invoke('windowSessions:lostLayout'))
      },
      'session:restore': async (req) => {
        const result = await (await host()).request('session:restore', { sessions: req.sessions })
        const restored = result.restored.map(({ from, launched }) => {
          const mapped = launchedFromHost(launched)
          adopt(mapped.session)
          return { from, launched: mapped }
        })
        return { restored, failed: result.failed }
      },
      'session:close': async (req) => {
        const entry = records.get(req.id)
        if (entry === undefined) return { closed: true }
        if (isRunning(entry) && req.force !== true) {
          // The host is named by the window: a client names its hosts.
          // A child's parent is told, and the question says so.
          const parent = entry.parentId == null ? undefined : records.get(entry.parentId)
          const agreed = await asking({
            kind: 'close-session',
            message: `“${sessionLabel(entry)}” is still running on ${hostName()}.`,
            detail:
              `Ending it stops the Claude Code session in ${entry.cwd}.` +
              (parent === undefined ? '' : ` ${sessionLabel(parent)}, which started it, is told.`),
            folder: entry.cwd,
            confirmLabel: 'End session',
            sessionNames: [sessionLabel(entry)]
          })
          if (!agreed) return { closed: false }
        }
        const now = records.get(req.id)
        if (now === undefined) return { closed: true }
        // Asked already, so the host is told not to ask again.
        if (isRunning(now)) await (await host()).request('session:close', { id: req.id, force: true })
        // Ended, and still on screen where it was ended: its row follows on
        // `session:exit`, and the window forgets it when it is closed there.
        if (req.keep === true) return { closed: true }
        records.delete(req.id)
        shown.delete(req.id)
        streams.close('session:data', req.id)
        if (focused.includes(req.id)) {
          focused = focused.filter((id) => id !== req.id)
          sendFocus()
        }
        return { closed: true }
      },
      'session:list': async () => {
        await host()
        await listed
        return [...records.values()]
      },
      'session:activity': async () => {
        await host()
        return states
      },
      'sessions:overview': async () => {
        await host()
        return overview
      },
      'sessions:resources': () => resources.snapshots(),
      'session:rename': async (req) => {
        const entry = records.get(req.id)
        if (entry === undefined) throw new Error('That session is not running in the local host.')
        const trimmed = req.label?.trim()
        const label = trimmed === undefined || trimmed === '' ? null : trimmed
        // Answered at once, as Helm's own rename is; the host's row follows.
        const renamed: SessionRecord = { ...entry, label }
        records.set(req.id, renamed)
        void host()
          .then((connection) => connection.request('session:rename', { id: req.id, label }))
          .then(
            (row) => {
              if (records.has(row.id)) records.set(row.id, sessionFromHost(row))
            },
            (error: unknown) => log(`host: session:rename failed (${(error as Error).message})`)
          )
        return renamed
      }
    },
    sends: {
      'session:input': ({ id, data }) => streams.write('session:data', id, data),
      'session:resize': ({ id, cols, rows }) => {
        if (!records.has(id)) return
        current?.request('session:resize', { id, cols, rows }).catch((error: unknown) => {
          log(`host: session:resize was not taken (${(error as Error).message})`)
        })
      },
      'session:focus': ({ ids }) => {
        focused = [...ids]
        sendFocus()
      },
      'session:confirmed': ({ id, agreed, keep }) => {
        const answered = questions.get(id)
        questions.delete(id)
        answered?.(agreed, keep === true)
      },
      'sessions:watch': ({ watching }) => resources.watch(watching)
    },
    events: {
      'session:data': events.listen('session:data'),
      'session:exit': events.listen('session:exit'),
      'session:activity': events.listen('session:activity'),
      'sessions:overview': events.listen('sessions:overview'),
      'sessions:resources': events.listen('sessions:resources'),
      'session:confirm': (listener) => {
        if (!quitHeard) {
          quitHeard = true
          own.on('windowSessions:quitConfirm', ({ id, ...question }) =>
            ask(question, (agreed, keep) =>
              own.send('windowSessions:quitConfirmed', { id, answer: agreed ? 'end' : keep ? 'keep' : 'cancel' })
            )
          )
        }
        return confirmRoute(listener)
      },
      'session:activate': (listener) => {
        if (!activateHeard) {
          activateHeard = true
          own.on('windowSessions:activate', (payload) => events.tell('session:activate', payload))
        }
        return activateRoute(listener)
      }
    }
  }

  const terminals = createTerminalsAdapter({
    link,
    current: () => current,
    streams,
    events,
    shelf: deps.shelf,
    log
  })
  shellStreamClosed = terminals.streamClosed

  /** A session no longer shown here: its terminal is no longer carried. */
  const release = (id: number): void => {
    shown.delete(id)
    streams.close('session:data', id)
    if (focused.includes(id)) {
      focused = focused.filter((each) => each !== id)
      sendFocus()
    }
  }
  /** What the last `show` named, so the next lets go of whatever it no longer names. */
  let named = new Set<number>()

  return Object.assign([sessions, terminals], {
    adopt: (row: P.SessionRecord) => adopt(sessionFromHost(row)),
    show: (ids: readonly number[]) => {
      const next = new Set(ids)
      // A child its parent's tab stopped showing (the pane lost its room, the
      // setting went off, the parent's tab closed) is no longer carried.
      for (const id of named) if (!next.has(id)) release(id)
      named = next
      for (const id of ids) {
        shown.add(id)
        const record = records.get(id)
        if (record !== undefined) carry(record)
      }
    },
    release
  })
}
