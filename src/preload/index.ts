import { contextBridge, ipcRenderer } from 'electron'
import type { ProbeOp, TermCreateOptions } from '../shared/protocol'

contextBridge.exposeInMainWorld('helm', {
  ready: () => ipcRenderer.send('renderer:ready'),
  input: (data: string) => ipcRenderer.send('pty:input', data),
  resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),

  termCreated: (info: unknown) => ipcRenderer.send('term:created', info),
  termResized: () => ipcRenderer.send('term:resized'),
  onTermCreate: (cb: (opts: TermCreateOptions) => void) =>
    ipcRenderer.on('term:create', (_e, opts) => cb(opts)),
  onTermResize: (cb: (size: { cols: number; rows: number }) => void) =>
    ipcRenderer.on('term:resize', (_e, size) => cb(size)),
  onTermWrite: (cb: (data: string) => void) =>
    ipcRenderer.on('term:write', (_e, data) => cb(data)),

  clipboardRead: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),

  // Request/response the other way round: main asks the renderer to inspect or
  // drive the live terminal.
  onProbe: (handler: (req: ProbeOp) => unknown) =>
    ipcRenderer.on('probe:req', (_e, { id, req }: { id: number; req: ProbeOp }) => {
      let value: unknown
      try {
        value = handler(req)
      } catch (err) {
        value = { error: String(err) }
      }
      ipcRenderer.send('probe:res', { id, value })
    })
})
