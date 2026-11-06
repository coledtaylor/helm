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
  cleanStaleMcpConfigs,
  pluginThemeOf,
  quitEndsSessions,
  writeSetting,
  type AppliedTheme,
  type AppSettings,
  type Profile
} from '@helm/core'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { emit, emitToContents, pushTheme, registerIpc } from './ipc'
import { createClipboardText } from './clipboard'
import { appMode, dataDir, initDataDir, mcpConfigDir, themesDir } from './paths'
import { createThemeService } from './themes'
import { activePty, killPty, spawnPty, windowsBuildNumber } from './pty'
import { adoptExistingProfile, createServices, updateSettings, type Services } from './services'
import { createFilesService, filesRoots } from './files'
import { attachArtifactConsole, CONTENT_SCHEME, registerContentProtocol, serveArtifactsFrom } from './content'
import { PLUGIN_SCHEMES } from '../shared/ipc'
import { createPluginHost } from './plugins/host'
import { registerHostPluginProtocol } from './plugins/protocol'
import { createBackgroundHost } from './plugins/background'
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
import { installIpcRecorder } from './ipc-recorder'
import { maybeCheckForUpdate } from './update'
import { quitConfirm, sessionConfirm } from './host/confirm'
import type { Confirm, SessionHost } from './host/session-host'
import {
  askLocalHostRestart,
  createDesktopHost,
  createDesktopRemoteAdder,
  createDesktopRemoteHosts,
  createDesktopRemoteInstaller,
  createLocalPageLinks,
  readDesktopSshHosts,
  readDesktopWslDistros,
  type DesktopHost
} from './host/desktop'
import { routePageLinks } from './host/page-link'
import type { RemoteHostLinks } from './host/remote'
import { createPortForwards } from './host/forwards'
import { createCollector, type CheckContext } from './checkkit'
import { applicationMenuTemplate, windowChromeFor } from './chrome'
import { createQuitGate, quitEnds } from './quit'
import { requestSmallCorners } from './corners'
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
  // A plugin's pages: an origin per plugin (`helm-plugin://<id>` at version 1,
  // `floti-plugin://<id>` at version 2), secure so its storage and module
  // scripts work, and no fetch - its network goes through Helm. See
  // `main/plugins/protocol.ts`.
  ...PLUGIN_SCHEMES.map((scheme) => ({
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false }
  }))
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
 * gets its answer from `browserWindowOpen`, which turns `target="_blank"` and a
 * plain `window.open` into a page in the Browser tab and a sized `window.open`
 * into a real popup window - both keeping `window.opener`, on the same
 * partition, under the same reach rule, in the same registry.
 *
 * Allowing those opens is the one deliberate widening in this file and it was
 * measured into existence: denied, `window.open` returns `null` and every
 * OAuth library reports a blocked popup, and a page Helm loaded fresh instead
 * has no `window.opener` for the sign-in to hand its code back through. See
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

/**
 * What the app menu's Quit Helm does (macOS; chrome.ts). A plain quit until
 * the app has sessions to ask about; `startApp` points it at the quit gate.
 */
let quitFromMenu: () => void = () => app.quit()

