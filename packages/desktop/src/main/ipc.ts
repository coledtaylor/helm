import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { suggestRoots } from '@helm/core'
import { readClaudeVersion } from './claude-cli'
import { appMode, dataDir, dbFile } from './paths'
import { activePty } from './pty'
import { cachedProjects, runScan, updateSettings, type Services } from './services'
import type {
  EventChannel,
  EventPayload,
  IpcRequests,
  RequestChannel,
  ResolvedTheme,
  SendChannel,
  SendPayload
} from '../shared/ipc'

/**
 * The main-process half of the contract.
 *
 * `RequestHandlers` is `Record<RequestChannel, ...>`, so leaving a channel
 * unhandled does not compile. Nothing in this process may call `ipcMain.handle`
 * outside `registerIpc` - that is what keeps the surface enumerable.
 */

type RequestHandlers = {
  [K in RequestChannel]: (
    payload: IpcRequests[K]['request'],
    event: Electron.IpcMainInvokeEvent
  ) => IpcRequests[K]['response'] | Promise<IpcRequests[K]['response']>
}

type SendHandlers = {
  [K in SendChannel]: (payload: SendPayload<K>, event: Electron.IpcMainEvent) => void
}

export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** Typed `webContents.send`. The only way the main process pushes to a window. */
export function emit<K extends EventChannel>(
  win: BrowserWindow | null,
  channel: K,
  payload: EventPayload<K>
): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

export interface IpcContext {
  services: Services
  window: () => BrowserWindow | null
  /** Called when the renderer reports it has mounted. */
  rendererReady: () => void
}

export function registerIpc(ctx: IpcContext): void {
  const { services } = ctx

  const requests: RequestHandlers = {
    'app:info': async () => ({
      version: app.getVersion(),
      mode: appMode,
      dataDir,
      dbFile,
      migrations: [...services.store.migrations.applied, ...services.store.migrations.alreadyApplied],
      versions: {
        electron: process.versions['electron'] ?? 'unknown',
        chrome: process.versions['chrome'] ?? 'unknown',
        node: process.versions['node'] ?? 'unknown'
      },
      claudeVersion: await readClaudeVersion()
    }),

    'settings:read': () => services.settings,

    'settings:write': (patch) => {
      const next = updateSettings(services, patch)
      emit(ctx.window(), 'settings:changed', next)
      if (patch.theme !== undefined) {
        nativeTheme.themeSource = patch.theme
        emit(ctx.window(), 'theme:changed', {
          preference: next.theme,
          resolved: resolvedTheme()
        })
      }
      return next
    },

    'discovery:cached': () => cachedProjects(services),

    'discovery:scan': async (payload) => {
      emit(ctx.window(), 'scan:status', { running: true })
      try {
        const result = await runScan(services, { includeGit: payload?.includeGit ?? true })
        emit(ctx.window(), 'discovery:updated', result)
        return result
      } finally {
        emit(ctx.window(), 'scan:status', { running: false })
      }
    },

    'roots:suggest': () => suggestRoots(),

    'roots:add': async () => {
      const win = ctx.window()
      const result = win
        ? await dialog.showOpenDialog(win, {
            title: 'Add a folder to scan',
            properties: ['openDirectory', 'multiSelections']
          })
        : await dialog.showOpenDialog({
            title: 'Add a folder to scan',
            properties: ['openDirectory', 'multiSelections']
          })
      if (result.canceled || result.filePaths.length === 0) return services.settings.scanRoots

      const merged = [...services.settings.scanRoots]
      for (const path of result.filePaths) {
        if (!merged.some((existing) => existing.toLowerCase() === path.toLowerCase())) {
          merged.push(path)
        }
      }
      const next = updateSettings(services, { scanRoots: merged })
      emit(ctx.window(), 'settings:changed', next)
      return next.scanRoots
    },

    'roots:remove': ({ path }) => {
      const merged = services.settings.scanRoots.filter(
        (existing) => existing.toLowerCase() !== path.toLowerCase()
      )
      const next = updateSettings(services, { scanRoots: merged })
      emit(ctx.window(), 'settings:changed', next)
      return next.scanRoots
    },

    'theme:resolved': () => resolvedTheme(),

    'shell:showItem': ({ path }) => {
      shell.showItemInFolder(path)
    },

    'clipboard:read': () => clipboard.readText(),
    'clipboard:write': (text) => {
      clipboard.writeText(text)
    }
  }

  const sends: SendHandlers = {
    'renderer:ready': () => ctx.rendererReady(),

    'pty:input': (data) => {
      activePty()?.pty.write(data)
    },

    'pty:resize': ({ cols, rows }) => {
      try {
        activePty()?.pty.resize(cols, rows)
      } catch {
        // The pty may have exited between the resize event and this call.
      }
    },

    // Consumed by one-shot `ipcMain.once` listeners in the spike drivers, which
    // register alongside these. A no-op here keeps the contract exhaustive
    // without stealing the event.
    'term:created': () => undefined,
    'term:resized': () => undefined,
    'probe:res': () => undefined
  }

  // The maps above are where the types are checked. Registration itself is
  // uniform, so the payload is `unknown` here by construction - Electron cannot
  // know which channel it is dispatching.
  for (const [channel, handler] of Object.entries(requests) as Array<
    [string, (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown]
  >) {
    ipcMain.handle(channel, (event, payload: unknown) => handler(payload, event))
  }

  for (const [channel, handler] of Object.entries(sends) as Array<
    [string, (payload: unknown, event: Electron.IpcMainEvent) => void]
  >) {
    ipcMain.on(channel, (event, payload: unknown) => handler(payload, event))
  }

  nativeTheme.themeSource = services.settings.theme
  nativeTheme.on('updated', () => {
    emit(ctx.window(), 'theme:changed', {
      preference: services.settings.theme,
      resolved: resolvedTheme()
    })
  })
}
