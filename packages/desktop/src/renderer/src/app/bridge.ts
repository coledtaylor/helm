import { isClientOnly, isHostInternal } from '../../../shared/host/protocol'
import type { HelmBridge } from '../../../shared/ipc'
import { createConfigAdapter } from './host/config'
import { createDevices, type Devices } from './host/devices'
import { createFilesAdapter } from './host/files'
import { createHistoryAdapter } from './host/history'
import { createHostState, type HostStateStore } from './host/hostState'
import { WINDOW_CAPABILITIES, createPageLink } from './host/link'
import { createPluginsAdapter } from './host/plugins'
import { createProfilesAdapter } from './host/profiles'
import { createRemoteHosts, type RemoteHostsStore } from './host/remoteHosts'
import { createRouter, type HostAdapter } from './host/router'
import { createSessionsAdapters } from './host/sessions'
import { createWorkspaceAdapter } from './host/workspace'

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

const workspace = createWorkspaceAdapter({
  link,
  own: window.helm,
  onFocus: (listener) => window.addEventListener('focus', listener),
  log
})

const sessions = createSessionsAdapters({
  link,
  own: window.helm,
  front: {
    focused: () => document.hasFocus(),
    onChange: (listener) => {
      window.addEventListener('focus', listener)
      window.addEventListener('blur', listener)
    }
  },
  // A terminal tab's shell outlives a reload of the page, and so does this.
  shelf: {
    read: () => sessionStorage.getItem('helm.hostTerminals'),
    write: (text) => sessionStorage.setItem('helm.hostTerminals', text)
  },
  log
})

/** Whether the window has its host: lost from a crash until it is connected again (`host/hostState.ts`). */
export const hostState: HostStateStore = createHostState(link)

/**
 * Each host on another computer this device added: where main's link to it
 * stands, and its running sessions over the window's own connection to it
 * (`host/remoteHosts.ts`). Empty with sessions in Helm.
 */
export const remoteHosts: RemoteHostsStore = createRemoteHosts({ bridge: window.helm, log })

/**
 * Settings > Devices: each admin host's devices, over the window's own
 * connection to it, asking this computer for presence through main when a
 * host on another computer wants it (`host/devices.ts`).
 */
export const devices: Devices = createDevices({
  confirmPresence: (reason) => window.helm.invoke('presence:confirm', { reason }),
  log
})

/** The window's own connection to this PC's host, for Settings > Devices. */
export const localHostConnection = (): ReturnType<typeof link.connection> => link.connection()

/** Whether sessions run in the local host this run: main says once, when the window first asks. */
export const sessionsInHost = (): Promise<boolean> => link.inHost()

/**
 * With sessions in the local host, which of them have a tab in this window:
 * the layout is this device's own, so the window tells its own connection
 * which terminals to carry. Unused with the setting off.
 */
export const hostSessionTabs: Pick<typeof sessions, 'show' | 'release'> = {
  show: (ids) => sessions.show(ids),
  release: (id) => sessions.release(id)
}

/** The window's areas that reach the host over its own connection. */
export const hostAdapters: readonly HostAdapter[] = [
  createHistoryAdapter(link, log),
  workspace,
  createProfilesAdapter({ link, own: window.helm, log }),
  createConfigAdapter({ link, scanned: () => workspace.scannedProjects(), log }),
  createFilesAdapter(link, log),
  ...sessions,
  // A session a plugin asked for, started after the user's yes, opens as one of the window's tabs.
  createPluginsAdapter({ link, own: window.helm, adopt: (row) => sessions.adopt(row), log })
]

/**
 * The typed bridge, as a value the app can import.
 *
 * Everything in the renderer goes through this: there is no `ipcRenderer` here
 * to reach for, and a feature that wants a new capability has to add a channel
 * to `shared/ipc.ts`, where both ends are checked.
 *
 * With "Run sessions in the local host" off it is the preload's bridge. With
 * it on, each channel `boundary.rs` lists as client-only stays on the preload's
 * bridge, each a host adapter takes goes to the host over this window's own
 * connection, and any other is refused (`host/router.ts`); hooks see the same
 * shape either way.
 */
export const helm: HelmBridge = createRouter({
  own: window.helm,
  inHost: () => link.inHost(),
  adapters: hostAdapters,
  clientOnly: isClientOnly,
  hostInternal: isHostInternal,
  log
})
