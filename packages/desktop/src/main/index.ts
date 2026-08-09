import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme } from 'electron'
import { writeSetting, type AppSettings } from '@helm/core'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import { emit, registerIpc, resolvedTheme } from './ipc'
import { appMode, dataDir, initDataDir } from './paths'
import { activePty, killPty, spawnPty, windowsBuildNumber } from './pty'
import { createServices, refreshGit, runScan, type Services } from './services'
import { runSelftest } from './selftest'
import { runFidelity } from './fidelity'
import { runClaudeChecks } from './claudecheck'
import { findClaudeExecutable } from './claude-cli'
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

type Mode = 'app' | 'shell' | 'selftest' | 'fidelity' | 'claude-check' | 'claude'

function modeFromArgv(): Mode {
  if (process.argv.includes('--selftest')) return 'selftest'
  if (process.argv.includes('--fidelity')) return 'fidelity'
  if (process.argv.includes('--claude-check')) return 'claude-check'
  if (process.argv.includes('--claude')) return 'claude'
  if (process.argv.includes('--shell')) return 'shell'
  return 'app'
}

const mode = modeFromArgv()
const isSpikeMode = mode !== 'app'

initDataDir()

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

function startApp(): void {
  const services: Services = createServices()

  let win: BrowserWindow | null = createWindow('index', services.settings.windowBounds ?? null)

  registerIpc({
    services,
    window: () => win,
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
    }
  })

  const persistBounds = (): void => {
    if (!win || win.isDestroyed() || win.isMinimized()) return
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
    // Flush whatever the debounce is still holding, then let go of the file so
    // the WAL is checkpointed rather than left for the next launch to recover.
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = null
    persistBounds()
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

  if (isSpikeMode) startSpike()
  else startApp()
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})


