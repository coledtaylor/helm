import { app, type BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { screenshot, sleep, stripAnsi, waitFor } from './bridge'
import { killPty, spawnPty, windowsBuildNumber } from './pty'

/**
 * Spike B's proof, kept as a regression: SQLite and node-pty both work from a
 * portable build, and the real claude TUI reaches its input prompt.
 */

export interface SqliteResult {
  ok: boolean
  dbPath: string
  journalMode?: string
  roundtrip?: string
  error?: string
}

export function testSqlite(dataDir: string): SqliteResult {
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
    return {
      ok: row.note === note && journalMode === 'wal',
      dbPath,
      journalMode,
      roundtrip: row.note
    }
  } catch (err) {
    return { ok: false, dbPath, error: String(err) }
  }
}

function createTerm(win: BrowserWindow, cols: number, rows: number, fit: boolean): Promise<void> {
  return new Promise((resolve) => {
    ipcMain.once('term:created', () => resolve())
    win.webContents.send('term:create', { cols, rows, fit, windowsBuild: windowsBuildNumber() })
  })
}

function resizeTerm(win: BrowserWindow, cols: number, rows: number): Promise<void> {
  return new Promise((resolve) => {
    ipcMain.once('term:resized', () => resolve())
    win.webContents.send('term:resize', { cols, rows })
  })
}

export async function runSelftest(
  win: BrowserWindow,
  dataDir: string
): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {}
  const shots = join(dataDir, 'screenshots')

  report.sqlite = testSqlite(dataDir)

  await createTerm(win, 80, 24, false)
  const shell = spawnPty(win, {
    file: 'pwsh.exe',
    args: ['-NoLogo'],
    cols: 80,
    rows: 24,
    cwd: homedir()
  })
  const marker =
    'Write-Host "SPIKE-PTY $([Console]::WindowWidth)x$([Console]::WindowHeight)" -ForegroundColor Green; ' +
    'Write-Host "SPIKE-COLOR" -ForegroundColor Red -BackgroundColor Yellow'
  await waitFor(() => shell.output().includes('PS '), 15000)
  shell.pty.write(marker + '\r')
  const ptyOk = await waitFor(() => shell.output().includes('SPIKE-PTY 80x24'), 10000)

  for (const ch of 'echo ("SPIKE"+"-KEYS")\r') {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep(15)
  }
  const keysOk = await waitFor(() => shell.output().includes('SPIKE-KEYS'), 10000)
  await sleep(400)
  const shot1 = await screenshot(win, shots, 'pwsh.png')
  report.pty = {
    ok: ptyOk,
    keyboard: keysOk,
    sawColorMarker: shell.output().includes('SPIKE-COLOR'),
    screenshot: shot1.file
  }

  await resizeTerm(win, 120, 30)
  shell.pty.resize(120, 30)
  await sleep(300)
  shell.pty.write('Write-Host "SPIKE-RESIZE $([Console]::WindowWidth)x$([Console]::WindowHeight)"\r')
  const resizeOk = await waitFor(() => shell.output().includes('SPIKE-RESIZE 120x30'), 10000)
  report.resize = { ok: resizeOk }
  killPty()

  await resizeTerm(win, 100, 30)
  const claude = spawnPty(win, {
    file: join(homedir(), '.local', 'bin', 'claude.exe'),
    cols: 100,
    rows: 30,
    // This checkout, wherever it is - derived, never a literal path under one
    // machine's home directory. In a packaged build `getAppPath()` is the asar,
    // whose parent is beside the exe, which is a directory that exists either
    // way; the selftest only needs somewhere real to start a session in.
    cwd: resolve(app.getAppPath(), '..', '..')
  })
  const answered = new Set<string>()
  const gates = setInterval(() => {
    const plain = stripAnsi(claude.output())
    if (!answered.has('mcp') && /MCP\s*servers/.test(plain)) {
      answered.add('mcp')
      claude.pty.write('\x1b')
    }
    if (!answered.has('trust') && /Do you trust/i.test(plain)) {
      answered.add('trust')
      claude.pty.write('\r')
    }
  }, 300)
  const claudeOk = await waitFor(() => {
    const t = stripAnsi(claude.output())
    return /Claude\s*Code\s*v\d/.test(t) || /\?\s*for\s*shortcuts/.test(t)
  }, 45000)
  clearInterval(gates)
  await sleep(2500)
  const shot2 = await screenshot(win, shots, 'claude.png')
  report.claude = {
    ok: claudeOk,
    bytes: claude.output().length,
    gatesDismissed: [...answered],
    tail: stripAnsi(claude.output()).slice(-300),
    screenshot: shot2.file
  }
  killPty()

  report.pass =
    (report.sqlite as SqliteResult).ok && ptyOk && keysOk && resizeOk && claudeOk
  return report
}
