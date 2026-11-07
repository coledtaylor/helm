import { LOCAL_HOST_KEY } from '@helm/core/types'
import { isClientOnly, isHostInternal } from '../../../../shared/host/protocol'
import type { HelmBridge } from '../../../../shared/ipc'
import { createConfigAdapter } from './config'
import { createFilesAdapter } from './files'
import { createHistoryAdapter } from './history'
import { WINDOW_CAPABILITIES, createPageLink, type PageLink } from './link'
import { createPluginsAdapter } from './plugins'
import { createProfilesAdapter } from './profiles'
import type { RemoteHostsStore } from './remoteHosts'
import { createRouter, type HostAdapter } from './router'
import { createNoticesAdapter, type NoticesStore } from './notices'
import { createWorktreesAdapter } from './worktrees'
import { createSessionsAdapters, type SessionsAdapters, type WindowFront } from './sessions'
import { createWorkspaceAdapter, type WorkspaceAdapter } from './workspace'

/**
 * One bridge per host: the window's page link to it, that host's own adapters
 * (history, workspace, profiles, config, files, sessions and terminals,
 * plugins) and a router of its own in front of them.
 *
 * This PC's host is keyed `LOCAL_HOST_KEY`, and its bridge is the window's
 * own (`helm` in `bridge.ts`). A host on another computer is keyed by its id
 * in the `hosts` setting.
 *
 * Every router sends what `boundary.rs` lists as client-only to the preload's
 * bridge, as this PC's always has. What only this device keeps stays with
 * main and this PC's bridge: a remote host's workspace adapter refuses a write
 * of this device's own settings (theme, paneLayout, hosts, quitSessions,
 * terminal and browser preferences) and its router carries only that host's
 * half (scan roots, pins, setup stamp). Main's word that is about this PC's
 * host alone (the quit question, a notification's click, the lost layout) is
 * not heard on a remote host's adapters (`remoteOwn`). Main's reports of the
 * background pages cover every host, and each host's plugins adapter keeps
 * the ones naming it.
 *
 * Each host's adapters subscribe on its link as soon as it is made, so they
 * hear its first connect: a remote host's bridge is made with its link, and
 * the window's view of remote hosts (`remoteHosts.ts`) lists sessions over
 * that same link, never a second.
 */

export interface HostBridge {
  /** `LOCAL_HOST_KEY`, or a remote host's id. */
  readonly host: string
  /** The router: what every hook on this host calls. */
  readonly helm: HelmBridge
  /** The window's own connection to this host. */
  readonly link: PageLink
  /** Which of this host's sessions have a tab in this window, for its connection to carry. */
  readonly sessions: Pick<SessionsAdapters, 'show' | 'release' | 'adopt' | 'peek'>
  /** The notices standing on this host, and what stood when the window's connection opened. */
  readonly notices: NoticesStore
  readonly workspace: WorkspaceAdapter
  /** Every adapter behind the router. */
  readonly adapters: readonly HostAdapter[]
}

