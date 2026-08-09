import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  REQUEST_CHANNELS,
  SEND_CHANNELS,
  type EventChannel,
  type EventPayload,
  type HelmBridge,
  type RequestChannel,
  type SendChannel
} from '../shared/ipc'

/**
 * The entire bridge between the renderer and the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so this file is the
 * only code with access to both worlds. It deliberately exposes three generic
 * functions rather than one method per feature: a feature cannot widen the
 * surface by adding a method here, only by adding a channel to the contract,
 * where the compiler checks both ends.
 *
 * Channel names are validated against the contract's lists before anything
 * crosses. A renderer compromised badly enough to call `invoke` with an
 * arbitrary string still cannot reach a channel Helm did not declare.
 */

const requests = new Set<string>(REQUEST_CHANNELS)
const sends = new Set<string>(SEND_CHANNELS)
const events = new Set<string>(EVENT_CHANNELS)

const bridge: HelmBridge = {
  invoke: ((channel: RequestChannel, payload?: unknown) => {
    if (!requests.has(channel)) {
      return Promise.reject(new Error(`unknown request channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, payload)
  }) as HelmBridge['invoke'],

  send: ((channel: SendChannel, payload?: unknown) => {
    if (!sends.has(channel)) throw new Error(`unknown send channel: ${String(channel)}`)
    ipcRenderer.send(channel, payload)
  }) as HelmBridge['send'],

  on: (<K extends EventChannel>(channel: K, listener: (payload: EventPayload<K>) => void) => {
    if (!events.has(channel)) throw new Error(`unknown event channel: ${String(channel)}`)
    // The IpcRendererEvent is not forwarded: it carries `sender` and `ports`,
    // which are main-process objects the renderer has no business holding.
    const wrapped = (_e: unknown, payload: EventPayload<K>): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }) as HelmBridge['on']
}

contextBridge.exposeInMainWorld('helm', bridge)
