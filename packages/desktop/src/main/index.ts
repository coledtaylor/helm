import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  shell
} from 'electron'
import {
  addPluginFolder,
  claudeHome,
  pluginThemeOf,
  readSessionRegistry,
  sessionRegistryDir,
  writeSetting,
  type AppliedTheme,
  type AppSettings
} from '@helm/core'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { emit, pushTheme, registerIpc } from './ipc'
import { appMode, dataDir, initDataDir, mcpConfigDir, templatesDir, themesDir } from './paths'
import { createThemeService } from './themes'
import { activePty, killAllSessionsSync, killPty, spawnPty, windowsBuildNumber } from './pty'
import {
  adoptExistingProfile,
  createServices,
  refreshGit,
  runScan,
  updateSettings,
  type Services
} from './services'
import { createConfigService } from './config'
import { createTemplateService } from './templates'
import { createFilesService } from './files'
import {
  attachArtifactConsole,
  CONTENT_SCHEME,
  createContentService,
  registerContentProtocol
} from './content'
import { PLUGIN_SCHEME } from '../shared/ipc'
import { createPluginHost } from './plugins/host'
import { registerPluginProtocol } from './plugins/protocol'
import { guardPluginFrames, installPluginPermissions } from './plugins/guards'
// The plugin runtime: served to every plugin page under `/__helm/`, so no
// plugin carries a copy of its own (see `main/plugins/protocol.ts`).
import pluginBridge from '../renderer/plugin-runtime/bridge-entry.ts?script'
import pluginStylesheet from '../renderer/plugin-runtime/helm.css?raw'
import {
  browserWillNavigate,
  browserWindowOpen,
  createBrowserHost,
  type BrowserHost
} from './browser'
import { createBrowserMcp, type BrowserMcpHost } from './browser-mcp'
import { sessionToolsWorld, type SessionToolsWorld } from './session-tools'
import { createHistoryIndex } from './history'
import { createUsageService } from './usage'
import { maybeCheckForUpdate } from './update'
import { createSessionHost, type Confirm, type SessionObserver } from './sessions'
import { createActivityService } from './activity'
import { createRestoreService } from './restore'
import { createResourcesService } from './resources'
import { createCollector, type CheckContext } from './checkkit'
import { titleBarOverlayFor, windowBorderFor } from './chrome'
import { requestSmallCorners } from './corners'
import { createPtermHost } from './pterm'
import { runSelftest } from './selftest'
import { runFidelity } from './fidelity'
import { runClaudeChecks } from './claudecheck'
import { findClaudeExecutable, setClaudeOverride } from './claude-cli'
import { pickerAnswer, runPackagingChecks } from './packagingcheck'
import { screenshot } from './bridge'

/**
 * Two products in one binary.
 *
 * The default mode is the app: a window with the launcher, backed by SQLite and
 * project discovery. The `--selftest` / `--fidelity` / `--claude-check` /
 * `--claude` modes are Spike B and C's harnesses, kept because they are the
 * regression tests for the terminal configuration those spikes proved
 * load-bearing (CLAUDE.md, "Hard rules"). They render a different page and open
 * no database.
 */

type Mode =
  | 'app'
  | 'shell'
  | 'selftest'
  | 'fidelity'
  | 'claude-check'
  | 'claude'
  | 'packaging-check'
  | 'packaging-firstrun'

function modeFromArgv(): Mode {
  if (process.argv.includes('--selftest')) return 'selftest'
  if (process.argv.includes('--fidelity')) return 'fidelity'
  if (process.argv.includes('--claude-check')) return 'claude-check'
  if (process.argv.includes('--packaging-check')) return 'packaging-check'
  if (process.argv.includes('--packaging-firstrun')) return 'packaging-firstrun'
  if (process.argv.includes('--claude')) return 'claude'
  if (process.argv.includes('--shell')) return 'shell'
  return 'app'
}

const mode = modeFromArgv()
// The check modes are the app: they drive the real window, so they need the
// real startup path, the database included.
const isSpikeMode =
  mode !== 'app' &&
  mode !== 'packaging-check' &&
  mode !== 'packaging-firstrun'

/**
 * A check's window keeps rendering when something else is in front of it.
 *
 * Chromium backgrounds an occluded window: `requestAnimationFrame` stops and
 * timers are throttled to once a second. Every check here drives the **real
 * window** and measures what came back within a few hundred milliseconds - a
 * synthesised pointer move and then `getComputedStyle`, a drag and then the
 * pane's width - so a throttled renderer answers "nothing changed" to all of
 * it, which is indistinguishable from the app being broken.
 *
 * Measured on a machine running six Helm windows at once: a hover probe
 * measured 162 controls with its window in front and 7 with somebody else's on
 * top, reporting most of the app as having no hover state at all. The
 * alternative - raising or focusing our own window - is worse than the
 * problem, because every other window on that machine belongs to a check that
 * would then be the one being measured through a throttled renderer.
 *
 * Check and spike modes only. `app` is somebody's actual Helm, and a Helm
 * minimised behind an editor should go quiet like any other window.
 */