function createWindow(
  page: 'index' | 'spike',
  bounds?: AppSettings['windowBounds'],
  theme?: AppliedTheme
): BrowserWindow {
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
    // The app window replaces the native title bar with its own brand strip,
    // and the OS draws its window controls into it (see chrome.ts). The spike
    // pages keep the native frame: their drivers predate the strip and measure
    // a page, not the chrome.
    ...(page === 'index' && theme !== undefined ? windowChromeFor(process.platform, theme) : {}),
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
  /**
   * The answer to the browser calls the host relays, reached through a getter:
   * it drives the browser host, which is created further down because it needs
   * the window.
   */
  let browserMcp: BrowserMcpHost | null = null
  /*
   * The host keeps the plugin registry - the folders, their switches,
   * settings, services and page files - and Helm keeps what concerns its own
   * pages: the runtime, the theme, the frames, and the hidden window
   * background pages run in, which the host's list opens.
   */
  /** What hears that the background host's renderer died; the host's plugins, once they exist. */
  let pluginBackgroundGone = (_reason: string): void => undefined
  const pluginBackground = createBackgroundHost({ onGone: (reason) => pluginBackgroundGone(reason) })

  const plugins = createPluginHost({
    window: () => win,
    theme: () => pluginThemeOf(windowTheme(), services.settings),
    bridge: pluginBridge,
    stylesheet: pluginStylesheet,
    background: pluginBackground
  })
  // Asked only once a page loads, which is after the desktop host below exists.
  // Each origin from its own host's files: This PC's from the local host, a
  // remote host's (`<scheme>://<id>.<label>/`) from that host only.
  registerHostPluginProtocol((label) => {
    const hosted = label === null ? desktopHost.plugins : desktopHost.remotePlugins.byLabel(label)
    if (hosted === null) return null
    return {
      // The local host is the one Helm started, on this computer; a remote host's is not.
      onHostComputer: label === null,
      serves: (id) => hosted.serves(id),
      file: (id, path) => hosted.file(id, path)
    }
  }, plugins.runtime)
  installPluginPermissions()
  pluginFrameHosts = (id) => plugins.framesPlugins(id)

  win = createWindow('index', services.settings.windowBounds ?? null, windowTheme())

  /*
   * Sessions and terminals run in the local host, which Helm connects to now
   * and starts when none answers.
   */
  const checkConfirm = options.confirm
  const desktopHost: DesktopHost = createDesktopHost({
    services,
    window: () => win,
    // The window's own `session:confirm` is the host's; main's quit question has its own channel.
    confirm: options.confirm ?? sessionConfirm(() => win),
    // A check's collector answers yes or no, which never keeps the sessions.
    confirmQuit:
      checkConfirm !== undefined
        ? async (request) => ((await checkConfirm(request)) ? 'end' : 'cancel')
        : quitConfirm(() => win),
    browserTools: () => browserMcp,
    runPluginTool: (request, signal) => plugins.runTool(request, signal),
    pluginBackground
  })
  pluginBackgroundGone = (reason) => {
    desktopHost.plugins.backgroundGone(reason)
    desktopHost.remotePlugins.backgroundGone(reason)
  }
  // An artifact frame keeps the window's scheme, answered from the host's bytes.
  serveArtifactsFrom((url) => desktopHost.files.artifactBytes(url))
  void desktopHost.link.connection().catch((err: unknown) => {
    console.warn(err instanceof Error ? err.message : String(err))
  })
  // The window carries its terminals, says what it shows and hears the host's
  // notifications over its own connection (`renderer/src/app/host/sessions.ts`).

  /*
   * Each Helm page's own connection to the local host: the window, and the
   * hidden window plugins' background pages run in. No other page - a plugin
   * frame, an artifact frame, a page in the Browser tab - may open one.
   */
  const isHelmPage = (id: number): boolean =>
    (win !== null && !win.isDestroyed() && win.webContents.id === id) || pluginBackground.contents()?.id === id
  // One counter for every host's page connections, so a number names one.
  let nextPageConnection = 1
  const nextConnection = (): number => nextPageConnection++
  const localPageLinks = createLocalPageLinks(
    desktopHost.link,
    isHelmPage,
    (line) => console.log(line),
    nextConnection
  )

  /*
   * The hosts on other computers this device added, each over its own link,
   * beside this PC's. Each connects now and tries again by itself; a settings
   * write that adds or removes one starts or ends its link (`ipc.ts`).
   */
  /** The ports of remote sessions forwarded to this PC's loopback. */
  const forwards = createPortForwards({
    changed: (list) => emit(win, 'forwards:changed', list),
    log: (line) => console.log(line)
  })
  const remoteHosts: RemoteHostLinks = createDesktopRemoteHosts({
    isHelmPage,
    nextConnection,
    // The hidden plugin window hears it too: it runs each connected host's background pages.
    changed: (states) => {
      emit(win, 'remoteHosts:changed', states)
      emitToContents(pluginBackground.contents(), 'remoteHosts:changed', states)
    },
    plugins: desktopHost.remotePlugins,
    forwards,
    localLink: desktopHost.link,
    log: (line) => console.log(line)
  })
  remoteHosts.sync(services.settings.hosts)
  const pageLinks = routePageLinks(localPageLinks, remoteHosts)

  const sessions: SessionHost = desktopHost.sessions

  /*
   * Whether quitting ends what this device started, as the quit setting for
   * each host says (End for this PC's when unset, Keep them running for a
   * remote one), read at the quit so a change in Settings counts at once.
   */
  const settingEnds = (): boolean => quitEndsSessions(services.settings)
  const remoteEnds = (id: string): boolean => quitEndsSessions(services.settings, id)
  /** What the quit question names on the hosts on other computers whose setting ends them. */
  const remoteQuitParts = (): ReturnType<RemoteHostLinks['quitParts']> => remoteHosts.quitParts(remoteEnds)

  // One question about running sessions, shared by the menu's Quit Helm and
  // the window's close, asked before anything ends (quit.ts). With the setting
  // keeping them, nothing would end, so nothing is asked.
  const quitGate = createQuitGate({
    running: () =>
      (settingEnds() ? sessions.runningCount() : 0) +
      remoteQuitParts().reduce((sum, part) => sum + part.sessions.length, 0),
    confirm: () => {
      // The question is drawn in the window, so the window is brought on
      // screen first: Cmd+Q works with it minimized to the Dock, and a quit
      // held on a dialog nobody can see looks like a quit that did nothing.
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      return desktopHost.askQuit({ local: settingEnds(), remote: remoteQuitParts() })
    },
    quit: () => app.quit()
  })
  quitFromMenu = () => quitGate.requestQuit()

  /** The saved profiles, which live in the host; every reader of them in main reads this one. */
  const profileList = (): Profile[] => desktopHost.profiles.current()

  attachArtifactConsole(win, (entry) => emit(win, 'content:artifactConsole', entry))

  /**
   * The Files view's hand-off to an editor; the host reads the files. Its
   * roots are every project, harness and profile folder, and the folder each
   * hosted session is working in, because "the files of the session in front
   * of me" is the question it answers and a profile's session can run
   * somewhere no scan reached. The scan, the profiles and the sessions are all
   * the host's.
   */
  const files = createFilesService({
    roots: () =>
      filesRoots({
        scan: desktopHost.workspace.lastScan(),
        profiles: profileList(),
        sessions: sessions.list()
      }),
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
      // The window lays the host's half over Helm's own itself, which it hears
      // on its own channel.
      emit(win, 'ownSettings:changed', next)
    },
    onChanged: (state) => emit(win, 'browser:changed', state),
    onOpened: (opened) => emit(win, 'browser:opened', opened),
    onClosed: (id) => emit(win, 'browser:closed', { id }),
    onCommand: (command) => emit(win, 'browser:command', command),
    onLogged: (id, entry) => emit(win, 'browser:logged', { id, entry }),
    // With the tools off there is nobody to share a page with.
    sessionOpener: (session) => (services.settings.browserMcp ? sessions.browserOpener(session) : null),
    shareTargets: () => (services.settings.browserMcp ? sessions.browserSessions() : [])
  })

  /**
   * The answers to the browser calls the host relays for its sessions
   * (`host/browser-tools.ts`). It never listens: the host serves its
   * sessions' tools.
   */
  browserMcp = createBrowserMcp({ browsers, settings: () => services.settings })
  // The `--mcp-config` files an earlier version wrote for its own sessions,
  // where their owning pid is provably dead (`core/launch/mcp.ts`).
  cleanStaleMcpConfigs(mcpConfigDir)

  // What each session is doing, from the host, asked again after every spawn,
  // exit, close and rename.
  const activity = desktopHost.activity
  sessions.onChanged(() => activity.refresh())

  // What each session is holding, from the host's pass. A session ending is a
  // tree that has gone with it, so the pass is re-run at once. A no-op when
  // nothing is watching.
  const resources = desktopHost.resources
  sessions.onChanged(() => void resources.refresh())

  registerIpc({
    services,
    pageLinks,
    browsers,
    browserMcp,
    // The folders the window's picker chose go to the host's scan roots.
    workspace: desktopHost.workspace,
    // Opening an editor stays Helm's; the host reads the files.
    files,
    themes,
    plugins,
    hostPlugins: desktopHost.plugins,
    remotePlugins: desktopHost.remotePlugins,
    ownData: desktopHost.ownData,
    pluginBackground: () => pluginBackground.contents(),
    localHost: {
      sessionCount: async () => {
        const rows = await (await desktopHost.link.connection()).request('session:list', null)
        return rows.filter((row) => row.status === 'running').length
      },
      stop: () => desktopHost.link.stopHost(),
      restartAsk: () => askLocalHostRestart((line) => console.log(line)),
      restart: () => desktopHost.link.restartHost()
    },
    window: () => win,
    ...(options.chooseDirectory !== undefined ? { chooseDirectory: options.chooseDirectory } : {}),
    ...(options.chooseFile !== undefined ? { chooseFile: options.chooseFile } : {}),
    hostSettingsChanged: () => desktopHost.link.writeSettings(),
    remoteHosts,
    remoteInstall: createDesktopRemoteInstaller((line) => console.log(line)),
    remoteAdd: createDesktopRemoteAdder({
      hosts: () => services.settings.hosts,
      log: (line) => console.log(line)
    }),
    sshHosts: readDesktopSshHosts,
    wslDistros: () => readDesktopWslDistros(() => services.settings.hosts, remoteHosts),
    forwards,
    rendererReady: () => {
      pushTheme({ services, themes, plugins, window: () => win })
      // The window reads its settings and starts its first scan over its own
      // connection (`renderer/src/app/host/workspace.ts`).

      // The one request Helm's own process makes, after the first paint: it
      // is worth nothing before the window has painted, and it must not be in
      // front of anything that is.
      //
      // Failure is silent on purpose. Offline is the ordinary case, the answer
      // is a line in the status bar that simply does not appear, and there is
      // nothing a user would do with a warning that Helm could not reach
      // GitHub while they work.
      setImmediate(() => void maybeCheckForUpdate(services, win))

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
   * Closing the window ends every hosted session, so it asks first - once, for
   * all of them, rather than a dialog per tab - through the quit gate, so a
   * quit already agreed to from the menu is not asked about again.
   *
   * `close` is also the last moment the window still exists, so this is where
   * the bounds are flushed: by `closed` the geometry is gone and whatever the
   * debounce was still holding would be lost.
   */
  win.on('close', (event) => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()

    if (!quitGate.allowClose(() => win?.close())) event.preventDefault()
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

  /*
   * The host owns the sessions' lifetime and outlives Helm. A deliberate quit tells it what becomes of what this device started,
   * which takes a round trip: the first `before-quit` is held while every
   * page's connection closes, the host is told whether the sessions end
   * (`host:quit`: as the quit question was answered, or as the quit setting
   * for this PC's host says when nothing was asked; ended ones are recorded
   * as ended) and main's own connection closes, bounded by
   * `HOST_STOP_DEADLINE_MS`; the quit then goes on as it always has. The
   * host, left with no session and no client, exits by itself. Each host on
   * another computer this device is connected to is told the same at the
   * same time, by its own setting (Keep them running unless set) unless the
   * answer kept them this once; one not connected is told nothing. A Helm that
   * ends any other way tells no host anything, so nothing ends and the next
   * start reattaches.
   */
  let hostStop: 'running' | 'stopping' | 'stopped' = 'running'
  app.on('before-quit', (event) => {
    if (hostStop !== 'stopped') {
      event.preventDefault()
      if (hostStop === 'running') {
        hostStop = 'stopping'
        desktopHost.browserRelay.stop()
        desktopHost.pluginRelay.stop()
        desktopHost.profiles.shutdown()
        desktopHost.plugins.shutdown()
        desktopHost.remotePlugins.shutdown()
        desktopHost.workspace.shutdown()
        desktopHost.files.shutdown()
        desktopHost.resources.stop()
        desktopHost.sessions.shutdown()
        // Every page's bridge ends first, so none is left running; each host is
        // then told by its own setting, or the quit question's answer.
        const answer = quitGate.answer()
        void Promise.all([
          pageLinks.stop().then(() => desktopHost.link.quit({ end: quitEnds(answer, settingEnds()) })),
          remoteHosts.quit((id) => quitEnds(answer, remoteEnds(id)))
        ])
          .finally(() => {
            hostStop = 'stopped'
            app.quit()
          })
      }
      return
    }
    // Flush whatever the debounce is still holding.
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()
    // The hidden plugin window and the frames go with the window.
    plugins.shutdown()
    activity.stop()
    /*
     * The browser views die here too, and it is the same argument.
     *
     * A `WebContentsView` is a render process, and it belongs to the main process
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
  const clipboardText = createClipboardText(clipboard)
  ipcMain.handle('clipboard:read', () => clipboardText.read())
  ipcMain.handle('clipboard:write', async (_e, text: string) => ({ outcome: await clipboardText.write(text) }))
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
  // Before any window: it records what every page sends and is sent (e2e only).
  installIpcRecorder()

  // None on Windows and Linux, where the default menu's Edit > Copy would
  // swallow Ctrl+C before xterm sees it; the app and Edit menus on macOS,
  // where Cmd+C, Cmd+V, Cmd+Z, Cmd+A and Cmd+Q are menu items (chrome.ts).
  const menu = applicationMenuTemplate(process.platform, app.name, () => quitFromMenu())
  Menu.setApplicationMenu(menu === null ? null : Menu.buildFromTemplate(menu))

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


