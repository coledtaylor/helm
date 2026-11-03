import type { SessionResources } from '@helm/core'
import type { RemoteHostConnection } from '@helm/core/types'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import { createHostResources, type HostResources } from '../../../../shared/host/resources'
import type { HelmBridge, RemoteHostStates } from '../../../../shared/ipc'
import type { PageLink } from './link'

/**
 * The window's view of each host on another computer this device added:
 * where main's link to it stands, and the sessions running there, listed
 * over the window's own connection to that host (`hostLink:open` naming it):
 * the one that host's bridge holds (`hostBridges.ts`), one per host. Opening
 * or starting a remote session in a tab goes through that bridge: this lists
 * them.
 *
 * - Main says where each host stands on `remoteHosts:changed`. The window
 *   connects to a host once main says it is connected, and never asks main to
 *   try: a host that cannot be reached holds up no other.
 * - A host that drops keeps its last rows, which the sessions pane dims: its
 *   sessions are still running there. Once main says it is connected again,
 *   the window connects again and its rows come back live by themselves.
 * - Nothing here ends a session, on any host.
 * - While the window is connected to a host, it asks `host:ping` at once and
 *   every `PING_MS` after, one at a time, and keeps how long the last answer
 *   took: the round trip a keystroke there costs, which its status bar item
 *   shows. A host not connected has none.
 * - What each of a host's sessions is holding (processes and ports) comes
 *   from that host's own pass, over the same connection, while the sessions
 *   pane asks for it (`watch`), as this PC's does.
 */

/** How often the window measures its round trip to each connected host. */
export const PING_MS = 5_000

/** One running session on a host on another computer. */
export interface RemoteSessionRow {
  /** `<host id>:<session id>`: unique across every host, so it never meets this PC's ids. */
  key: string
  name: string
  cwd: string
  state: P.SessionActivity | 'running'
}

export interface RemoteHostView {
  /** Where main's link to it stands; null until main has said. */
  connection: RemoteHostConnection | null
  /** Its running sessions, as last listed; kept while it is not connected. */
  sessions: readonly RemoteSessionRow[]
  /** How long the window's last `host:ping` there took to come back, in ms; null while not connected or not yet measured. */
  roundTripMs: number | null
  /** What each of its sessions is holding, by session id, from its own pass; empty while nobody is looking or it is not connected. */
  resources: ReadonlyMap<number, SessionResources>
}

export interface RemoteHostsStore {
  /** Every host main has said anything about, by id. The same object until something changes. */
  get(): Readonly<Record<string, RemoteHostView>>
  /** Calls `listener` on every change; the first subscriber starts listening to main. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** The window's own connection to one host, connecting first when there is none (Settings > Devices). */
  connection(id: string): Promise<HostConnection>
  /**
   * The user's Reconnect now for one host: main's link to it tries at once
   * (`remoteHosts:reconnect`), and so does the window's own link if it is
   * waiting. Asks the host nothing else, and sends nothing typed or asked
   * before the drop.
   */
  reconnect(id: string): void
  /**
   * Whether something in the window is looking at the hosts' processes and
   * ports (the sessions pane): each connected host runs its pass only while
   * it is told so.
   */
  watch(on: boolean): void
}

export interface RemoteHostsDeps {
  /** The preload's bridge: `remoteHosts:*` and `hostLink:*` only. */
  bridge: Pick<HelmBridge, 'invoke' | 'send' | 'on'>
  log: (line: string) => void
  /**
   * The window's own connection to one host: the one that host's bridge
   * holds (`hostBridges.ts`), so its sessions are listed over the link every
   * other call to it takes, never a second.
   */
  pageLink: (host: string) => RemoteLink
  /** The clock the round trip is measured and repeated on; the page's own by default. */
  now?: () => number
  setInterval?: (run: () => void, ms: number) => unknown
  clearInterval?: (timer: unknown) => void
}

type RemoteLink = Pick<PageLink, 'connection' | 'onConnected' | 'onEnded'> & Partial<Pick<PageLink, 'reconnectNow'>>

interface Host {
  link: RemoteLink
  /** Whether the window's connection is up or on its way. */
  live: boolean
  subscriptions: HostSubscription[]
  rows: readonly P.SessionRecord[]
  activity: ReadonlyMap<number, P.SessionActivity | null>
  /** The window's connection to it now; null between connections. */
  current: HostConnection | null
  roundTripMs: number | null
  resources: ReadonlyMap<number, SessionResources>
  pass: HostResources
  /** Whether `pass` was told somebody is looking. */
  watched: boolean
}

const NO_STATES: RemoteHostStates = {}
const NO_RESOURCES: ReadonlyMap<number, SessionResources> = new Map()