if (mode !== 'app') {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
}

initDataDir()

/**
 * The scheme HTML artifacts are served on, declared before the app is ready
 * because that is the only moment Chromium accepts a privileged scheme.
 *
 * `standard` gives it a real origin so relative URLs inside an artifact resolve
 * against the file's own directory; `secure` keeps it out of Chromium's
 * mixed-content and "not a secure context" penalty boxes. It is *not*
 * `corsEnabled` and does not `supportFetchAPI`: the frame gets no network, and
 * the way to make sure of that is to not build the doors.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: CONTENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
  },
  // A plugin's pages: an origin per plugin (`helm-plugin://<id>`), secure so
  // its storage and module scripts work, and no fetch - its network goes
  // through Helm. See `main/plugins/protocol.ts`.
  {
    scheme: PLUGIN_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
  }
])

/**
 * Every renderer is our own bundle; nothing else may be navigated to or opened.
 *
 * The browser pane's `WebContentsView`s are the one thing in Helm that is
 * *supposed* to navigate, and they are let through **here**, by id, rather than
 * by relaxing anything. `browserWillNavigate` answers false for every web
 * contents that is not a live browser view - the window, the spike page, an
 * artifact frame - so the app's own renderers keep exactly the lock they had
 * before this pane existed, and a view that has been destroyed loses the
 * exemption with it.
 *
 * The window-open side answers `deny` for everything that is not a browser
 * view, and that is still the whole of the app's own posture - the window, the
 * spike page and an artifact frame cannot open anything, ever. A browser view
 * gets its answer from `browserWindowOpen`, which turns `target="_blank"` into
 * a Helm tab and `window.open` with features into a real popup window on the
 * same partition, under the same reach rule, in the same registry.
 *
 * The popup is the one deliberate widening in this file and it was measured
 * into existence: denied, `window.open` returns `null` and every OAuth library
 * reports a blocked popup, and the tab Helm opened instead has no
 * `window.opener` for the sign-in to hand its code back through. See
 * `browserWindowOpen` for the terms it is held to.
 *
 * Both hooks are read at *navigation* time rather than at creation time, which
 * is what lets the registry be filled in the view's own constructor path.
 */
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler((details) => browserWindowOpen(contents.id, details))
  contents.on('will-navigate', (event, url) => {
    if (!browserWillNavigate(contents.id, url)) event.preventDefault()
  })
  // A plugin frame stays on its own origin, and only Helm's pages that frame
  // plugins put one there (`plugins/guards.ts`). Read at navigation time, so
  // the plugin host can be made after this is armed.
  guardPluginFrames(contents, (id) => pluginFrameHosts(id))
})

/** Set once the plugin host exists; until then no web contents frames plugins. */
let pluginFrameHosts: (contentsId: number) => boolean = () => false

function createWindow(
  page: 'index' | 'spike',
  bounds?: AppSettings['windowBounds'],
  theme?: AppliedTheme
): BrowserWindow {
  const edge = theme === undefined ? null : windowBorderFor(theme)
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 820,
    // Position is restored only when both coordinates were saved; handing
    // Electron one of the two would place the window at the other's default.
    ...(bounds?.x !== undefined && bounds.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 900,
    minHeight: 560,
    // Painted before the renderer's first frame, so a cold start does not flash
    // white on a dark desktop. The theme's own canvas, so the frame Chromium
    // shows before any CSS has loaded is the colour the first paint lands on.
    // The spike pages predate themes and keep what they always had.
    backgroundColor: theme?.tokens.bg ?? (nativeTheme.shouldUseDarkColors ? '#12131f' : '#eceef4'),
    show: true,
    autoHideMenuBar: true,
    // The app window replaces the OS-accent title bar with its own brand
    // strip plus the Window Controls Overlay (see chrome.ts). The spike pages
    // keep the native frame: their drivers predate the strip and measure a
    // page, not the chrome.
    ...(page === 'index' && process.platform === 'win32' && theme !== undefined
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlayFor(theme),
          // The window's edge in the theme's hairline, not the OS accent.
          ...(edge === null ? {} : { accentColor: edge })
        }
      : {}),
    // A packaged Electron window does NOT inherit the exe's icon: given no
    // `icon` it uses Electron's own, which is what the taskbar showed on
    // 2026-08-10 while the exe itself was correctly stamped.
    //
    // `.ico` on Windows, not the PNG. The taskbar and title bar want 16 and 32
    // pixel variants, and a lone 256px PNG leaves Windows to invent them - it
    // kept showing Electron's default instead. The .ico carries every size.
    // Packaged, the file arrives through `extraResources`; unpackaged it is
    // read out of `build/` directly.
    icon: join(
      app.isPackaged ? process.resourcesPath : join(__dirname, '../../build'),
      process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    ),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches `contextBridge` and `ipcRenderer`, both of
      // which are available to a sandboxed preload, so the renderer runs in the
      // OS sandbox like any other Chromium content process.
      sandbox: true,
      webviewTag: false
    }
  })

  if (page === 'index') void requestSmallCorners(win)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(page === 'index' ? devUrl : `${devUrl}/spike.html`)
  } else {
    win.loadFile(join(__dirname, `../renderer/${page === 'index' ? 'index' : 'spike'}.html`))
  }
  return win
}

