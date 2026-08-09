import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'
import * as pty from 'node-pty'

const isSelftest = process.argv.includes('--selftest')

// Portable mode: electron-builder's portable launcher sets PORTABLE_EXECUTABLE_DIR
// to the directory the .exe was run from. App data lives beside the exe in that
// case; %APPDATA% otherwise.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
const dataDir = portableDir
  ? join(portableDir, 'helm-data')
  : app.getPath('userData')
if (portableDir) {
  mkdirSync(dataDir, { recursive: true })
  app.setPath('userData', dataDir)
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

interface SqliteResult {
  ok: boolean
  dbPath: string
  journalMode?: string
  roundtrip?: string
  error?: string
}

function testSqlite(): SqliteResult {
  const dbPath = join(dataDir, 'helm.db')
  try {
    mkdirSync(dataDir, { recursive: true })
    const db = new Database(dbPath)
    const journalMode = db.pragma('journal_mode = WAL', { simple: true }) as string
    db.exec('CREATE TABLE IF NOT EXISTS spike (id INTEGER PRIMARY KEY, note TEXT NOT NULL)')
    const note = `hello-from-${process.versions.electron}-${Date.now()}`
    const info = db.prepare('INSERT INTO spike (note) VALUES (?)').run(note)
    const row = db.prepare('SELECT note FROM spike WHERE id = ?').get(info.lastInsertRowid) as {
      note: string
    }
    db.close()
    return { ok: row.note === note && journalMode === 'wal', dbPath, journalMode, roundtrip: row.note }
  } catch (err) {
    return { ok: false, dbPath, error: String(err) }
  }
}

// ---------------------------------------------------------------------------
// PTY plumbing
// ---------------------------------------------------------------------------

let currentPty: pty.IPty | null = null

function spawnPty(
  win: BrowserWindow,
  file: string,
  args: string[],
  cols: number,
  rows: number,
  cwd: string,
  onData?: (chunk: string) => void
): pty.IPty {
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env as Record<string, string>
  })
  p.onData((chunk) => {
    win.webContents.send('term:write', chunk)
    onData?.(chunk)
  })
  currentPty = p
  return p
}

function killPty(): void {
  try {
    currentPty?.kill()
  } catch {
    // already dead
  }
  currentPty = null
}

ipcMain.on('pty:input', (_e, data: string) => currentPty?.write(data))
ipcMain.on('pty:resize', (_e, size: { cols: number; rows: number }) => {
  try {
    currentPty?.resize(size.cols, size.rows)
  } catch {
    // pty may have exited
  }
})

// ---------------------------------------------------------------------------
// Renderer helpers
// ---------------------------------------------------------------------------

function createTerm(win: BrowserWindow, cols: number, rows: number, fit: boolean): Promise<void> {
  return new Promise((resolve) => {
    ipcMain.once('term:created', () => resolve())
    win.webContents.send('term:create', { cols, rows, fit })
  })
}

function resizeTerm(win: BrowserWindow, cols: number, rows: number): Promise<void> {
  return new Promise((resolve) => {
    ipcMain.once('term:resized', () => resolve())
    win.webContents.send('term:resize', { cols, rows })
  })
}

function waitFor(
  buffer: () => string,
  predicate: (text: string) => boolean,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      if (predicate(buffer())) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 100)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// TUI output interleaves cursor-movement/style sequences inside words, so text
// matching must happen on a stripped view of the stream.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Z0-9]|\x1b[=><]|\r|\n/g
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '')

async function screenshot(win: BrowserWindow, name: string): Promise<string> {
  const dir = join(dataDir, 'screenshots')
  mkdirSync(dir, { recursive: true })
  const image = await win.webContents.capturePage()
  const file = join(dir, name)
  writeFileSync(file, image.toPNG())
  return file
}

// ---------------------------------------------------------------------------
// Selftest driver
// ---------------------------------------------------------------------------

