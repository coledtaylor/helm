import { LOCAL_HOST_KEY, LOCAL_HOST_LABEL, type AppSettings } from '@helm/core/types'
import type { HelmBridge } from '../../../shared/ipc'
import { createDevices, type Devices } from './host/devices'
import {
  createConnectedHosts,
  createHostBridges,
  type ConnectedHosts,
  type HostBridge
} from './host/hostBridges'
import { createHostState, type HostStateStore } from './host/hostState'
import { WINDOW_CAPABILITIES, createPageLink } from './host/link'
import { createRemoteHosts, type RemoteHostsStore } from './host/remoteHosts'
import type { HostAdapter } from './host/router'

declare global {
  interface Window {
    /** Injected by the preload. The renderer's only route to the main process. */
    readonly helm: HelmBridge
  }
}

const log = (line: string): void => console.warn(line)

/**
 * This window's own connection to the local host, used only while sessions
 * run there (`host/link.ts`).
 */
const link = createPageLink({ bridge: window.helm, capabilities: WINDOW_CAPABILITIES, log })

/** What the window calls each host on another computer: its name in the `hosts` setting, learnt from main. */
const hostNames = new Map<string, string>()
let namesAsked = false
const learnNames = (settings: Pick<AppSettings, 'hosts'>): void => {
  hostNames.clear()
  for (const host of settings.hosts) hostNames.set(host.id, host.name)
}
const nameOf = (host: string): string => {
  if (host === LOCAL_HOST_KEY) return LOCAL_HOST_LABEL
  if (!namesAsked) {
    namesAsked = true
    window.helm.on('ownSettings:changed', learnNames)
    window.helm.invoke('ownSettings:read').then(learnNames, (error: unknown) => {
      log(`host: the hosts' names were not read (${(error as Error).message})`)
    })
  }
  return hostNames.get(host) ?? host
}

/**
 * One bridge per host: this PC's, and one for each host on another computer
 * the window reaches, each with its own link, adapters and router
 * (`host/hostBridges.ts`).
 */
const hostBridges = createHostBridges({
  own: window.helm,
  localLink: link,
  front: {
    focused: () => document.hasFocus(),
    onChange: (listener) => {
      window.addEventListener('focus', listener)
      window.addEventListener('blur', listener)
    }
  },
  storage: sessionStorage,
  onFocus: (listener) => window.addEventListener('focus', listener),
  nameOf,
  log
})

const local = hostBridges.hostBridge(LOCAL_HOST_KEY)

/** Whether the window has its host: lost from a crash until it is connected again (`host/hostState.ts`). */
export const hostState: HostStateStore = createHostState(link)

/**
 * Each host on another computer this device added: where main's link to it
 * stands, and its running sessions over the window's connection to it, the
 * one its bridge holds (`host/remoteHosts.ts`). Empty with sessions in Helm.
 */
export const remoteHosts: RemoteHostsStore = createRemoteHosts({
  bridge: window.helm,
  pageLink: (host) => hostBridges.hostBridge(host).link,
  log
})

/** The hosts on another computer connected now, in the order main lists them. */
export const connectedHosts: ConnectedHosts = createConnectedHosts(remoteHosts)

/**
 * The bridge to one host: `helm` for this PC's (`LOCAL_HOST_KEY`), and for a
 * host on another computer, by its id, the router to its own adapters over
 * the window's own connection to it.
 */
export const bridgeFor = (host: string): HelmBridge => hostBridges.bridgeFor(host)

/** Calls `listener` with every host's bridge, this PC's first, and each made from now on. Returns the stop. */
export const eachHostBridge = (listener: (host: string, bridge: HelmBridge) => void): (() => void) =>
  hostBridges.each((bridge: HostBridge) => listener(bridge.host, bridge.helm))

/**
 * Settings > Devices: who is attached to each connected host, and
 * Disconnect, over the window's own connection to it (`host/devices.ts`).
 */
export const devices: Devices = createDevices({ log })

/** The window's own connection to this PC's host, for Settings > Devices. */
export const localHostConnection = (): ReturnType<typeof link.connection> => link.connection()

/** Whether sessions run in the local host this run: main says once, when the window first asks. */
export const sessionsInHost = (): Promise<boolean> => link.inHost()

/**
 * With sessions in the local host, which of a host's sessions have a tab in
 * this window: the layout is this device's own, so the window tells that
 * host's connection which terminals to carry. This PC's by default. Unused
 * with the setting off.
 */
export const hostSessionTabs = {
  show: (ids: readonly number[], host: string = LOCAL_HOST_KEY): void => hostBridges.hostBridge(host).sessions.show(ids),
  release: (id: number, host: string = LOCAL_HOST_KEY): void => hostBridges.hostBridge(host).sessions.release(id)
}

/** The window's areas that reach this PC's host over its own connection. */
export const hostAdapters: readonly HostAdapter[] = local.adapters

/**
 * The typed bridge to this PC, as a value the app can import.
 *
 * Everything in the renderer goes through this or `bridgeFor`: there is no
 * `ipcRenderer` here to reach for, and a feature that wants a new capability
 * has to add a channel to `shared/ipc.ts`, where both ends are checked.
 *
 * With "Run sessions in the local host" off it is the preload's bridge. With
 * it on, each channel `boundary.rs` lists as client-only stays on the preload's
 * bridge, each a host adapter takes goes to the host over this window's own
 * connection, and any other is refused (`host/router.ts`); hooks see the same
 * shape either way.
 */
export const helm: HelmBridge = local.helm