function writeReport(name: string, report: unknown): string {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, name)
  writeFileSync(file, JSON.stringify(report, null, 2))
  return file
}

// ---------------------------------------------------------------------------
// App mode
// ---------------------------------------------------------------------------

export interface AppOptions {
  /** Taps for the check drivers; the app itself passes none. */
  observer?: SessionObserver | undefined
  /** Answers the "this session is still running" question. Defaults to a dialog. */
  confirm?: Confirm | undefined
  /** Called once the renderer has mounted and the first scan is under way. */
  onReady?: ((ctx: CheckContext) => void) | undefined
  /**
   * Index a different `.claude` tree, so a check can run against a fixture
   * rather than the user's own.
   */
  claudeHome?: string | undefined
  /**
   * Stand-ins for the native pickers, so `--packaging-firstrun` can drive "add a
   * folder" and "locate claude" through the real handlers. Same shape and same
   * reasoning as `confirm`.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
}

/**
 * The one line `pnpm dev:live` owes anybody who runs it.
 *
 * Printed before the database is opened, because by the time the window is up
 * the damage this warns about is already possible: this process is about to
 * write to the `helm.db`, the `overlays/` and the Chromium profile of whichever
 * Helm the user has open. The status bar names the mode too, but a chip on a
 * window somebody is not looking at is not a warning.
 */
function announceLiveMode(): void {
  if (appMode !== 'dev-live') return
  const rule = '─'.repeat(72)
  console.warn(
    [
      '',
      rule,
      '  DEV, LIVE - this run shares the installed app\'s data directory.',
      `    ${dataDir}`,
      '  Its database, overlay shims and Chromium profile are the ones the',
      '  installed Helm uses. Running both at once will fight over the',
      '  Chromium profile, and anything written here is written there.',
      '',
      '  `pnpm dev` is the isolated one. This is `pnpm dev:live`.',
      rule,
      ''
    ].join('\n')
  )
}

function startApp(options: AppOptions = {}): void {
  announceLiveMode()
  const services: Services = createServices()
  // Before anything can spawn: a `claude` the user picked by hand has to win
  // over discovery in every caller, and the session host does not read
  // settings.
  setClaudeOverride(services.settings.claudePath)
  // Before the window exists: an install from before the setup pane has roots
  // and no completion stamp, and stamping it after the first paint would flash
  // a setup pane over a working launcher.
  if (adoptExistingProfile(services)) {
    console.log('existing profile adopted; first run marked complete')
  }
  if (services.lost.sessions.length > 0) {
    console.warn(
      `${String(services.lost.sessions.length)} session(s) did not outlive the last run; marked lost`
    )
  }
  if (services.staleShims > 0) {
    console.log(`removed ${String(services.staleShims)} overlay shim(s) left by the last run`)
  }
  if (services.templates.seeded) {
    console.log(`seeded ${String(services.templates.created.length)} template file(s) into ${templatesDir}`)
  }
  if (services.templates.problem !== null) console.warn(services.templates.problem)

  // Before the window, because the window's first colour is the theme's. The
  // preference has to reach `nativeTheme` first for the same reason: `system`
  // is answered by asking it.
  nativeTheme.themeSource = services.settings.theme
  const themes = createThemeService(themesDir)
  const windowTheme = (): AppliedTheme => themes.state(services.settings).applied

  /*
   * Plugins, read before the window exists: what a plugin *is* comes from its
   * folder (cheap - a manifest and a stat per file it names), and its scheme
   * has to answer by the time the window asks for its first panel. A service
   * marked `start: "enable"` starts here, in the background.
   */
  let win: BrowserWindow | null = null
  // `pnpm dev` starts from a fresh copy of the database every launch, so a
  // plugin being worked on is registered from HELM_PLUGINS instead of being
  // added again in Settings each time. Dev builds only: an installed Helm
  // registers a folder when the user adds one, and at no other time.
  if (appMode === 'dev') {
    for (const folder of (process.env['HELM_PLUGINS'] ?? '').split(delimiter)) {
      if (folder.trim() !== '' && isAbsolute(folder.trim())) addPluginFolder(services.store, folder.trim())
    }
  }
  const plugins = createPluginHost({
    store: services.store,
    window: () => win,
    theme: () => pluginThemeOf(windowTheme(), services.settings),
    bridge: pluginBridge,
    stylesheet: pluginStylesheet
  })
  plugins.start()
  registerPluginProtocol((id) => plugins.served(id), plugins.runtime)
  installPluginPermissions()
  pluginFrameHosts = (id) => plugins.framesPlugins(id)

  win = createWindow('index', services.settings.windowBounds ?? null, windowTheme())

  /**
   * Helm's own MCP endpoint, reached through a getter.
   *
   * It cannot be created here: it drives the browser host, which is created
   * further down because it needs the window. And the session host cannot be
   * created after it, because the browser host's `writeSettings` and this
   * file's shutdown order both already depend on the order these three are in.
   * So the session host is handed a *function*, which is the shape it already
   * uses for the window for the same reason.
   */
  let browserMcp: BrowserMcpHost | null = null

  /**
   * And what the session-awareness tools read, reached the same way.
   *
   * Null until the activity poller and the resource service exist, which is
   * after the endpoint for the reason above. A tool called in that window says
   * "still starting up" rather than throwing - see `session-tools.ts`.
   */
  let sessionTools: SessionToolsWorld | null = null

  const sessions = createSessionHost({
    services,
    window: () => win,
    browserMcp: () => browserMcp,
    observer: options.observer,
    confirm: options.confirm
  })

  // The setting is read through a function rather than passed by value: the
  // default shell has to be able to change while the app is running, and a
  // captured value would make it a property of when Helm started.
  const pterm = createPtermHost({
    window: () => win,
    defaultShell: () => services.settings.terminalShell
  })

  /*
   * The archive, and the session index that feeds it. `createHistoryIndex`
   * wires the one to the other; `main/history.ts` says how.
   */
  const historyIndex = createHistoryIndex({
    store: services.store,
    home: options.claudeHome,
    maxBytes: () => services.settings.transcriptArchiveMaxBytes,
    onHistoryChange: (summary) => emit(win, 'history:changed', summary),
    onArchiveChange: (stats) => emit(win, 'archive:changed', stats)
  })
  const { history, archive } = historyIndex

  const usage = createUsageService({
    store: services.store,
    ...(options.claudeHome !== undefined ? { home: options.claudeHome } : {}),
    onChange: (snapshot) => emit(win, 'usage:changed', snapshot)
  })

  const config = createConfigService({
    services,
    ...(options.claudeHome !== undefined ? { userHome: options.claudeHome } : {}),
    onExternalChange: (change) => emit(win, 'config:externalChange', change)
  })

  const content = createContentService({ services })
  attachArtifactConsole(win, (entry) => emit(win, 'content:artifactConsole', entry))

  /**
   * The Files view. Its roots are the content viewer's scopes - every project,
   * harness and profile folder - and the folder each hosted session is working
   * in, because "the files of the session in front of me" is the question it
   * answers and a profile's session can run somewhere no scan reached.
   */
  const files = createFilesService({
    roots: () => [
      ...content.scopes().map((scope) => scope.path),
      ...sessions.list().map((session) => session.cwd)
    ],
    onChanged: (root, paths) => emit(win, 'files:changed', { root, paths }),
    protocolHandler: (url) => app.getApplicationNameForProtocol(url),
    openExternal: (url) => shell.openExternal(url)
  })

  /**
   * The browser pane's views.
   *
   * Settings are read through a function and written through one, for the two
   * different reasons both shapes exist elsewhere in this file. The reach
   * posture can change while a view is open, so a captured value would make it
   * a property of when the tab was made. And the addresses a view has been to
   * are written by *main*, because main is the side that knows a navigation
   * succeeded - a redirect, a retry that finally connected and a `window.open`
   * are all invisible to a window that only saw what it asked for.
   */
  const browsers: BrowserHost = createBrowserHost({
    window: () => win,
    settings: () => services.settings,
    writeSettings: (patch) => {
      const next = updateSettings(services, patch)
      emit(win, 'settings:changed', next)
    },
    onChanged: (state) => emit(win, 'browser:changed', state),
    onOpened: (state) => emit(win, 'browser:opened', state),
    onClosed: (id) => emit(win, 'browser:closed', { id }),
    onLogged: (id, entry) => emit(win, 'browser:logged', { id, entry })
  })

  /**
   * And the endpoint that lets a session drive those views.
   *
   * Started here rather than lazily at the first launch, because "there is no
   * listener when `browserMcp` is off" has to be true of the *app* rather than
   * of a code path nobody has taken yet - a port that appears the first time
   * somebody starts a session is a port whose absence proves nothing.
   *
   * `start()` answers rather than throws: a machine where the loopback bind
   * fails is a machine where Helm still works, with no browser tools and a line
   * on the console saying so.
   */
  browserMcp = createBrowserMcp({
    browsers,
    settings: () => services.settings,
    dir: mcpConfigDir,
    sessions: () => sessionTools
  })
  void browserMcp.start().then(({ started, problem }) => {
    if (started) {
      const bound = browserMcp?.address()
      console.log(
        `${(browserMcp?.servedNames() ?? []).join(' and ')} on http://${bound?.address ?? '?'}:${String(
          bound?.port ?? 0
        )} (loopback, token-gated)`
      )
    } else if (services.settings.browserMcp || services.settings.sessionMcp) {
      console.warn(`Helm's tools are not available: ${problem ?? 'unknown'}`)
    }
  })

  /*
   * What each hosted session is doing, out of Claude Code's own registry.
   *
   * After the session host because it reads from it, and pointed at the same
   * `.claude` tree everything else that reads one is - so a check that hands
   * over a fixture home gets a registry from that home rather than the user's.
   */
  const activity = createActivityService({
    sessions,
    window: () => win,
    ...(options.claudeHome !== undefined ? { claudeHome: options.claudeHome } : {})
  })
  sessions.onChanged(() => activity.refresh())

  const restore = createRestoreService({
    lost: services.lost,
    store: services.store,
    sessions,
    refreshHistory: () => {
      history.refresh()
    },
    // Read here rather than from the activity poller's last pass, which only
    // starts once the window is up and would answer "nothing is running" to
    // a window that asked first.
    liveConversations: () =>
      new Set(
        readSessionRegistry(sessionRegistryDir(options.claudeHome ?? claudeHome())).flatMap((entry) =>
          entry.sessionId === null ? [] : [entry.sessionId]
        )
      )
  })

  /*
   * What each hosted session is *holding* - its process tree and its ports.
   *
   * A separate service from the one above because it is a separate budget. The
   * registry poll costs 0.15ms and runs always; a process enumeration costs
   * 400ms of a child process and runs only while somebody is looking at it.
   * Wiring one off the other's timer is the change `resources.ts` exists to
   * argue against.
   */
  const resources = createResourcesService({ sessions, window: () => win })
  // A session ending is a tree that has gone with it, so the pass is re-run at
  // once rather than leaving a dead session's children on screen for an
  // interval. A no-op when nothing is watching.
  sessions.onChanged(() => void resources.refresh())

  // What a session may be told about the other sessions: `sessionToolsWorld`
  // says why it is these three and nothing else.
  sessionTools = sessionToolsWorld({ store: services.store, sessions, activity, resources })

  // Built on the config service rather than beside it: the import picker's
  // sources are the console's own scopes, and what a skill *is* is the
  // console's own answer.
  const templates = createTemplateService(services, config)

  registerIpc({
    services,
    sessions,
    restore,
    activity,
    resources,
    pterm,
    browsers,
    browserMcp,
    history,
    archive,
    usage,
    config,
    content,
    files,
    templates,
    themes,
    plugins,
    window: () => win,
    ...(options.claudeHome !== undefined ? { claudeHome: options.claudeHome } : {}),
    ...(options.chooseDirectory !== undefined ? { chooseDirectory: options.chooseDirectory } : {}),
    ...(options.chooseFile !== undefined ? { chooseFile: options.chooseFile } : {}),
    rendererReady: () => {
      emit(win, 'settings:changed', services.settings)
      pushTheme({ services, themes, plugins, window: () => win })
      // The first scan is kicked off by the main process rather than waited on
      // by the renderer: the launcher paints from the cache immediately and
      // this replaces it when it lands.
      void runScan(services, { includeGit: true })
        .then((result) => {
          emit(win, 'discovery:updated', result)
          // The first scan is also what adopts the default roots on a fresh
          // profile, so settings can be different now than they were a moment
          // ago when the renderer was handed them.
          emit(win, 'settings:changed', services.settings)
          emit(win, 'scan:status', { running: false })
        })
        .catch((err: unknown) => {
          emit(win, 'scan:status', {
            running: false,
            error: err instanceof Error ? err.message : String(err)
          })
        })
      emit(win, 'scan:status', { running: true })

      // Off the renderer's critical path: the first pass reads 875 KB and
      // writes 3,470 rows, which is ~30ms the launcher should not spend
      // before it paints. The window gets `history:changed` when it lands.
      setImmediate(() => {
        // The first pass, which the archive rides, and then the watches.
        try {
          emit(win, 'history:changed', historyIndex.start())
        } catch (err) {
          console.warn(`history index could not be built: ${String(err)}`)
        }

        // Cheap by comparison - one 134 KB file, parsed - but it is on the
        // same "after the first paint" footing: the status bar has everything
        // else it needs before this lands, and gets `usage:changed` when it
        // does.
        try {
          emit(win, 'usage:changed', usage.refresh())
        } catch (err) {
          console.warn(`usage figures could not be read: ${String(err)}`)
        }
        usage.start()

        // And the one request Helm's own process makes. Here rather than at
        // startup for the reason everything else in this block is: it is worth
        // nothing before the window has painted, and it must not be in front of
        // anything that is.
        //
        // Failure is silent on purpose, unlike the two above. Offline is the
        // ordinary case for this one, the answer is a line in the status bar
        // that simply does not appear, and there is nothing a user would do
        // with a warning that Helm could not reach GitHub while they work.
        void maybeCheckForUpdate(services, win)
      })

      if (win) {
        options.onReady?.({ win, services, sessions, browsers, browserMcp })
      }
    }
  })

  /**
   * Set once the database has been let go of. Every write below checks it,
   * because the order of Electron's shutdown events is not the order the app
   * was written in: `before-quit` fires before the window's own `close`, so a
   * teardown that closed the store first would leave the close handler writing
   * to a closed connection - which throws in the middle of quitting, where an
   * uncaught error stalls the whole shutdown rather than being reported.
   */
  let storeClosed = false

  const persistBounds = (): void => {
    if (storeClosed || !win || win.isDestroyed() || win.isMinimized()) return
    const { width, height, x, y } = win.getNormalBounds()
    services.settings = { ...services.settings, windowBounds: { width, height, x, y } }
    writeSetting(services.store, 'windowBounds', services.settings.windowBounds)
  }

  // `resize`/`move` rather than `resized`/`moved`: the past-tense pair only
  // fires for a user-driven drag, so a window placed by a tiling manager, a
  // display change, or anything else that moves it programmatically would never
  // be remembered. They do fire per frame, hence the debounce - one upsert per
  // gesture instead of sixty.
  let boundsTimer: NodeJS.Timeout | null = null
  const scheduleBoundsPersist = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      persistBounds()
    }, 400)
  }
  win.on('resize', scheduleBoundsPersist)
  win.on('move', scheduleBoundsPersist)

  /**
   * SPEC 4.1 wants git state "at a glance", which only holds if it is current.
   * Someone commits in a terminal and comes back to Helm - regaining focus is
   * exactly that moment, and re-reading git is far cheaper than rescanning
   * every `.claude` tree.
   *
   * Guarded rather than debounced: alt-tabbing quickly should not stack up
   * `git status` runs across every repo, and the answer from the one already in
   * flight is current enough.
   */
  let gitRefreshInFlight = false
  win.on('focus', () => {
    if (gitRefreshInFlight || services.lastScan === null) return
    gitRefreshInFlight = true
    void refreshGit(services)
      .then((states) => emit(win, 'git:updated', states))
      .catch(() => undefined)
      .finally(() => {
        gitRefreshInFlight = false
      })
  })

  /**
   * Closing the window ends every hosted session, so it asks first - once, for
   * all of them, rather than a dialog per tab.
   *
   * `close` is also the last moment the window still exists, so this is where
   * the bounds are flushed: by `closed` the geometry is gone and whatever the
   * debounce was still holding would be lost.
   */
  let closeConfirmed = false
  win.on('close', (event) => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()

    if (closeConfirmed || sessions.runningCount() === 0) return
    event.preventDefault()
    void sessions.confirmCloseAll().then((confirmed) => {
      if (!confirmed) return
      closeConfirmed = true
      win?.close()
    })
  })

  win.on('closed', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    win = null
    // The background host is a window too, and a hidden one would keep the
    // app alive after its only visible window closed.
    plugins.shutdown()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow('index', services.settings.windowBounds ?? null, windowTheme())
    }
  })

  app.on('before-quit', () => {
    // Flush whatever the debounce is still holding.
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()
    // Before the store is let go of: a debounced index pass, or a config watch
    // firing after `will-quit`, would write to a closed connection.
    historyIndex.stop()
    usage.stop()
    config.stop()
    files.stop()
    // Plugins' services are processes like a session's, ended the same way:
    // synchronously, the whole tree, while main is still guaranteed a turn.
    plugins.shutdown()
    /*
     * The endpoint goes **before** the sessions, and the order is the point.
     *
     * A session being torn down can still be mid-tool-call, and a tool that
     * ran after its session's process was gone would be an agent driving a
     * browser on behalf of nothing. Stopping first revokes every token, so
     * anything still in flight is answered with a 401 by a listener that is on
     * its way out - and the ephemeral config files go with it, which is the
     * only sweep that catches a session whose exit never got a turn.
     *
     * Not awaited: `before-quit` is synchronous, and the close is a formality
     * once the tokens are gone.
     */
    void browserMcp?.stop()
    // The poller stops with them. Nothing is left reading a registry on behalf
    // of sessions that are about to be gone.
    activity.stop()
    resources.stop()
    // Synchronously, because this is the last point the main process is
    // guaranteed a turn. Anything deferred here is a process left behind.
    sessions.shutdown()
    /*
     * The browser views die here too, and it is the same argument.
     *
     * A `WebContentsView` is a render process - the same kind of thing a pty
     * is, from this file's point of view - and it belongs to the main process
     * rather than to the window. Destroying it in the window's `closed`
     * handler would be too late in one direction (a quit that never closed the
     * window) and too early in the other (`before-quit` runs first, and a view
     * torn down after the store closed would be a `did-navigate` writing a
     * remembered URL into a shut database).
     *
     * A tab closed by hand goes through `browser:close`; this is the sweep for
     * whatever is still open when the app ends. Both end at the same
     * `destroy()`.
     */
    browsers.shutdown()
  })

  app.on('will-quit', () => {
    // Not in `before-quit`: the windows have not closed yet at that point, and
    // closing a window persists its bounds. Here every window is gone, so this
    // is the first moment nothing can still want the database. Letting go of it
    // checkpoints the WAL rather than leaving it for the next launch.
    themes.stop()
    if (storeClosed) return
    storeClosed = true
    services.store.close()
  })
}

