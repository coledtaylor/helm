import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, protocol } from 'electron'
import { writeSetting, type AppSettings } from '@helm/core'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { emit, registerIpc, resolvedTheme } from './ipc'
import { appMode, dataDir, initDataDir, shimRoot } from './paths'
import { activePty, killAllSessionsSync, killPty, spawnPty, windowsBuildNumber } from './pty'
import { adoptExistingProfile, createServices, refreshGit, runScan, type Services } from './services'
import { createConfigService } from './config'
import {
  attachArtifactConsole,
  CONTENT_SCHEME,
  createContentService,
  registerContentProtocol
} from './content'
import { createHistoryService } from './history'
import { createUsageService } from './usage'
import { createSessionHost, type Confirm, type SessionObserver } from './sessions'
import { createCollector, runM2Checks, type M2Context } from './m2check'
import { runM3Checks } from './m3check'
import { runM4Checks } from './m4check'
import { runM5Checks } from './m5check'
import { runM6Checks } from './m6check'
import { runUsageChecks } from './usagecheck'
import { runSelftest } from './selftest'
import { runFidelity } from './fidelity'
import { runClaudeChecks } from './claudecheck'
import { findClaudeExecutable, setClaudeOverride } from './claude-cli'
import { pickerAnswer, runM7Checks } from './m7check'
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
  | 'm2-check'
  | 'm3-check'
  | 'm4-check'
  | 'm5-check'
  | 'm6-check'
  | 'm7-check'
  | 'm7-firstrun'
  | 'usage-check'
  | 'usage-settings'
  | 'shim-sweep'

function modeFromArgv(): Mode {
  if (process.argv.includes('--selftest')) return 'selftest'
  if (process.argv.includes('--fidelity')) return 'fidelity'
  if (process.argv.includes('--claude-check')) return 'claude-check'
  if (process.argv.includes('--m2-check')) return 'm2-check'
  if (process.argv.includes('--m3-check')) return 'm3-check'
  if (process.argv.includes('--m4-check')) return 'm4-check'
  if (process.argv.includes('--m5-check')) return 'm5-check'
  if (process.argv.includes('--m6-check')) return 'm6-check'
  if (process.argv.includes('--m7-check')) return 'm7-check'
  if (process.argv.includes('--m7-firstrun')) return 'm7-firstrun'
  if (process.argv.includes('--usage-check')) return 'usage-check'
  if (process.argv.includes('--usage-settings')) return 'usage-settings'
  if (process.argv.includes('--shim-sweep')) return 'shim-sweep'
  if (process.argv.includes('--claude')) return 'claude'
  if (process.argv.includes('--shell')) return 'shell'
  return 'app'
}

const mode = modeFromArgv()
// The check modes are the app: they drive the real window, so they need the
// real startup path, the database included.
const isSpikeMode =
  mode !== 'app' &&
  mode !== 'm2-check' &&
  mode !== 'm3-check' &&
  mode !== 'm4-check' &&
  mode !== 'm5-check' &&
  mode !== 'm6-check' &&
  mode !== 'm7-check' &&
  mode !== 'm7-firstrun' &&
  mode !== 'usage-check'

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
  }
])

// Every renderer is our own bundle; nothing else may be navigated to or opened.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
})

function createWindow(
  page: 'index' | 'spike',
  bounds?: AppSettings['windowBounds']
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
    // white on a dark desktop.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0f16' : '#f7f7f9',
    show: true,
    autoHideMenuBar: true,
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
  /** Taps for `--m2-check`; the app itself passes none. */
  observer?: SessionObserver | undefined
  /** Answers the "this session is still running" question. Defaults to a dialog. */
  confirm?: Confirm | undefined
  /** Called once the renderer has mounted and the first scan is under way. */
  onReady?: ((ctx: M2Context) => void) | undefined
  /**
   * Index a different `.claude` tree. Only `--m4-check` passes one, so that
   * the watch can be proved against a fixture it is allowed to append to as
   * well as against the real file.
   */
  claudeHome?: string | undefined
  /**
   * Stand-ins for the native pickers, so `--m7-firstrun` can drive "add a
   * folder" and "locate claude" through the real handlers. Same shape and same
   * reasoning as `confirm`.
   */
  chooseDirectory?: ((title: string) => string | null) | undefined
  chooseFile?: ((title: string) => string | null) | undefined
}

