import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron'
import { FOREIGN_PAGE, type HelmPage, type HostPageLinks } from './host/page-link'
import type { RemoteHostLinks } from './host/remote'
import type { PortForwards } from './host/forwards'
import type { RemoteInstaller } from './host/remote-install'
import type { RemoteHostAdder } from './host/remote-add'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { pluginThemeOf, type AppSettings } from '@helm/core'
import { remoteHostsProblem, type SshConfigHosts, type WslDistroList } from '@helm/core/types'
import type { BrowserHost } from './browser'
import type { BrowserMcpHost } from './browser-mcp'
import type { FilesService } from './files'
import { applyWindowTheme } from './chrome'
import type { ThemeService } from './themes'
import { setClaudeOverride } from './claude-cli'
import { checkForUpdate, RELEASES_PAGE } from './update'
import { appMode, dataDir, dbFile } from './paths'
import type { PluginHost } from './plugins/host'
import type { OwnDataCopy } from './host/own-data'
import type { HostPlugins } from './host/plugins'
import type { RemotePlugins } from './host/remote-plugins'
import { activePty, windowsBuildNumber } from './pty'
import { createClipboardText } from './clipboard'
import { nativeProfileDialogs } from './profiles'
import { updateSettings, type Services } from './services'
import type { WorkspaceService } from './host/workspace'
import { registerConfirmAnswers, showExitNotification, showNeedsYouNotification } from './host/confirm'
import { isClientOnly, isHostInternal } from '../shared/host/protocol'
import type {
  EventChannel,
  EventPayload,
  IpcRequests,
  LocalHostRestartOffer,
  OwnAppInfo,
  RequestChannel,
  SendChannel,
  SendPayload
} from '../shared/ipc'

/**
 * The main-process half of the contract.
 *
 * Main handles only what `boundary.rs` lists as client-only, and the
 * host-internal channels from the hidden plugin window: every other channel
 * is the host's, which each Helm page reaches over its own connection, so
 * main has no handler for it and the page's router refuses it
 * (`renderer/src/app/host/router.ts`). `ipc.boundary.test.ts` checks both
 * halves. Nothing in this process may call `ipcMain.handle` outside
 * `registerIpc` - that is what keeps the surface enumerable.
 */

type RequestHandlers = {
  [K in RequestChannel]?: (
    payload: IpcRequests[K]['request'],
    event: Electron.IpcMainInvokeEvent
  ) => IpcRequests[K]['response'] | Promise<IpcRequests[K]['response']>
}

type SendHandlers = {
  [K in SendChannel]?: (payload: SendPayload<K>, event: Electron.IpcMainEvent) => void
}

/**
 * Repaints everything the theme reaches that is not the renderer's CSS - the
 * window's own background and the title-bar buttons - and tells the renderer.
 *
 * One function for every cause, because there are four and they must agree: a
 * settings write, Windows changing mode, a theme file saved, and the renderer
 * announcing it is listening. Each of them is "the answer to `state()` may
 * have moved", and nothing about which one it was changes what to paint.
 */
export function pushTheme(ctx: Pick<IpcContext, 'services' | 'themes' | 'window' | 'plugins'>): void {
  const state = ctx.themes.state(ctx.services.settings)
  applyWindowTheme(ctx.window(), state.applied)
  emit(ctx.window(), 'theme:changed', state)
  // Plugin pages follow too: the same colours, and the corner and density
  // settings their controls are drawn with.
  ctx.plugins.pushTheme(pluginThemeOf(state.applied, ctx.services.settings))
}

/** A web contents as the page relay sees it: its id, its two events, and when it navigates away or closes. */
export function helmPageOf(contents: WebContents): HelmPage {
  return {
    id: contents.id,
    send: (channel, payload) => {
      if (!contents.isDestroyed()) contents.send(channel, payload)
    },
    onGone: (listener) => {
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) listener()
      })
      contents.once('destroyed', listener)
    }
  }
}