// ---------------------------------------------------------------------------
// Spike modes - Spike B/C harnesses, unchanged in behaviour
// ---------------------------------------------------------------------------

function startSpike(): void {
  const win = createWindow('spike')

  ipcMain.once('renderer:ready', async () => {
    if (mode === 'selftest') {
      const report = await runSelftest(win, dataDir)
      const file = writeReport('spike-report.json', {
        startedAt: new Date().toISOString(),
        mode: appMode,
        dataDir,
        versions: process.versions,
        ...report
      })
      console.log(`selftest report: ${file}`)
      killPty()
      setTimeout(() => app.exit(report.pass ? 0 : 1), 200)
      return
    }

    if (mode === 'fidelity' || mode === 'claude-check') {
      const onlyArg = process.argv.find((a) => a.startsWith('--only='))
      const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
      const checks =
        mode === 'fidelity'
          ? await runFidelity(win, dataDir, only)
          : await runClaudeChecks(win, dataDir, only)
      const pass = checks.every((c) => c.ok)
      const file = writeReport(mode === 'fidelity' ? 'fidelity-report.json' : 'claude-report.json', {
        startedAt: new Date().toISOString(),
        mode: appMode,
        dataDir,
        versions: process.versions,
        pass,
        checks
      })
      console.log(`${mode} report: ${file}`)
      for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
      killPty()
      setTimeout(() => app.exit(pass ? 0 : 1), 200)
      return
    }

    // Interactive: a real terminal pane, sized to the window. This is the
    // surface the 30-minute soak test is driven in.
    const cwdArg = process.argv.find((a) => a.startsWith('--cwd='))
    const cwd = cwdArg ? cwdArg.slice('--cwd='.length) : homedir()
    win.webContents.send('term:create', {
      cols: 100,
      rows: 30,
      fit: true,
      windowsBuild: windowsBuildNumber()
    })
    // The pane fits itself to the window before reporting back, so the pty has
    // to be opened at the grid the renderer actually ended up with - opening it
    // at the requested size would start the session one SIGWINCH behind.
    ipcMain.once('term:created', async (_e, info: { cols?: number; rows?: number }) => {
      const useClaude = mode === 'claude'
      const claudeExe = findClaudeExecutable() ?? join(homedir(), '.local', 'bin', 'claude.exe')
      spawnPty(win, {
        file: useClaude ? claudeExe : 'pwsh.exe',
        args: useClaude ? [] : ['-NoLogo'],
        cols: info?.cols ?? 100,
        rows: info?.rows ?? 30,
        cwd
      })

      // Unattended smoke check for the interactive path itself.
      const shotArg = process.argv.find((a) => a.startsWith('--shot-after='))
      if (shotArg) {
        const delay = Number(shotArg.slice('--shot-after='.length))
        setTimeout(async () => {
          const shot = await screenshot(win, join(dataDir, 'screenshots'), 'interactive.png')
          console.log(`interactive grid ${info?.cols}x${info?.rows}, screenshot: ${shot.file}`)
          killPty()
          app.exit(0)
        }, delay)
      }
    })
  })

  // The spike harness drives the terminal directly; the app's IPC surface is
  // not registered in these modes, so the pty channels are wired here.
  ipcMain.on('pty:input', (_e, data: string) => activePty()?.pty.write(data))
  ipcMain.on('pty:resize', (_e, size: { cols: number; rows: number }) => {
    try {
      activePty()?.pty.resize(size.cols, size.rows)
    } catch {
      // pty may have exited
    }
  })
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_e, text: string) => clipboard.writeText(text))
}