function startApp(options: AppOptions = {}): void {
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
  if (services.lostSessions > 0) {
    console.warn(`${services.lostSessions} session(s) did not outlive the last run; marked lost`)
  }
  if (services.staleShims > 0) {
    console.log(`removed ${String(services.staleShims)} overlay shim(s) left by the last run`)
  }

  let win: BrowserWindow | null = createWindow('index', services.settings.windowBounds ?? null)

  const sessions = createSessionHost({
    services,
    window: () => win,
    observer: options.observer,
    confirm: options.confirm
  })

  const history = createHistoryService({
    store: services.store,
    home: options.claudeHome,
    onChange: (summary) => emit(win, 'history:changed', summary)
  })

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

  registerIpc({
    services,
    sessions,
    history,
    usage,
    config,
    content,
    window: () => win,
    ...(options.claudeHome !== undefined ? { claudeHome: options.claudeHome } : {}),
    ...(options.chooseDirectory !== undefined ? { chooseDirectory: options.chooseDirectory } : {}),
    ...(options.chooseFile !== undefined ? { chooseFile: options.chooseFile } : {}),
    rendererReady: () => {
      emit(win, 'settings:changed', services.settings)
      emit(win, 'theme:changed', {
        preference: services.settings.theme,
        resolved: resolvedTheme()
      })
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
        try {
          emit(win, 'history:changed', history.refresh())
        } catch (err) {
          console.warn(`history index could not be built: ${String(err)}`)
        }
        history.start()

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
      })

      if (win) options.onReady?.({ win, services, sessions, history, usage, config, content })
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
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow('index', services.settings.windowBounds ?? null)
    }
  })

  app.on('before-quit', () => {
    // Flush whatever the debounce is still holding.
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()
    // Before the store is let go of: a debounced index pass, or a config watch
    // firing after `will-quit`, would write to a closed connection.
    history.stop()
    usage.stop()
    config.stop()
    // Synchronously, because this is the last point the main process is
    // guaranteed a turn. Anything deferred here is a process left behind.
    sessions.shutdown()
  })

  app.on('will-quit', () => {
    // Not in `before-quit`: the windows have not closed yet at that point, and
    // closing a window persists its bounds. Here every window is gone, so this
    // is the first moment nothing can still want the database. Letting go of it
    // checkpoints the WAL rather than leaving it for the next launch.
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

app.whenReady().then(() => {
  // The default application menu binds Ctrl-C to the Edit>Copy role, which
  // swallows the interrupt before xterm ever sees the keydown. A terminal host
  // cannot ship that menu.
  Menu.setApplicationMenu(null)

  // Windows resolves a toast back to an installed application through this id.
  // Without it the exit notifications either carry electron.app.Electron's
  // identity in dev or do not appear at all.
  app.setAppUserModelId('dev.coletaylor.helm')

  // The artifact scheme's handler. Registered for every mode that opens a
  // window, because the spike pages share this process and a scheme with no
  // handler fails a load rather than falling through to something worse.
  registerContentProtocol()

  /**
   * A real app start, and nothing else.
   *
   * The "stale shims are swept at startup" criterion is about what
   * `createServices` does on the way in, which the process that already started
   * cannot assert about itself. So `--m3-check` plants what a crash would have
   * left and this runs afterwards: same startup path, no window, and a report
   * of what it removed.
   */
  if (mode === 'shim-sweep') {
    const services = createServices()
    const file = writeReport('shim-sweep.json', {
      startedAt: new Date().toISOString(),
      shimRoot,
      removed: services.staleShims
    })
    console.log(`shim sweep: removed ${String(services.staleShims)} shim(s); report: ${file}`)
    services.store.close()
    app.exit(0)
    return
  }

  /**
   * The second phase of `usage-check`, and the whole of it.
   *
   * "The mode survives a restart" is a claim about a process that has not
   * started yet, so the process that set the mode cannot make it. The driver
   * leaves the setting on something other than its default and this reads it
   * back through the ordinary startup path - same store, same `readSettings` -
   * and writes down what it found. Same shape as `--shim-sweep`.
   */
  if (mode === 'usage-settings') {
    const services = createServices()
    const found = services.settings.usageDisplay
    const file = writeReport('usage-settings.json', {
      startedAt: new Date().toISOString(),
      usageDisplay: found,
      dbFile: services.store.file
    })
    console.log(`usage settings after restart: ${found}; report: ${file}`)

    // `--set=` puts the user's own setting back afterwards, because the driver
    // parked it on a non-default value in the real database to have something
    // to read.
    const setArg = process.argv.find((a) => a.startsWith('--set='))
    if (setArg) {
      const value = setArg.slice('--set='.length)
      if (value === 'percent' || value === 'cost' || value === 'off') {
        writeSetting(services.store, 'usageDisplay', value)
        console.log(`usage display restored to ${value}`)
      }
    }

    services.store.close()
    app.exit(0)
    return
  }

  if (isSpikeMode) {
    startSpike()
    return
  }

  if (mode === 'm2-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        void runM2Checks(ctx, collector, join(dataDir, 'screenshots'))
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('m2-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`m2-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            // `quit`, not `exit`: M2-9 left a session running on purpose, and
            // the whole point is to make the app's own teardown deal with it.
            // `exit` would skip `before-quit` and prove nothing.
            // Quitting is itself under test - M2-9 left a session running for
            // the app's own teardown to reap - so the run ends with `quit`,
            // not `exit`, and forces the status once the teardown is done.
            app.once('quit', () => process.exit(pass ? 0 : 1))
            // Armed before the quit, not after: if `app.quit()` throws or a
            // handler blocks, a watchdog scheduled behind it never exists.
            setTimeout(() => app.exit(pass ? 0 : 1), 30_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`m2-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'm3-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the sessions it opened, so every confirmation it
        // provokes is one it asked for on purpose.
        collector.answerWith(true)
        void runM3Checks(ctx, collector, join(dataDir, 'screenshots'), dataDir)
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('m3-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`m3-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            // M3-9 planted a stale shim for the `--shim-sweep` start that
            // follows, so this run must end the same way a real one does -
            // through `quit`, not `exit`, which would skip the teardown.
            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`m3-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'm4-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it resumed, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runM4Checks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('m4-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`m4-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`m4-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'm5-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it launched, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runM5Checks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('m5-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`m5-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`m5-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  if (mode === 'm6-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runM6Checks(
          ctx,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('m6-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`m6-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`m6-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

  /**
   * M7, in two starts.
   *
   * `--m7-check` runs against this machine: the grep audit and what the real
   * `claude` here actually is.
   *
   * `--m7-firstrun` is the other half, and it is a separate process because
   * "a machine with a fresh `~/.claude` and no harness at all" is not a state
   * this one can enter. The driver starts it with `PORTABLE_EXECUTABLE_DIR`
   * pointed at a temporary directory - the app's own portable-mode mechanism,
   * used as the isolation - so it opens an empty database beside that directory
   * and touches neither `%APPDATA%\Helm` nor the user's `~/.claude`, which it is
   * pointed away from with `--claude-home=`.
   */
  if (mode === 'm7-check' || mode === 'm7-firstrun') {
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
      ...(mode === 'm7-firstrun'
        ? {
            chooseDirectory: (title: string) => pickerAnswer('directory', title),
            chooseFile: (title: string) => pickerAnswer('file', title)
          }
        : {}),
      onReady: (ctx) => {
        collector.answerWith(true)
        void runM7Checks(ctx, collector, join(dataDir, 'screenshots'), dataDir, {
          phase: mode === 'm7-check' ? 'machine' : 'firstrun',
          ...(fixtures !== undefined ? { fixtures } : {}),
          ...(claudeHome !== undefined ? { claudeHome } : {}),
          ...(onlyArg !== undefined ? { only: onlyArg.split(',') } : {})
        })
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport(
              mode === 'm7-check' ? 'm7-report.json' : 'm7-firstrun-report.json',
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

  if (mode === 'usage-check') {
    const collector = createCollector()
    startApp({
      observer: collector,
      confirm: collector.confirm,
      onReady: (ctx) => {
        // The driver closes the session it started, so every confirmation is
        // one it asked for on purpose.
        collector.answerWith(true)
        const onlyArg = process.argv.find((a) => a.startsWith('--only='))
        void runUsageChecks(
          ctx,
          collector,
          join(dataDir, 'screenshots'),
          dataDir,
          onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
        )
          .then((checks) => {
            const pass = checks.every((c) => c.ok)
            const file = writeReport('usage-report.json', {
              startedAt: new Date().toISOString(),
              mode: appMode,
              dataDir,
              versions: process.versions,
              pass,
              checks
            })
            console.log(`usage-check report: ${file}`)
            for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

            app.once('quit', () => process.exit(pass ? 0 : 1))
            setTimeout(() => app.exit(pass ? 0 : 1), 60_000)
            setTimeout(() => app.quit(), 200)
          })
          .catch((err: unknown) => {
            console.error(`usage-check crashed: ${String(err)}`)
            setTimeout(() => app.exit(1), 200)
          })
      }
    })
    return
  }

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