export function createRemoteHosts(deps: RemoteHostsDeps): RemoteHostsStore {
  const listeners = new Set<() => void>()
  const hosts = new Map<string, Host>()
  let states: RemoteHostStates = NO_STATES
  let view: Readonly<Record<string, RemoteHostView>> = {}
  let started = false
  let watching = false

  const makeLink = deps.pageLink
  const now = deps.now ?? (() => performance.now())
  const every = deps.setInterval ?? ((run: () => void, ms: number): unknown => setInterval(run, ms))
  const stopEvery = deps.clearInterval ?? ((timer: unknown): void => clearInterval(timer as ReturnType<typeof setInterval>))

  const render = (): void => {
    const next: Record<string, RemoteHostView> = {}
    for (const id of new Set([...Object.keys(states), ...hosts.keys()])) {
      const host = hosts.get(id)
      next[id] = {
        connection: states[id] ?? null,
        sessions: (host?.rows ?? [])
          .filter((row) => row.status === 'running')
          .map((row) => ({
            key: `${id}:${String(row.id)}`,
            name: row.label ?? row.name,
            cwd: row.cwd,
            state: host?.activity.get(row.id) ?? 'running'
          })),
        roundTripMs: host?.roundTripMs ?? null,
        resources: host?.resources ?? NO_RESOURCES
      }
    }
    view = next
    for (const listener of listeners) listener()
  }

  const relist = async (id: string, host: Host, connection: HostConnection): Promise<void> => {
    try {
      const rows = await connection.request('session:list', null)
      if (hosts.get(id) !== host) return
      host.rows = rows
      render()
    } catch (error) {
      deps.log(`host: listing a remote host's sessions failed (${(error as Error).message})`)
    }
  }

  const hostFor = (id: string): Host => {
    const known = hosts.get(id)
    if (known !== undefined) return known
    const link = makeLink(id)
    // Filled in below: the pass reaches the host it belongs to.
    const host = {
      link,
      live: false,
      subscriptions: [],
      rows: [],
      activity: new Map(),
      current: null,
      roundTripMs: null,
      resources: NO_RESOURCES,
      watched: false
    } as unknown as Host
    hosts.set(id, host)
    host.link.onConnected((connection) => {
      host.current = connection
      measure(host, connection)
      for (const subscription of host.subscriptions) subscription.unsubscribe()
      const ignore = (): void => undefined
      const activity = (states: readonly P.SessionActivityState[]): void => {
        const known = new Set(host.rows.map((row) => row.id))
        host.activity = new Map(states.map((state) => [state.id, state.activity]))
        // A session the list has not got yet is listed again; the rest only change state.
        if (states.some((state) => !known.has(state.id))) void relist(id, host, connection)
        else render()
      }
      host.subscriptions = [
        connection.subscribe('session:activity', { snapshot: activity, event: activity, error: ignore }),
        connection.subscribe('session:exit', { event: () => void relist(id, host, connection), error: ignore })
      ]
      void relist(id, host, connection)
    })
    host.link.onEnded(() => {
      host.live = false
    })
    // Its pass is asked only over the connection the window has, never one it opens.
    host.pass = createHostResources({
      link: {
        connection: () =>
          host.current !== null ? Promise.resolve(host.current) : Promise.reject(new Error('That host is not connected.')),
        current: () => host.current,
        onConnected: (listener) => link.onConnected(listener)
      },
      emit: (_channel, sets) => {
        host.resources = new Map(sets.map((set) => [set.id, set]))
        render()
      },
      log: deps.log
    })
    if (watching) {
      host.watched = true
      host.pass.watch(true)
    }
    return host
  }

  /** Times `host:ping` there now and every `PING_MS` while `connection` lasts, one at a time. */
  const measure = (host: Host, connection: HostConnection): void => {
    let asking = false
    const ping = (): void => {
      if (asking || host.current !== connection) return
      asking = true
      const sent = now()
      connection.request('host:ping', null).then(
        () => {
          asking = false
          if (host.current !== connection) return
          host.roundTripMs = Math.max(0, Math.round(now() - sent))
          render()
        },
        () => {
          asking = false
        }
      )
    }
    const timer = every(ping, PING_MS)
    ping()
    void connection.ended.then(() => {
      stopEvery(timer)
      if (host.current !== connection) return
      host.current = null
      host.roundTripMs = null
      render()
    })
  }

  /** Connects the window to each host main says is connected and the window is not. */
  const follow = (next: RemoteHostStates): void => {
    states = next
    for (const [id, state] of Object.entries(next)) {
      if (state.state !== 'connected') continue
      const host = hostFor(id)
      if (host.live) continue
      host.live = true
      host.link.connection().catch((error: unknown) => {
        host.live = false
        deps.log(`host: the window could not connect to a remote host (${(error as Error).message})`)
      })
    }
    render()
  }

  const start = (): void => {
    if (started) return
    started = true
    deps.bridge.on('remoteHosts:changed', follow)
    void deps.bridge.invoke('remoteHosts:read').then(
      (read) => {
        // An event that came first is newer than this answer.
        if (states === NO_STATES) follow(read)
      },
      (error: unknown) => deps.log(`host: reading the remote hosts failed (${(error as Error).message})`)
    )
  }

  return {
    get: () => view,
    connection: (id) => hostFor(id).link.connection(),
    reconnect(id) {
      deps.bridge.invoke('remoteHosts:reconnect', { id }).catch((error: unknown) => {
        deps.log(`host: asking to reconnect to a remote host failed (${(error as Error).message})`)
      })
      hosts.get(id)?.link.reconnectNow?.()
    },
    watch(on) {
      watching = on
      for (const host of hosts.values()) {
        if (host.watched === on) continue
        host.watched = on
        host.pass.watch(on)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