/**
 * Gives the dev app id a Start Menu shortcut of Helm's own, so the dev window's
 * taskbar button carries the ship's wheel rather than Electron's atom.
 *
 * A taskbar button's icon comes from the shortcut that declares its app id, not
 * from the window. Electron writes that shortcut itself the first time a toast
 * fires - pointing at `node_modules/electron/dist/electron.exe`, whose icon is
 * the atom - and then skips the write because one already exists. Writing it
 * first is therefore the whole fix: same id, same target, Helm's `.ico`.
 *
 * Dev only, Windows only, and never fatal. `Electron.lnk` is removed only when
 * it points at *this* checkout's electron.exe, because that one is an artefact
 * of running this app and a second shortcut declaring the same id is what put
 * the atom on the packaged app's button on 2026-08-10.
 */
function claimDevShortcut(): void {
  if (process.platform !== 'win32' || app.isPackaged) return
  try {
    const programs = join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs')
    const icon = join(__dirname, '../../build', 'icon.ico')
    if (!existsSync(icon)) return

    const stale = join(programs, 'Electron.lnk')
    if (existsSync(stale)) {
      const target = shell.readShortcutLink(stale).target.toLowerCase()
      if (target === process.execPath.toLowerCase()) rmSync(stale, { force: true })
    }

    // `create`, not `update`: `update` only edits a shortcut that is already
    // there and fails on the first run, which is the only run that matters.
    shell.writeShortcutLink(join(programs, 'Helm (dev).lnk'), 'create', {
      target: process.execPath,
      args: `"${app.getAppPath()}"`,
      appUserModelId: 'dev.coletaylor.helm.dev',
      description: 'Helm, run from source',
      icon,
      iconIndex: 0
    })
  } catch {
    // A shortcut is cosmetic. Nothing here is worth failing a start over.
  }
}

