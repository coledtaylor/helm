import { isClientOnly } from '../../../shared/host/protocol'
import type { HelmBridge } from '../../../shared/ipc'
import { createConfigAdapter } from './host/config'
import { createFilesAdapter } from './host/files'
import { createHistoryAdapter } from './host/history'
import { WINDOW_CAPABILITIES, createPageLink } from './host/link'
import { createProfilesAdapter } from './host/profiles'
import { createRouter, type HostAdapter } from './host/router'
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

/** The window's areas that reach the host over its own connection. */
export const hostAdapters: readonly HostAdapter[] = [
  createHistoryAdapter(link, log),
  workspace,
  createProfilesAdapter({ link, own: window.helm, log }),
  createConfigAdapter({ link, scanned: () => workspace.scannedProjects(), log }),
  createFilesAdapter(link, log)
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
 * bridge and each a host adapter takes goes to the host over this window's own
 * connection (`host/router.ts`); hooks see the same shape either way.
 */
export const helm: HelmBridge = createRouter({
  own: window.helm,
  inHost: () => link.inHost(),
  adapters: hostAdapters,
  clientOnly: isClientOnly
})