export interface HostBridgeDeps {
  /** The preload's bridge. */
  own: HelmBridge
  front: WindowFront
  /** Where a terminal tab's shell is kept across a reload of the page; none in a test. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  onFocus?: (listener: () => void) => void
  log: (line: string) => void
}

/** Where this PC's host's terminal tabs are kept across a reload, as they always were. */
export const SHELF_KEY = 'helm.hostTerminals'

/** Where one host's terminal tabs are kept across a reload: a key of its own for each host. */
export const shelfKeyFor = (host: string): string =>
  host === LOCAL_HOST_KEY ? SHELF_KEY : `${SHELF_KEY}.${encodeURIComponent(host)}`

/** The sentence a remote host's adapter is refused this PC's file picker with. */
export const pickerOnThisPc = (host: string): string =>
  `The file picker shows This PC’s folders; type the path on ${host} instead.`

/**
 * The preload's bridge as a remote host's adapters see it: main's word that
 * is about this PC's host alone is not heard, nothing of it is answered for
 * that host, and this PC's file picker is not offered for a path there.
 * Everything else is the preload's bridge.
 */
export function remoteOwn(own: HelmBridge, name: () => string): HelmBridge {
  const silentEvents = new Set<string>([
    'pluginWindow:asked',
    'pluginWindow:answered',
    'windowSessions:quitConfirm',
    'windowSessions:activate'
  ])
  const droppedSends = new Set<string>([
    'windowSessions:notify',
    'windowSessions:quitConfirmed',
    'pluginWindow:ask',
    'pluginWindow:answer'
  ])
  const answered: Record<string, () => Promise<unknown>> = {
    // The lost layout is this PC's host's sessions'.
    'windowSessions:lostLayout': () => Promise.resolve(null),
    'ownSettings:write': () => Promise.reject(new Error(`This device’s own settings are not written for ${name()}.`)),
    'path:chooseFile': () => Promise.reject(new Error(pickerOnThisPc(name()))),
    'path:chooseDirectory': () => Promise.reject(new Error(pickerOnThisPc(name())))
  }
  const invoke = own.invoke as (channel: string, payload?: unknown) => Promise<unknown>
  const send = own.send as (channel: string, payload?: unknown) => void
  const on = own.on as (channel: string, listener: (payload: unknown) => void) => () => void
  return {
    invoke: ((channel: string, payload?: unknown) => {
      const answer = answered[channel]
      return answer === undefined ? invoke(channel, payload) : answer()
    }) as HelmBridge['invoke'],
    send: ((channel: string, payload?: unknown) => {
      if (!droppedSends.has(channel)) send(channel, payload)
    }) as HelmBridge['send'],
    on: ((channel: string, listener: (payload: unknown) => void) =>
      silentEvents.has(channel) ? () => undefined : on(channel, listener)) as HelmBridge['on']
  }
}

/** One host's link, adapters and router. */
export function createHostBridge(
  host: string,
  link: PageLink,
  deps: HostBridgeDeps & { name: () => string }
): HostBridge {
  const local = host === LOCAL_HOST_KEY
  const own = local ? deps.own : remoteOwn(deps.own, deps.name)
  const key = shelfKeyFor(host)
  const storage = deps.storage
  const workspace = createWorkspaceAdapter({
    link,
    own,
    ...(deps.onFocus !== undefined ? { onFocus: deps.onFocus } : {}),
    ...(local ? {} : { remote: { name: deps.name } }),
    log: deps.log
  })
  const sessions = createSessionsAdapters({
    link,
    own,
    front: deps.front,
    // A terminal tab's shell outlives a reload of the page, and so does this.
    shelf:
      storage === null
        ? null
        : { read: () => storage.getItem(key), write: (text) => storage.setItem(key, text) },
    ...(local ? {} : { hostName: deps.name }),
    log: deps.log
  })
  const notices = createNoticesAdapter(link, deps.log)
  const adapters: HostAdapter[] = [
    createHistoryAdapter(link, deps.log),
    workspace,
    createProfilesAdapter({ link, own, log: deps.log }),
    createConfigAdapter({ link, scanned: () => workspace.scannedProjects(), log: deps.log }),
    createFilesAdapter(link, deps.log),
    createWorktreesAdapter(link),
    notices,
    ...sessions,
    // A session a plugin asked for, started after the user's yes, opens as one of the window's tabs.
    createPluginsAdapter({ link, host, own, adopt: (row) => sessions.adopt(row), log: deps.log })
  ]
  const helm = createRouter({
    own: deps.own,
    adapters,
    clientOnly: isClientOnly,
    hostInternal: isHostInternal,
    log: deps.log
  })
  return { host, helm, link, sessions, notices: notices.store, workspace, adapters }
}

export interface HostBridges {
  /** The router for `host`: this PC's for `LOCAL_HOST_KEY`, otherwise that host's, made on first ask. */
  bridgeFor(host: string): HelmBridge
  /** Everything of `host`'s bridge, made on first ask. */
  hostBridge(host: string): HostBridge
  /** Calls `listener` for every bridge there is, this PC's first, and for each made from now on. Returns the stop. */
  each(listener: (bridge: HostBridge) => void): () => void
}

export interface HostBridgesDeps extends HostBridgeDeps {
  /** The window's connection to this PC's host. */
  localLink: PageLink
  /** The window's connection to a host on another computer; one per host, with the window's capabilities. */
  remoteLink?: (host: string) => PageLink
  /** What the window calls a host on another computer. */
  nameOf: (host: string) => string
}

export function createHostBridges(deps: HostBridgesDeps): HostBridges {
  const remoteLink =
    deps.remoteLink ??
    ((host: string) =>
      // Told when to connect: main's own link to that host says when it is reachable.
      createPageLink({ bridge: deps.own, capabilities: WINDOW_CAPABILITIES, host, retries: false, log: deps.log }))
  const listeners = new Set<(bridge: HostBridge) => void>()
  const bridges = new Map<string, HostBridge>()

  const add = (bridge: HostBridge): HostBridge => {
    bridges.set(bridge.host, bridge)
    for (const listener of [...listeners]) listener(bridge)
    return bridge
  }
  add(createHostBridge(LOCAL_HOST_KEY, deps.localLink, { ...deps, name: () => deps.nameOf(LOCAL_HOST_KEY) }))

  const hostBridge = (host: string): HostBridge =>
    bridges.get(host) ?? add(createHostBridge(host, remoteLink(host), { ...deps, name: () => deps.nameOf(host) }))

  return {
    bridgeFor: (host) => hostBridge(host).helm,
    hostBridge,
    each(listener) {
      listeners.add(listener)
      for (const bridge of [...bridges.values()]) listener(bridge)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** The remote hosts connected now, as a list a component can subscribe to. */
export interface ConnectedHosts {
  /** Their ids, in the order main lists them. The same array until it changes. */
  get(): readonly string[]
  subscribe(listener: () => void): () => void
}

/** Which remote hosts are connected, from the window's view of them. */
export function createConnectedHosts(remote: Pick<RemoteHostsStore, 'get' | 'subscribe'>): ConnectedHosts {
  let ids: readonly string[] = []
  const read = (): readonly string[] => {
    const next = Object.entries(remote.get())
      .filter(([, view]) => view.connection?.state === 'connected')
      .map(([id]) => id)
    if (next.length !== ids.length || next.some((id, at) => id !== ids[at])) ids = next
    return ids
  }
  return {
    get: read,
    subscribe(listener) {
      return remote.subscribe(() => {
        const before = ids
        if (read() !== before) listener()
      })
    }
  }
}
