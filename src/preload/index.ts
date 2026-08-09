import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('helm', {
  ready: () => ipcRenderer.send('renderer:ready'),
  input: (data: string) => ipcRenderer.send('pty:input', data),
  resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
  termCreated: () => ipcRenderer.send('term:created'),
  termResized: () => ipcRenderer.send('term:resized'),
  onTermCreate: (cb: (opts: { cols: number; rows: number; fit: boolean }) => void) =>
    ipcRenderer.on('term:create', (_e, opts) => cb(opts)),
  onTermResize: (cb: (size: { cols: number; rows: number }) => void) =>
    ipcRenderer.on('term:resize', (_e, size) => cb(size)),
  onTermWrite: (cb: (data: string) => void) =>
    ipcRenderer.on('term:write', (_e, data) => cb(data))
})