async function runSelftest(win: BrowserWindow): Promise<void> {
  const report: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    exePath: process.execPath,
    argv: process.argv,
    mode: portableDir ? 'portable' : app.isPackaged ? 'installed' : 'dev',
    portableDir: portableDir ?? null,
    dataDir,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      abi: process.versions.modules
    }
  }
  let exitCode = 0

  try {
    // 1. SQLite
    report.sqlite = testSqlite()

    // 2. pwsh in a pty
    let buf = ''
    await createTerm(win, 80, 24, false)
    const shell = spawnPty(win, 'pwsh.exe', ['-NoLogo'], 80, 24, homedir(), (c) => (buf += c))
    const marker =
      'Write-Host "SPIKE-PTY $([Console]::WindowWidth)x$([Console]::WindowHeight)" -ForegroundColor Green; ' +
      'Write-Host "SPIKE-COLOR" -ForegroundColor Red -BackgroundColor Yellow'
    await waitFor(
      () => buf,
      (t) => t.includes('PS '),
      15000
    )
    shell.write(marker + '\r')
    const ptyOk = await waitFor(() => buf, (t) => t.includes('SPIKE-PTY 80x24'), 10000)
    // Interactive keyboard path: synthesize key events in the renderer so input
    // travels keyboard -> xterm -> IPC -> pty, the same route a user's typing
    // takes. The concatenation means the typed line never contains the marker;
    // only executed output does.
    for (const ch of 'echo ("SPIKE"+"-KEYS")\r') {
      win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
      await sleep(15)
    }
    const keysOk = await waitFor(() => buf, (t) => t.includes('SPIKE-KEYS'), 10000)
    await sleep(400)
    const shot1 = await screenshot(win, 'pwsh.png')
    report.pty = {
      ok: ptyOk,
      keyboard: keysOk,
      sawColorMarker: buf.includes('SPIKE-COLOR'),
      screenshot: shot1
    }

    // 3. Resize: pty + xterm to 120x30, then ask the shell what it sees
    await resizeTerm(win, 120, 30)
    shell.resize(120, 30)
    await sleep(300)
    shell.write('Write-Host "SPIKE-RESIZE $([Console]::WindowWidth)x$([Console]::WindowHeight)"\r')
    const resizeOk = await waitFor(() => buf, (t) => t.includes('SPIKE-RESIZE 120x30'), 10000)
    report.resize = { ok: resizeOk }
    killPty()

    // 4. Real claude TUI in the pty. Startup can show interactive gates (folder
    // trust, MCP server enablement) - those are themselves TUI renders, but we
    // dismiss them to reach the main input prompt.
    buf = ''
    await resizeTerm(win, 100, 30)
    const claudeExe = join(homedir(), '.local', 'bin', 'claude.exe')
    const claude = spawnPty(
      win,
      claudeExe,
      [],
      100,
      30,
      join(homedir(), '.harness', 'dev', 'repos', 'helm'),
      (c) => (buf += c)
    )
    const answered = new Set<string>()
    const gates = setInterval(() => {
      const plain = stripAnsi(buf)
      if (!answered.has('mcp') && /MCP\s*servers/.test(plain)) {
        answered.add('mcp')
        claude.write('\x1b') // Esc: reject all, leave config untouched
      }
      if (!answered.has('trust') && /Do you trust/i.test(plain)) {
        answered.add('trust')
        claude.write('\r')
      }
    }, 300)
    const claudeOk = await waitFor(
      () => stripAnsi(buf),
      (t) => /Claude\s*Code\s*v\d/.test(t) || /\?\s*for\s*shortcuts/.test(t),
      45000
    )
    clearInterval(gates)
    await sleep(2500)
    const shot2 = await screenshot(win, 'claude.png')
    report.claude = {
      ok: claudeOk,
      bytes: buf.length,
      gatesDismissed: [...answered],
      tail: stripAnsi(buf).slice(-300),
      screenshot: shot2
    }
    killPty()

    exitCode =
      (report.sqlite as SqliteResult).ok && ptyOk && keysOk && resizeOk && claudeOk ? 0 : 1
  } catch (err) {
    report.fatal = String(err)
    exitCode = 2
  }

  report.finishedAt = new Date().toISOString()
  report.pass = exitCode === 0
  writeFileSync(join(dataDir, 'spike-report.json'), JSON.stringify(report, null, 2))
  killPty()
  setTimeout(() => app.exit(exitCode), 200)
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 750,
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

app.whenReady().then(() => {
  const win = createWindow()
  ipcMain.once('renderer:ready', async () => {
    if (isSelftest) {
      await runSelftest(win)
    } else {
      await createTerm(win, 80, 24, true)
      spawnPty(win, 'pwsh.exe', ['-NoLogo'], 80, 24, homedir())
    }
  })
})

app.on('window-all-closed', () => {
  killPty()
  app.quit()
})