/** Typed `webContents.send` to one page's web contents, such as the hidden plugin window's. */
export function emitToContents<K extends EventChannel>(
  contents: WebContents | null | undefined,
  channel: K,
  payload: EventPayload<K>
): void {
  if (contents === null || contents === undefined || contents.isDestroyed()) return
  contents.send(channel, payload)
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
  /** Each Helm page's own connections to the local host and to each remote host; see `host/page-link.ts`. */
  pageLinks: HostPageLinks
  /**
   * The links to the hosts on other computers this device added; see
   * `host/remote.ts`. A settings write that changes `hosts` starts or ends them.
   */
  remoteHosts: RemoteHostLinks
  /** Installs and updates floti on those hosts' computers, after a yes; see `host/remote-install.ts`. */
  remoteInstall: RemoteInstaller
  /** Adds a host by connecting to it; see `host/remote-add.ts`. */
  remoteAdd: RemoteHostAdder
  /** The Host names in this PC's `~/.ssh/config`, for the add-a-host dialog; see `host/ssh-config.ts`. */
  sshHosts: () => Promise<SshConfigHosts>
  /** The WSL distros on this PC and on each connected Windows host (`wsl-distros.ts`). */
  wslDistros: () => Promise<WslDistroList[]>
  /** The ports of those hosts' sessions forwarded to this PC's loopback; see `host/forwards.ts`. */
  forwards: PortForwards
  /** Owns the browser pane's `WebContentsView`s; see `browser.ts`. */
  browsers: BrowserHost
  /**
   * Answers the browser calls the host relays for its sessions; see
   * `browser-mcp.ts`. Nothing on any channel reaches it, and nothing ever
   * should.
   */
  browserMcp: BrowserMcpHost | null
  /**
   * The local host's scan roots, for `roots:add`: the window's picker is its
   * own, and the folders chosen go to the host (`host/workspace.ts`).
   */
  workspace: WorkspaceService
  /** Opening a file in the editor on this PC; see `files.ts`. */
  files: FilesService
  /** Built-in and user themes, and the watch on the user's; see `themes.ts`. */
  themes: ThemeService
  /** The plugin pages' frames, runtime and theme, and the tool relay; see `plugins/host.ts`. */
  plugins: PluginHost
  /** The hidden window's reports of the local host's background pages it runs; see `host/plugins.ts`. */
  hostPlugins: HostPlugins
  /**
   * Each remote host's plugins (`host/remote-plugins.ts`), whose background
   * pages the hidden window runs on that host's origin and reports by host.
   */
  remotePlugins: RemotePlugins
  /** The hidden window plugins' background pages run in. */
  pluginBackground: () => Electron.WebContents | null
  /** This PC's host: how many sessions it runs, and stopping it once the user has agreed. */
  localHost: LocalHostControl
  /** The copy of Helm's own database into the local host (`host/own-data.ts`): its state answers `ownData:state`. */
  ownData: OwnDataCopy
  /** Called when the renderer reports it has mounted. */
  rendererReady: () => void
  /**
   * Called when the `claude` path, the terminal shell, the archive's ceiling,
   * either browser tools setting or the session tools setting changes: the
   * local host is told all of them.
   */
  hostSettingsChanged: () => void
  /**
   * Stands in for the native file and directory pickers.
   *
   * A native dialog has no automation surface, so the first-run driver - which
   * has to prove that "add a folder" and "locate claude" work end to end -
   * cannot click one. Same reasoning as the session host's `Confirm`: the
   * question is answered by the driver, and every other step still goes through
   * the real handler and the real settings write.
   *
   * Only `--packaging-firstrun` passes these. The app itself passes none and gets the
   * dialogs.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
}

/** What Settings' Stop host reaches: main holds the link to this PC's host. */
export interface LocalHostControl {
  /** How many sessions are running in the host, whichever device started them. */
  sessionCount(): Promise<number>
  /** Stops it with the plain-stop reason: every session ends, and none is offered back. */
  stop(): Promise<void>
  /** What restarting it on the floti this Helm carries would end, asked without changing anything. */
  restartAsk(): Promise<LocalHostRestartOffer>
  /** Restarts it on the floti this Helm carries and connects to the new host; on the user's click only. */
  restart(): Promise<void>
}

/**
 * How main handles a channel: a client-only one from any Helm page, a
 * host-internal one only from the hidden plugin window, and any other never.
 */
export function mainHandles(channel: string): 'always' | 'fromPluginWindow' | 'never' {
  if (isClientOnly(channel)) return 'always'
  return isHostInternal(channel) ? 'fromPluginWindow' : 'never'
}

export function registerIpc(ctx: IpcContext): void {
  const { services, workspace } = ctx
  registerConfirmAnswers()
  /** Whether a message came from the hidden plugin window, the only page a host-internal channel is taken from. */
  const fromPluginWindow = (sender: WebContents): boolean => ctx.pluginBackground()?.id === sender.id
  // One for the app, so a later copy supersedes one still retrying.
  const clipboardText = createClipboardText(clipboard)

  const profileDialogs = nativeProfileDialogs(ctx.window)

  /** What this build says of itself. */
  const ownAppInfo = (): OwnAppInfo => ({
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
    windowsBuild: windowsBuildNumber() ?? null,
    home: homedir(),
    releasesUrl: RELEASES_PAGE
  })

  /**
   * What follows any write to Helm's settings, from either half: the session
   * host reads the override, not the settings, so a picked CLI written here has
   * to reach it too - otherwise sessions launch from one path and
   * `claude mcp add` from another.
   */
  const settingsWritten = (patch: Partial<AppSettings>, next: AppSettings): void => {
    if (patch.claudePath !== undefined) setClaudeOverride(next.claudePath)
    // A host added starts its link; one removed has its link let go of, with
    // nothing said to it, and its client folder removed.
    if (patch.hosts !== undefined) ctx.remoteHosts?.sync(next.hosts)
    // Sessions run the `claude` and open the shell the host was told, and get
    // the browser and session tools and the browser's reach as it was told,
    // and can start agents of their own within the limits it was told, and
    // the host holds its archive to the ceiling it was told, so it is told
    // again at once when any of those changes.
    if (
      patch.claudePath !== undefined ||
      patch.terminalShell !== undefined ||
      patch.transcriptArchiveMaxBytes !== undefined ||
      patch.browserMcp !== undefined ||
      patch.browserMcpLocalOnly !== undefined ||
      patch.sessionMcp !== undefined ||
      patch.sessionAgents !== undefined ||
      patch.agentChildrenPerParent !== undefined ||
      patch.agentSessionsPerHost !== undefined ||
      patch.agentDepth !== undefined ||
      patch.agentStartsPerParent !== undefined ||
      patch.agentHeavyPerHost !== undefined
    ) {
      ctx.hostSettingsChanged()
    }
    if (patch.theme !== undefined) nativeTheme.themeSource = patch.theme
    if (
      patch.theme !== undefined ||
      patch.themeDark !== undefined ||
      patch.themeLight !== undefined ||
      patch.accentColor !== undefined
    ) {
      pushTheme(ctx)
    } else if (patch.cornerRadius !== undefined || patch.density !== undefined) {
      // Shape is not part of the window's theme, but it is part of a plugin's.
      ctx.plugins.pushTheme(pluginThemeOf(ctx.themes.state(next).applied, next))
    }
  }

  const requests: RequestHandlers = {
    // Only a Helm page's own frame: never a frame inside it, which is where
    // an artifact or a plugin page would be.
    'hostLink:open': (payload, event) => {
      if (event.senderFrame !== event.sender.mainFrame) return Promise.reject(new Error(FOREIGN_PAGE))
      return ctx.pageLinks.open(helmPageOf(event.sender), payload?.host ?? null)
    },

    'remoteHosts:read': () => ctx.remoteHosts.states(),
    'remoteHosts:check': (target) => {
      if ('host' in target) {
        const host = ctx.services.settings.hosts.find((each) => each.id === target.host)
        if (host === undefined) return Promise.reject(new Error('This PC has no such host.'))
        return ctx.remoteInstall.check({ transport: host.transport, floti: host.floti })
      }
      // A host being added is checked as the settings would keep it.
      const problem = remoteHostsProblem([{ id: 'checked', name: 'checked', transport: target.transport, ...(target.floti !== undefined ? { floti: target.floti } : {}) }])
      if (problem !== null) return Promise.reject(new Error(problem))
      const remoteInstall = ctx.remoteInstall
      const { attempt, ...checked } = target
      // A check for the add-a-host dialog stops with its Cancel.
      if (attempt !== undefined) {
        return ctx.remoteAdd.during(attempt, (signal) => remoteInstall.check(checked, signal))
      }
      return remoteInstall.check(checked)
    },
    'remoteHosts:sshHosts': () => ctx.sshHosts(),
    'remoteHosts:wslDistros': () => ctx.wslDistros(),
    'remoteHosts:add': (request) => {
      const { remoteAdd, remoteHosts } = ctx
      return remoteAdd.add(request, (host, connected) => {
        // The link takes the connection the add made, then the write that
        // lists the host keeps that link rather than making another.
        remoteHosts.adopt(host, connected)
        try {
          const next = updateSettings(services, { hosts: [...services.settings.hosts, host] })
          emit(ctx.window(), 'ownSettings:changed', next)
          settingsWritten({ hosts: next.hosts }, next)
        } catch (error) {
          // Not written: the link it was given is let go of, with its folder.
          remoteHosts.sync(services.settings.hosts)
          throw error
        }
      })
    },
    'remoteHosts:cancelAdd': ({ attempt }) => {
      ctx.remoteAdd.cancel(attempt)
    },
    'remoteHosts:install': async ({ id, host }) => {
      const outcome = await ctx.remoteInstall.install(id)
      if (outcome.ok) ctx.remoteHosts.installed(host, outcome.floti, outcome.startsAtNextSignIn)
      return outcome
    },
    'remoteHosts:cancel': ({ id }) => {
      ctx.remoteInstall.cancel(id)
    },
    'remoteHosts:reconnect': ({ id }) => {
      ctx.remoteHosts.reconnect(id)
    },
    'forwards:open': ({ host, session, port }) => ctx.forwards.open(host, session, port),
    'forwards:read': () => ctx.forwards.list(),

    'ownApp:info': () => ownAppInfo(),
    'ownData:state': () => ctx.ownData.state(),
    'windowSessions:lostLayout': () => services.lost.layout,
    'windowSessions:hostSessionCount': () => ctx.localHost.sessionCount(),
    'windowSessions:stopHost': () => ctx.localHost.stop(),
    'windowSessions:restartAsk': () => ctx.localHost.restartAsk(),
    'windowSessions:restartHost': () => ctx.localHost.restart(),
    'pluginBackground:states': () => [...ctx.hostPlugins.reports(), ...ctx.remotePlugins.reports()],

    // The window keeps the host's half of the settings over its own
    // connection and Helm's half here.
    'ownSettings:read': () => services.settings,

    'ownSettings:write': (patch) => {
      const next = updateSettings(services, patch)
      emit(ctx.window(), 'ownSettings:changed', next)
      settingsWritten(patch, next)
      return next
    },

    'profileDialog:confirmDelete': async ({ name }) => ({ confirmed: await profileDialogs.confirmDelete(name) }),

    'profileDialog:export': async ({ fileName, yaml }) => {
      const file = await profileDialogs.chooseExportFile(fileName)
      if (file === null) return { file: null }
      await writeFile(file, yaml, 'utf8')
      return { file }
    },

    'profileDialog:import': async () => {
      const file = await profileDialogs.chooseImportFile()
      if (file === null) return { cancelled: true }
      try {
        return { cancelled: false, fileName: basename(file), yaml: await readFile(file, 'utf8') }
      } catch (error) {
        return { cancelled: false, error: `${basename(file)}: ${(error as Error).message}` }
      }
    },

    // The picker is the window's own; the folders chosen go to the host's scan
    // roots.
    'roots:add': async () => {
      const title = 'Add a folder to scan'
      if (ctx.chooseDirectory) {
        const picked = ctx.chooseDirectory(title)
        return picked === null ? (await workspace.settings()).scanRoots : workspace.acceptRoots([picked])
      }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ['openDirectory', 'multiSelections']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return (await workspace.settings()).scanRoots
      return workspace.acceptRoots(result.filePaths)
    },

    'path:chooseDirectory': async ({ title }) => {
      if (ctx.chooseDirectory) return { path: ctx.chooseDirectory(title ?? 'Choose a folder') }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: title ?? 'Choose a folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'path:chooseFile': async ({ title }) => {
      const heading = title ?? 'Choose a program'
      if (ctx.chooseFile) return { path: ctx.chooseFile(heading) }
      const win = ctx.window()
      const options: Electron.OpenDialogOptions = {
        title: heading,
        properties: ['openFile'],
        filters:
          process.platform === 'win32'
            ? [
                { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
                { name: 'All files', extensions: ['*'] }
              ]
            : [{ name: 'All files', extensions: ['*'] }]
      }
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },

    'update:check': () => checkForUpdate(),

    'theme:resolved': () => ctx.themes.state(services.settings).resolved,
    'theme:current': () => ctx.themes.state(services.settings),
    'themes:list': () => ctx.themes.listing(),
    'themes:openFolder': async () => {
      ctx.themes.ensureDir()
      // `openPath` resolves to an error *string* rather than rejecting, and a
      // folder that would not open is worth a sentence rather than nothing.
      const problem = await shell.openPath(ctx.themes.dir)
      if (problem !== '') throw new Error(problem)
    },
    // Not revealed here: the pane asks `shell:showItem` for that, so a check
    // can make a copy without a file manager opening on somebody's desktop.
    'themes:duplicate': ({ id }) => ({ file: ctx.themes.duplicate(id) }),

    'shell:showItem': ({ path }) => {
      shell.showItemInFolder(path)
    },

    'files:editor': () => ({ name: ctx.files.editor() }),
    'files:openInEditor': ({ path, line }) => ctx.files.openInEditor(path, line),

    // A link in a note or a terminal is the user's, not Helm's, so it opens
    // where they expect links to open. The scheme check is the whole security
    // of this handler: `shell.openExternal` will happily hand a `file:` URL to
    // the shell, which on Windows is a way to run whatever it points at.
    'shell:openExternal': async ({ url }) => {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return { opened: false }
      }
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return { opened: false }
      await shell.openExternal(parsed.toString())
      return { opened: true }
    },

    'clipboard:read': () => clipboardText.read(),
    'clipboard:write': async (text) => ({ outcome: await clipboardText.write(text) }),

    /*
     * The browser pane. Every handler is a one-line delegation on purpose:
     * every decision behind them - what a typed address means, whether the
     * reach posture allows it, what hiding is - lives in `main/browser.ts` and
     * `@helm/core`, so there is exactly one place either could be got wrong.
     */
    'browser:open': (request) => ctx.browsers.open(request),
    'browser:navigate': ({ id, input }) => ctx.browsers.navigate(id, input),
    'browser:back': ({ id }) => ctx.browsers.back(id),
    'browser:forward': ({ id }) => ctx.browsers.forward(id),
    'browser:reload': ({ id, hard }) => ctx.browsers.reload(id, hard === true),
    'browser:close': ({ id }) => ctx.browsers.close(id),
    'browser:state': ({ id }) => ctx.browsers.states(id),
    'browser:eval': ({ id, source }) => ctx.browsers.evaluate(id, source),
    'browser:devtools': ({ id }) => ctx.browsers.devtools(id),
    'browser:find': ({ id, query, forward }) => ctx.browsers.find(id, query, forward !== false),
    'browser:stopFind': ({ id }) => ctx.browsers.stopFind(id),
    'browser:zoom': ({ id, level }) => ctx.browsers.zoom(id, level),
    'browser:clearStorage': ({ id }) => ctx.browsers.clearStorage(id),
    'browser:console': ({ id }) => ctx.browsers.entries(id),
    'browser:snapshot': ({ id }) => ctx.browsers.snapshot(id),
    'browser:shareTargets': () => ctx.browsers.shareTargets(),
    'browser:share': ({ id, session }) => ctx.browsers.share(id, session)
  }

  const sends: SendHandlers = {
    'renderer:ready': () => ctx.rendererReady(),

    // Bytes pass unread; the relay drops any not from the page that opened the connection.
    'hostLink:send': ({ connection, bytes }, event) => ctx.pageLinks.send(event.sender.id, connection, bytes),
    'hostLink:close': ({ connection }, event) => ctx.pageLinks.close(event.sender.id, connection),

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

    'browser:bounds': (payload) => ctx.browsers.bounds(payload),

    // A remote host's report goes to that host's plugins only.
    'plugins:backgroundState': ({ plugin, revision, state, error, host }) =>
      host !== undefined
        ? ctx.remotePlugins.forHost(host)?.backgroundState(plugin, revision, state, error)
        : ctx.hostPlugins.backgroundState(plugin, revision, state, error),
    // A background page's ask that only the window can draw, from the hidden
    // window, and the window's word that a secret dialog it asked for closed.
    'pluginWindow:ask': (request, event) => {
      if (ctx.pluginBackground()?.id === event.sender.id) emit(ctx.window(), 'pluginWindow:asked', request)
    },
    'pluginWindow:answer': (answer, event) => {
      const win = ctx.window()
      const hidden = ctx.pluginBackground()
      if (win === null || win.webContents.id !== event.sender.id || hidden === null || hidden.isDestroyed()) return
      hidden.send('pluginWindow:answered', answer)
    },
    'plugins:toolResult': (outcome, event) => ctx.plugins.toolResult(outcome, event.sender.id),

    // Consumed by one-shot `ipcMain.once` listeners in the spike drivers, which
    // register alongside these. A no-op here keeps the contract exhaustive
    // without stealing the event.
    'term:created': () => undefined,
    'term:resized': () => undefined,
    'probe:res': () => undefined,
    // Same shape: the real listener is the one `sessions.ts` registers at
    // module scope, which is the side holding the promise this answers.
    'windowSessions:quitConfirmed': () => undefined,
    // The host judged nobody saw this exit, from what the window said was on
    // screen; only main can show the OS notification.
    'windowSessions:notify': (record) => {
      showExitNotification(ctx.window, record)
    },
    // A child began to need a person while the window is not in front.
    'windowSessions:needsYou': (notification) => {
      showNeedsYouNotification(ctx.window, notification)
    }
  }

  // The maps above are where the types are checked. Registration itself is
  // uniform, so the payload is `unknown` here by construction - Electron cannot
  // know which channel it is dispatching.
  for (const [channel, handler] of Object.entries(requests) as Array<
    [string, (payload: unknown, event: Electron.IpcMainInvokeEvent) => unknown]
  >) {
    const handles = mainHandles(channel)
    if (handles === 'never') throw new Error(`${channel} is the host's; main has no handler for it.`)
    ipcMain.handle(channel, (event, payload: unknown) => {
      if (handles === 'fromPluginWindow' && !fromPluginWindow(event.sender)) {
        return Promise.reject(new Error(`${channel} is taken only from the hidden plugin window.`))
      }
      return handler(payload, event)
    })
  }

  /*
   * A send that throws must not take the process with it.
   *
   * The asymmetry with `handle` above is the whole reason this exists: a
   * request that throws rejects its own promise and reaches the renderer as a
   * failed invoke, while a send has no reply to fail into - so an exception out
   * of one of these handlers is an **uncaught exception in the main process**,
   * and Electron answers that with its own error dialog over the app.
   *
   * That is not hypothetical. `browser:bounds` is sent on every
   * `ResizeObserver` tick of an open browser pane, and a view whose page had
   * closed itself made it throw every time: the dialog came back as fast as it
   * could be dismissed, which is what the bug report described. The fault
   * itself is fixed where it was, in `browser.ts`; this is here because the
   * next one should degrade rather than pop a dialog, and because a fire-and-
   * forget channel is exactly where a fault is least likely to be noticed
   * otherwise. Logged rather than swallowed, so it is still findable.
   */
  for (const [channel, handler] of Object.entries(sends) as Array<
    [string, (payload: unknown, event: Electron.IpcMainEvent) => void]
  >) {
    const handles = mainHandles(channel)
    if (handles === 'never') throw new Error(`${channel} is the host's; main has no handler for it.`)
    ipcMain.on(channel, (event, payload: unknown) => {
      if (handles === 'fromPluginWindow' && !fromPluginWindow(event.sender)) return
      try {
        handler(payload, event)
      } catch (err) {
        console.error(`ipc send ${channel} threw:`, err)
      }
    })
  }

  nativeTheme.themeSource = services.settings.theme
  // Windows changing mode only matters to `system`, but `updated` also fires
  // for high-contrast and inverted-colour changes, and re-resolving is cheap.
  nativeTheme.on('updated', () => pushTheme(ctx))
  ctx.themes.onChange(() => {
    emit(ctx.window(), 'themes:changed', ctx.themes.listing())
    // The edited file may be the theme on screen; if it is not, this paints
    // the same values again, which is nothing.
    pushTheme(ctx)
  })
}
