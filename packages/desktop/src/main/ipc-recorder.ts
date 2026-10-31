import { app, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

/**
 * Records every Electron IPC channel Helm uses, and which page used it, for
 * the end-to-end test that holds Electron IPC to what `boundary.rs` lists as
 * client-only. It hooks Electron's own entry points: each `ipcMain` handler as
 * it is called, each listener's message as it arrives, and each web
 * contents' `send`. It records channel names only, never a payload.
 *
 * Off unless `HELM_RECORD_IPC` is `1`, which only the e2e fixture sets, and
 * never in a packaged build.
 */

export const RECORD_IPC_ENV = 'HELM_RECORD_IPC'

/** Which page used a channel: Helm's window, the plugins' background window, or another page. */
export type RecordedPage = 'window' | 'background' | 'other'

export interface RecordedChannel {
  channel: string
  /** `invoke` and `send` are a page's; `event` is main's, to the page. */
  kind: 'invoke' | 'send' | 'event'
  page: RecordedPage
}

/** Where the record is read from, by `app.evaluate` in the test. */
export const RECORD_GLOBAL = '__helmIpcChannels'

const EMITTER_EVENTS = new Set(['newListener', 'removeListener', 'error'])

function pageOf(contents: WebContents | null | undefined): RecordedPage {
  if (contents === null || contents === undefined || contents.isDestroyed()) return 'other'
  let path: string
  try {
    path = new URL(contents.getURL()).pathname
  } catch {
    return 'other'
  }
  if (path.endsWith('/plugin-host.html')) return 'background'
  if (path.endsWith('/index.html') || path === '/') return 'window'
  return 'other'
}

export function installIpcRecorder(): void {
  if (app.isPackaged || process.env[RECORD_IPC_ENV] !== '1') return
  const seen = new Map<string, RecordedChannel>()
  const record = (channel: string, kind: RecordedChannel['kind'], contents: WebContents | null | undefined): void => {
    const page = pageOf(contents)
    const key = `${kind} ${channel} ${page}`
    if (!seen.has(key)) seen.set(key, { channel, kind, page })
  }
  ;(globalThis as Record<string, unknown>)[RECORD_GLOBAL] = (): RecordedChannel[] => [...seen.values()]

  // Every message a listener hears arrives through `emit`, whoever listens.
  const emit = ipcMain.emit.bind(ipcMain)
  ipcMain.emit = (channel: string | symbol, ...args: unknown[]): boolean => {
    // The emitter's own events are not messages.
    if (typeof channel === 'string' && !EMITTER_EVENTS.has(channel)) {
      record(channel, 'send', (args[0] as IpcMainEvent | undefined)?.sender)
    }
    return emit(channel, ...args)
  }

  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const recorded =
    (channel: string, handler: Handler): Handler =>
    (event, ...args) => {
      record(channel, 'invoke', event.sender)
      return handler(event, ...args)
    }
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel: string, handler: Handler): void => handle(channel, recorded(channel, handler))
  const handleOnce = ipcMain.handleOnce.bind(ipcMain)
  ipcMain.handleOnce = (channel: string, handler: Handler): void => handleOnce(channel, recorded(channel, handler))

  app.on('web-contents-created', (_event, contents) => {
    const send = contents.send.bind(contents)
    contents.send = (channel: string, ...args: unknown[]): void => {
      record(channel, 'event', contents)
      send(channel, ...args)
    }
  })
}
