import type { HelmBridge } from '../../../shared/ipc'

declare global {
  interface Window {
    /** Injected by the preload. The renderer's only route to the main process. */
    readonly helm: HelmBridge
  }
}

/**
 * The typed bridge, as a value the app can import.
 *
 * Everything in the renderer goes through this: there is no `ipcRenderer` here
 * to reach for, and a feature that wants a new capability has to add a channel
 * to `shared/ipc.ts`, where both ends are checked.
 */
export const helm: HelmBridge = window.helm
