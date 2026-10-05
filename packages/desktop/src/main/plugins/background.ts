import { BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'

/**
 * The window background pages run in: hidden, never shown, and only there
 * while an enabled plugin has a background page.
 *
 * One window for every plugin's background page, each an iframe on its
 * plugin's origin inside Helm's own small host page (`plugin-host.html`) -
 * the arrangement the window's panels and tabs have, for the same reasons:
 * the frame is out of Helm's process and in its plugin's, and its storage is
 * the storage the plugin's panels and tabs see. That last part is why it is a
 * frame inside a page from Helm's origin rather than a top-level page of its
 * own: Chromium partitions a frame's storage by the top-level site, so a
 * background page loaded on its own would not share `localStorage`,
 * IndexedDB or a `BroadcastChannel` with the plugin's panels.
 *
 * `backgroundThrottling: false` is the point of a background page: it polls
 * while Helm is minimised. It is not restarted when it crashes - the host
 * says so in Settings, and Reload is the way back.
 */

export interface BackgroundHost {
  /** Opens the window when something needs it and closes it when nothing does. */
  sync(needed: boolean): void
  contents(): WebContents | null
  shutdown(): void
}

export function createBackgroundHost(options: {
  /** Called when the host's own renderer died: every background page went with it. */
  onGone: (reason: string) => void
}): BackgroundHost {
  let win: BrowserWindow | null = null

  const open = (): BrowserWindow => {
    const created = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        backgroundThrottling: false
      }
    })
    created.webContents.on('render-process-gone', (_event, details) => {
      options.onGone(details.reason)
      if (win === created) {
        win = null
        created.destroy()
      }
    })
    created.on('closed', () => {
      if (win === created) win = null
    })
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void created.loadURL(`${devUrl}/plugin-host.html`)
    else void created.loadFile(join(__dirname, '../renderer/plugin-host.html'))
    return created
  }

  return {
    sync(needed) {
      if (needed && (win === null || win.isDestroyed())) win = open()
      if (!needed && win !== null) {
        const closing = win
        win = null
        if (!closing.isDestroyed()) closing.destroy()
      }
    },
    contents: () => (win === null || win.isDestroyed() ? null : win.webContents),
    shutdown() {
      const closing = win
      win = null
      if (closing !== null && !closing.isDestroyed()) closing.destroy()
    }
  }
}