app.whenReady().then(() => {
  // The default application menu binds Ctrl-C to the Edit>Copy role, which
  // swallows the interrupt before xterm ever sees the keydown. A terminal host
  // cannot ship that menu.
  Menu.setApplicationMenu(null)

  // Windows resolves a toast back to an installed application through this id.
  // Without it the exit notifications either carry electron.app.Electron's
  // identity in dev or do not appear at all.
  //
  // Dev gets its OWN id, and that is load-bearing rather than tidy. Windows
  // requires a Start Menu shortcut declaring an id before it will show a toast
  // for it, so Electron creates one pointing at whatever exe is running - in
  // dev that is `node_modules/electron/dist/electron.exe`, carrying Electron's
  // atom. Two shortcuts then declare the same id, Windows resolves the id to
  // one of them, and it picked the dev one: the packaged app showed the atom on
  // its taskbar button while its own title bar showed the right icon, because a
  // title bar uses the window icon and a taskbar button uses the id.
  //
  // Measured 2026-08-10. Neither rebuilding, reinstalling, running from an
  // uncached path, nor purging the icon cache touched it - the stale
  // `Electron.lnk` had to go. Keeping the ids apart is what stops it returning.
  app.setAppUserModelId(app.isPackaged ? 'dev.coletaylor.helm' : 'dev.coletaylor.helm.dev')
  claimDevShortcut()

  // The artifact scheme's handler. Registered for every mode that opens a
  // window, because the spike pages share this process and a scheme with no
  // handler fails a load rather than falling through to something worse.
  registerContentProtocol()

  if (isSpikeMode) {
    startSpike()
    return
  }

  /**
   * First run, in two starts.
   *
   * `--packaging-check` runs against this machine: the grep audit and what the real
   * `claude` here actually is.
   *
   * `--packaging-firstrun` is the other half, and it is a separate process because
   * "a machine with a fresh `~/.claude` and no harness at all" is not a state
   * this one can enter. The driver starts it with `PORTABLE_EXECUTABLE_DIR`
   * pointed at a temporary directory - the app's own portable-mode mechanism,
   * used as the isolation - so it opens an empty database beside that directory
   * and touches neither `%APPDATA%\Helm` nor the user's `~/.claude`, which it is
   * pointed away from with `--claude-home=`.
   */
  if (mode === 'packaging-check' || mode === 'packaging-firstrun') {
    const collector = createCollector()
    const arg = (name: string): string | undefined => {
      const found = process.argv.find((a) => a.startsWith(`--${name}=`))
      return found?.slice(name.length + 3)
    }
    const fixtures = arg('fixtures')
    const claudeHome = arg('claude-home')
    const onlyArg = arg('only')

    startApp({
      observer: collector,
      confirm: collector.confirm,
      ...(claudeHome !== undefined ? { claudeHome } : {}),
      // Answered by the driver, and rewritten by it before each step that
      // opens one. A native dialog has no automation surface.
      ...(mode === 'packaging-firstrun'
        ? {
            chooseDirectory: (title: string) => pickerAnswer('directory', title),
            chooseFile: (title: string) => pickerAnswer('file', title)
          }
        : {}),
      onReady: (ctx) => {
        collector.answerWith(true)
        void runPackagingChecks(ctx, collector, join(dataDir, 'screenshots'), dataDir, {
          phase: mode === 'packaging-check' ? 'machine' : 'firstrun',
          ...(fixtures !== undefined ? { fixtures } : {}),
          ...(claudeHome !== undefined ? { claudeHome } : {}),
          ...(onlyArg !== undefined ? { only: onlyArg.split(',') } : {})
        })
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport(
              mode === 'packaging-check' ? 'packaging-report.json' : 'packaging-firstrun-report.json',
              {
                startedAt: new Date().toISOString(),
                mode: appMode,
                dataDir,
                versions: process.versions,
                pass,
                checks
              }
            )
            console.log(`${mode} report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`${mode} crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  // The ordinary app.
  startApp()
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})

/**
 * The backstop. `before-quit` does the orderly teardown - rows first, then the
 * processes - but it does not run for every way a process can end, and a
 * hosted `claude` outliving the app it was launched from is the one failure
 * this milestone is not allowed to have.
 */
app.on('will-quit', () => killAllSessionsSync())


