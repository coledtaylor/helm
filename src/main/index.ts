import { app, BrowserWindow, clipboard, ipcMain, Menu } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { activePty, killPty, spawnPty, windowsBuildNumber } from './pty'
import { runSelftest } from './selftest'
import { runFidelity } from './fidelity'
import { runClaudeChecks } from './claudecheck'

type Mode = 'shell' | 'selftest' | 'fidelity' | 'claude-check' | 'claude'

function modeFromArgv(): Mode {
  if (process.argv.includes('--selftest')) return 'selftest'
  if (process.argv.includes('--fidelity')) return 'fidelity'
  if (process.argv.includes('--claude-check')) return 'claude-check'
  if (process.argv.includes('--claude')) return 'claude'
  return 'shell'
}

const mode = modeFromArgv()

// Portable mode: electron-builder's portable launcher sets PORTABLE_EXECUTABLE_DIR
// to the directory the .exe was run from. App data lives beside the exe in that
// case; %APPDATA% otherwise.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
const dataDir = portableDir ? join(portableDir, 'helm-data') : app.getPath('userData')
if (portableDir) {
  mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    backgroundColor: '#11121a',
    show: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function writeReport(name: string, report: unknown): string {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, name)
  writeFileSync(file, JSON.stringify(report, null, 2))
  return file
}

app.whenReady().then(() => {
  // The default application menu binds Ctrl-C to the Edit>Copy role, which
  // swallows the interrupt before xterm ever sees the keydown. A terminal host
  // cannot ship that menu.
  Menu.setApplicationMenu(null)

  const win = createWindow()

  ipcMain.once('renderer:ready', async () => {
    if (mode === 'selftest') {
      const report = await runSelftest(win, dataDir)
      const file = writeReport('spike-report.json', {
        startedAt: new Date().toISOString(),
        mode: portableDir ? 'portable' : app.isPackaged ? 'installed' : 'dev',
        dataDir,
        versions: process.versions,
        ...report
      })
      console.log(`selftest report: ${file}`)
      killPty()
      setTimeout(() => app.exit(report.pass ? 0 : 1), 200)
      return
    }

    if (mode === 'fidelity') {
      const onlyArg = process.argv.find((a) => a.startsWith('--only='))
      const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
      const checks = await runFidelity(win, dataDir, only)
      const pass = checks.every((c) => c.ok)
      const file = writeReport('fidelity-report.json', {
        startedAt: new Date().toISOString(),
        mode: portableDir ? 'portable' : app.isPackaged ? 'installed' : 'dev',
        dataDir,
        versions: process.versions,
        pass,
        checks
      })
      console.log(`fidelity report: ${file}`)
      for (const c of checks) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
      }
      killPty()
      setTimeout(() => app.exit(pass ? 0 : 1), 200)
      return
    }

    if (mode === 'claude-check') {
      const onlyArg = process.argv.find((a) => a.startsWith('--only='))
      const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : undefined
      const checks = await runClaudeChecks(win, dataDir, only)
      const pass = checks.every((c) => c.ok)
      const file = writeReport('claude-report.json', {
        startedAt: new Date().toISOString(),
        pass,
        checks
      })
      console.log(`claude report: ${file}`)
      for (const c of checks) {
        console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
      }
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
      const claudeExe = join(homedir(), '.local', 'bin', 'claude.exe')
      const useClaude = mode === 'claude'
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
          const { screenshot } = await import('./bridge')
          const shot = await screenshot(win, join(dataDir, 'screenshots'), 'interactive.png')
          console.log(`interactive grid ${info?.cols}x${info?.rows}, screenshot: ${shot.file}`)
          killPty()
          app.exit(0)
        }, delay)
      }
    })
  })
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})
