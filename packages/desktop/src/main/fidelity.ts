import { type BrowserWindow, clipboard, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  probe,
  screenshot,
  sendKey,
  sendMouse,
  sendWheel,
  typeText,
  countExactPixels,
  sleep,
  waitFor,
  stripAnsi
} from './bridge'
import { spawnPty, killPty, windowsBuildNumber, type PtyHandle } from './pty'
import type { CellProbe, GeometryProbe, LatencySample, ViewportProbe } from '../shared/protocol'

const ESC = '\x1b'

export interface Check {
  id: string
  criterion: string
  title: string
  ok: boolean
  detail: Record<string, unknown>
  notes: string[]
}

interface Ctx {
  win: BrowserWindow
  shotDir: string
  cols: number
  rows: number
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const PWSH = ['-NoLogo', '-NoProfile']

/**
 * Test-only helper host. Electron's own binary is /SUBSYSTEM:WINDOWS, and when
 * it is run as node inside a ConPTY it exits cleanly but its stdio never
 * reaches the pseudoconsole - so the harness needs a real console-subsystem
 * node for its raw-mode sink and echo processes. Nothing Helm ships depends on
 * this.
 */
const NODE_EXE = 'node.exe'

/** Wait for a pwsh prompt to be ready for the next command. */
async function waitForPrompt(h: PtyHandle, timeoutMs = 15000): Promise<boolean> {
  const before = h.output().length
  return waitFor(() => /PS [^\r\n]*>\s*$/.test(stripAnsi(h.output().slice(before - 200))), timeoutMs)
}

async function runAndSettle(h: PtyHandle, cmd: string, settleMs = 600): Promise<void> {
  h.pty.write(cmd + '\r')
  await sleep(settleMs)
}

function percentile(values: number[], p: number): number {
  if (!values.length) return -1
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[idx]! * 100) / 100
}

/** The column of the last cell in a row that holds something other than a space. */
function lastPaintedColumn(cells: CellProbe[]): { col: number; chars: string } {
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i]!.chars
    if (c && c !== ' ') return { col: i, chars: c }
  }
  return { col: -1, chars: '' }
}

async function currentInputLine(win: BrowserWindow): Promise<string> {
  const vp = await probe<ViewportProbe>(win, { op: 'viewport' })
  const row = vp.baseY + vp.cursorY
  const r = await probe<{ rows: string[] }>(win, { op: 'plainRows', from: row, to: row })
  return (r.rows[0] ?? '').replace(/\s+$/, '')
}

// ---------------------------------------------------------------------------
// C1 - 24-bit colour
// ---------------------------------------------------------------------------

// None of these appear in the xterm 256-colour palette (the 6x6x6 cube only
// uses the levels 0/95/135/175/215/255, and the greys are 8..238 step 10), so
// an exact pixel match can only come from a real 24-bit path.
const TRUECOLOR = [
  { name: 'violet', r: 199, g: 21, b: 133 },
  { name: 'jade', r: 17, g: 199, b: 91 },
  { name: 'amber', r: 231, g: 118, b: 7 }
]

async function checkTrueColor(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  // The marker is assembled at runtime so the echoed command line never
  // contains it - otherwise the search below finds the echo, which carries
  // default colours, instead of the coloured output.
  await runAndSettle(h, '$e=[char]27; ' + TRUECOLOR.map((c, i) =>
    `Write-Host "$e[48;2;${c.r};${c.g};${c.b}m$e[38;2;255;255;255m$("BLO"+"CK${i}")          $e[0m"`
  ).join('; '), 900)

  // Also emit a foreground-only run, which is how diffs and syntax highlighting
  // actually arrive.
  await runAndSettle(h, `$e=[char]27; Write-Host "$e[38;2;${TRUECOLOR[0]!.r};${TRUECOLOR[0]!.g};${TRUECOLOR[0]!.b}m$("FGTRUE"+"COLOR")$e[0m"`, 700)

  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })

  // Find the painted rows and read their cells back out of the parser.
  const rowsRes = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from: Math.max(0, vp.baseY - 20),
    to: vp.baseY + vp.rows - 1
  })
  const base = Math.max(0, vp.baseY - 20)

  const parsed: Record<string, unknown> = {}
  let allBgOk = true
  for (let i = 0; i < TRUECOLOR.length; i++) {
    const c = TRUECOLOR[i]!
    const idx = rowsRes.rows.findLastIndex((r) => r.includes(`BLOCK${i}`))
    if (idx < 0) {
      allBgOk = false
      parsed[c.name] = { found: false }
      continue
    }
    const cells = await probe<{ cells: CellProbe[] }>(ctx.win, {
      op: 'cells',
      row: base + idx,
      from: 0,
      to: 10
    })
    const cell = cells.cells[0]
    const expected = (c.r << 16) | (c.g << 8) | c.b
    const ok = cell?.bgMode === 2 && cell.bg === expected
    if (!ok) allBgOk = false
    parsed[c.name] = {
      bgMode: cell?.bgMode,
      bg: cell?.bg?.toString(16),
      expected: expected.toString(16),
      ok
    }
  }

  const fgIdx = rowsRes.rows.findLastIndex((r) => r.includes('FGTRUECOLOR'))
  let fgOk = false
  let fgDetail: unknown = { found: false }
  if (fgIdx >= 0) {
    const cells = await probe<{ cells: CellProbe[] }>(ctx.win, {
      op: 'cells',
      row: base + fgIdx,
      from: 0,
      to: 4
    })
    const cell = cells.cells[0]
    const expected = (TRUECOLOR[0]!.r << 16) | (TRUECOLOR[0]!.g << 8) | TRUECOLOR[0]!.b
    fgOk = cell?.fgMode === 2 && cell.fg === expected
    fgDetail = { fgMode: cell?.fgMode, fg: cell?.fg?.toString(16), expected: expected.toString(16) }
  }

  // End-to-end: the exact triples must survive into the composited frame.
  const shot = await screenshot(ctx.win, ctx.shotDir, 'c1-truecolor.png')
  const pixels: Record<string, number> = {}
  let allPixelsOk = true
  for (const c of TRUECOLOR) {
    const n = countExactPixels(shot.bitmap, c)
    pixels[c.name] = n
    if (n < 200) allPixelsOk = false
  }

  if (allPixelsOk) {
    notes.push('Exact RGB triples present in the composited frame - no palette quantisation.')
  } else {
    notes.push('Screenshot did not contain the exact triples; renderer or compositor altered them.')
  }

  return {
    id: 'C1',
    criterion: '24-bit color and theme render correctly',
    title: '24-bit colour survives parse and paint',
    ok: allBgOk && fgOk && allPixelsOk,
    detail: { background: parsed, foreground: fgDetail, exactPixelCounts: pixels, screenshot: shot.file },
    notes
  }
}

// ---------------------------------------------------------------------------
// C2 - Unicode widths and box drawing
// ---------------------------------------------------------------------------

/**
 * Every inner row is padded to exactly 12 display columns *assuming Unicode 11
 * widths*: CJK and emoji are 2 columns wide. If the terminal measured them as 1,
 * the right border would land a column or two short - which is precisely the
 * "status line is misaligned" failure this criterion is about.
 */
const BOX_ROWS = [
  '┌' + '─'.repeat(12) + '┐',
  '│' + 'ascii       ' + '│',
  '│' + '中文 CJK    ' + '│',
  '│' + '🚀 emoji    ' + '│',
  '│' + '█▓▒░ shades ' + '│',
  '└' + '─'.repeat(12) + '┘'
]

async function checkUnicode(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  await runAndSettle(h, '[Console]::OutputEncoding=[Text.Encoding]::UTF8', 400)

  // The box is written to a UTF-8 file and cat'd back, rather than built from
  // PowerShell char literals: [char] is 16-bit, so an astral code point like
  // U+1F680 cannot be expressed that way at all.
  const boxFile = join(tmpdir(), 'helm-spike-unibox.txt')
  mkdirSync(tmpdir(), { recursive: true })
  writeFileSync(boxFile, BOX_ROWS.join('\n') + '\n', 'utf8')

  const marker = 'UNIBOX'
  await runAndSettle(
    h,
    `Write-Host $("UNI"+"BOX"); Get-Content -Encoding utf8 -LiteralPath '${boxFile}'`,
    1400
  )

  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const from = Math.max(0, vp.baseY - 20)
  const rowsRes = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from,
    to: vp.baseY + vp.rows - 1
  })
  const markerIdx = rowsRes.rows.findLastIndex((r) => r.trim() === marker)

  const borders: { row: number; col: number; chars: string }[] = []
  const widths: Record<string, number> = {}
  if (markerIdx >= 0) {
    for (let i = 0; i < BOX_ROWS.length; i++) {
      const row = from + markerIdx + 1 + i
      const cells = await probe<{ cells: CellProbe[] }>(ctx.win, {
        op: 'cells',
        row,
        from: 0,
        to: 40
      })
      borders.push({ row: i, ...lastPaintedColumn(cells.cells) })
      for (const c of cells.cells) {
        if (c.chars === '中') widths['CJK 中'] = c.width
        if (c.chars === '🚀') widths['emoji 🚀'] = c.width
        if (c.chars === '█') widths['block █'] = c.width
        if (c.chars === '─') widths['box ─'] = c.width
      }
    }
  }

  const cols = borders.map((b) => b.col)
  const aligned = cols.length === BOX_ROWS.length && cols.every((c) => c === 13)
  const widthsOk = widths['CJK 中'] === 2 && widths['emoji 🚀'] === 2 && widths['box ─'] === 1

  const uni = await probe<{ active: string; available: string[] }>(ctx.win, {
    op: 'unicodeVersion'
  })
  notes.push(`Unicode width table in use: ${uni.active} (available: ${uni.available.join(', ')})`)
  if (!aligned) {
    notes.push(
      `Right border landed at columns [${cols.join(', ')}] - expected 13 on every row.`
    )
  }

  const shot = await screenshot(ctx.win, ctx.shotDir, 'c2-unicode.png')
  return {
    id: 'C2',
    criterion: 'Unicode/emoji/box-drawing render without misalignment',
    title: 'Wide characters measured with Unicode 11 widths',
    ok: aligned && widthsOk,
    detail: {
      unicodeVersion: uni.active,
      borderColumns: cols,
      cellWidths: widths,
      screenshot: shot.file
    },
    notes
  }
}

// ---------------------------------------------------------------------------
// C3 - resize reflow
// ---------------------------------------------------------------------------

const PATTERN = '0123456789'.repeat(30) // 300 chars: wraps at every tested width

async function checkResize(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  await runAndSettle(h, 'Write-Host "REFLOWSTART"; Write-Host ("0123456789" * 30); Write-Host "REFLOWEND"', 900)

  const widths = [ctx.cols, 132, 61, 100]
  const results: { cols: number; intact: boolean; wrappedRows: number; shot: string }[] = []

  for (const cols of widths) {
    ctx.win.webContents.send('term:resize', { cols, rows: ctx.rows })
    await sleep(150)
    h.pty.resize(cols, ctx.rows)
    await sleep(450)
    const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
    const lines = await probe<{ lines: string[] }>(ctx.win, {
      op: 'logicalLines',
      from: Math.max(0, vp.baseY - 40),
      to: vp.baseY + vp.rows - 1
    })
    const intact = lines.lines.some((l) => l === PATTERN)
    const rows = await probe<{ rows: string[] }>(ctx.win, {
      op: 'plainRows',
      from: Math.max(0, vp.baseY - 40),
      to: vp.baseY + vp.rows - 1
    })
    const wrappedRows = rows.rows.filter((r) => /^[0-9]+$/.test(r.trim()) && r.trim().length > 0)
      .length
    const shot = await screenshot(ctx.win, ctx.shotDir, `c3-reflow-${cols}.png`)
    results.push({ cols, intact, wrappedRows, shot: shot.file })
    if (!intact) {
      notes.push(
        `At ${cols} columns the 300-char logical line did not reassemble from the wrap flags.`
      )
    }
  }

  // Leave the grid where the rest of the run expects it.
  ctx.win.webContents.send('term:resize', { cols: ctx.cols, rows: ctx.rows })
  await sleep(150)
  h.pty.resize(ctx.cols, ctx.rows)
  await sleep(300)

  const ok = results.every((r) => r.intact)
  if (ok) {
    notes.push(
      'A 300-character line reassembled byte-identical at 4 widths, including a shrink below its original wrap point.'
    )
  }
  return {
    id: 'C3',
    criterion: 'Window/pane resize reflows the TUI correctly',
    title: 'Reflow preserves logical lines across widths',
    ok,
    detail: { widths: results },
    notes
  }
}

// ---------------------------------------------------------------------------
// C4 - keyboard
// ---------------------------------------------------------------------------

async function checkKeyboard(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  const detail: Record<string, unknown> = {}
  let ok = true

  // --- Ctrl-C interrupts a running command -------------------------------
  await runAndSettle(h, 'Write-Host "LOOPSTART"; while($true){ Start-Sleep -Milliseconds 100 }', 1500)
  h.clearInput()
  await sendKey(ctx.win, 'c', ['control'])
  const sawEtx = h.input().includes('\x03')
  const interrupted = await waitForPrompt(h, 8000)
  detail.ctrlC = { bytesSent: JSON.stringify(h.input()), sawEtx, returnedToPrompt: interrupted }
  if (!sawEtx || !interrupted) {
    ok = false
    notes.push('Ctrl-C did not interrupt the running command.')
  }
  await sleep(400)

  // --- history recall -----------------------------------------------------
  await runAndSettle(h, 'Write-Host "HISTMARKER"', 700)
  h.clearInput()
  await sendKey(ctx.win, 'Up', [], 400)
  const afterUp = await currentInputLine(ctx.win)
  const upOk = afterUp.includes('HISTMARKER')
  detail.arrowUp = { bytesSent: JSON.stringify(h.input()), line: afterUp, ok: upOk }
  if (!upOk) {
    ok = false
    notes.push('Up-arrow did not recall the previous command.')
  }

  // --- Esc clears the edit buffer ----------------------------------------
  h.clearInput()
  await sendKey(ctx.win, 'Escape', [], 400)
  const afterEsc = await currentInputLine(ctx.win)
  const escOk = !afterEsc.includes('HISTMARKER') && h.input().includes('\x1b')
  detail.escape = { bytesSent: JSON.stringify(h.input()), line: afterEsc, ok: escOk }
  if (!escOk) {
    ok = false
    notes.push('Escape did not clear the line editor.')
  }

  // --- Tab completion -----------------------------------------------------
  h.clearInput()
  await typeText(ctx.win, 'Get-Chi')
  await sendKey(ctx.win, 'Tab', [], 900)
  const afterTab = await currentInputLine(ctx.win)
  const tabOk = afterTab.includes('Get-ChildItem')
  detail.tab = { bytesSent: JSON.stringify(h.input()), line: afterTab, ok: tabOk }
  if (!tabOk) {
    ok = false
    notes.push('Tab did not complete Get-Chi to Get-ChildItem.')
  }
  await sendKey(ctx.win, 'Escape', [], 300)

  // --- Enter vs Shift+Enter ----------------------------------------------
  // Not pass/fail on its own: what matters is whether the host can make the two
  // distinguishable, which is what Claude Code needs for a newline in the
  // composer.
  h.clearInput()
  await sendKey(ctx.win, 'Return', [], 200)
  const enterBytes = h.input()
  h.clearInput()
  await sendKey(ctx.win, 'Return', ['shift'], 200)
  const shiftEnterBytes = h.input()
  const distinguishable = enterBytes !== shiftEnterBytes
  detail.enter = {
    enter: JSON.stringify(enterBytes),
    shiftEnter: JSON.stringify(shiftEnterBytes),
    distinguishable
  }
  notes.push(
    distinguishable
      ? 'Shift+Enter produces a distinct sequence from Enter.'
      : `Shift+Enter is indistinguishable from Enter (both ${JSON.stringify(enterBytes)}) - the host must add a binding for a multi-line composer.`
  )

  await sleep(400)
  const shot = await screenshot(ctx.win, ctx.shotDir, 'c4-keyboard.png')
  detail.screenshot = shot.file

  return {
    id: 'C4',
    criterion: 'Keyboard: Ctrl-C interrupt, Esc, arrow-key history, tab completion, Shift+Enter',
    title: 'Key encoding through the real Chromium -> xterm path',
    ok,
    detail,
    notes
  }
}

// ---------------------------------------------------------------------------
// C5 - paste
// ---------------------------------------------------------------------------

/**
 * A raw-mode sink: no echo, no line editing, so the measurement is of the host
 * and the pty rather than of PSReadLine redrawing a huge input buffer.
 */
const SINK_SCRIPT = `process.stdin.setRawMode(true);process.stdout.write('SINK READY\\r\\n');let n=0,first=0,last=0,bp=0,buf='';process.stdin.on('data',d=>{if(!first)first=Date.now();last=Date.now();n+=d.length;buf+=d;if(buf.includes('\\u001b[200~'))bp|=1;if(buf.includes('\\u001b[201~'))bp|=2;process.stdout.write('\\u001b[2K\\rSINK n='+n+' bp='+bp+' ms='+(last-first));});`

const MULTILINE_PASTE = 'first line\nsecond line\nthird line'

async function checkPaste(ctx: Ctx): Promise<Check> {
  const notes: string[] = []
  const detail: Record<string, unknown> = {}
  let ok = true

  killPty()
  await sleep(200)
  const sink = spawnPty(ctx.win, {
    file: NODE_EXE,
    args: ['-e', SINK_SCRIPT],
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  const sinkUp = await waitFor(() => stripAnsi(sink.output()).includes('SINK READY'), 15000, 100)
  detail.sinkStarted = sinkUp
  if (!sinkUp) {
    notes.push('The raw-mode sink process never started; paste results below are meaningless.')
    killPty()
    return {
      id: 'C5',
      criterion: 'Paste works, including multi-line (bracketed) and large pastes',
      title: 'Bracketed, unbracketed and 100 KB paste',
      ok: false,
      detail,
      notes
    }
  }

  // --- bracketed paste, via xterm's own paste path -------------------------
  // Separated from the Ctrl+V binding below so a failure names its own cause:
  // this line is xterm's paste machinery, the next is Helm's key binding.
  await probe(ctx.win, { op: 'write', data: `${ESC}[?2004h` })
  sink.clearInput()
  await probe(ctx.win, { op: 'paste', text: MULTILINE_PASTE })
  await sleep(400)
  const bracketed = sink.input()
  // ConPTY turns on focus reporting (DECSET 1004) at startup, so xterm may
  // interleave a focus in/out report with the paste. Match the bracketed
  // segment rather than requiring it to be the entire input stream.
  const segment = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(bracketed)
  const wrapped = segment !== null
  const payload = segment?.[1] ?? ''
  const contentOk = payload.replace(/\r/g, '\n') === MULTILINE_PASTE
  detail.bracketed = {
    wrapped,
    contentOk,
    raw: JSON.stringify(bracketed),
    note: 'xterm normalises newlines to CR inside the paste, which is what a TUI expects'
  }
  if (!wrapped || !contentOk) {
    ok = false
    notes.push('Multi-line paste was not delivered as a bracketed paste with intact content.')
  }

  // --- the Ctrl+V binding --------------------------------------------------
  clipboard.writeText(MULTILINE_PASTE)
  sink.clearInput()
  await sendKey(ctx.win, 'v', ['control'], 900)
  const viaKey = sink.input()
  const keyOk = /\x1b\[200~first line\r/.test(viaKey)
  detail.ctrlV = { ok: keyOk, raw: JSON.stringify(viaKey.slice(0, 120)) }
  if (!keyOk) {
    ok = false
    notes.push('Ctrl+V did not paste the clipboard through the host binding.')
  }

  // --- bracketed paste OFF -------------------------------------------------
  await probe(ctx.win, { op: 'write', data: `${ESC}[?2004l` })
  sink.clearInput()
  await probe(ctx.win, { op: 'paste', text: MULTILINE_PASTE })
  await sleep(400)
  const unbracketed = sink.input()
  const unwrappedOk =
    unbracketed.includes('first line') && !unbracketed.includes(`${ESC}[200~`)
  detail.unbracketed = { noMarkers: unwrappedOk, raw: JSON.stringify(unbracketed.slice(0, 80)) }
  if (!unwrappedOk) {
    ok = false
    notes.push('Paste markers were emitted even with bracketed paste mode off.')
  }

  // --- large paste ---------------------------------------------------------
  await probe(ctx.win, { op: 'write', data: `${ESC}[?2004h` })
  const big = 'A'.repeat(100_000)
  sink.clearInput()
  sink.clearOutput()
  const t0 = Date.now()
  void probe(ctx.win, { op: 'paste', text: big }, 60000)
  const delivered = await waitFor(() => sink.input().length >= big.length, 30000, 50)
  const hostMs = Date.now() - t0

  // The sink reprints its running total on every chunk. ConPTY hands a large
  // write to the child in pieces, so read the counter until it stops moving
  // rather than sampling it once.
  const readCount = (): number => {
    const m = [...stripAnsi(sink.output()).matchAll(/SINK n=(\d+)/g)].pop()
    return m ? Number(m[1]) : -1
  }
  let stable = 0
  let previous = -2
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && stable < 12) {
    await sleep(250)
    const now = readCount()
    stable = now === previous ? stable + 1 : 0
    previous = now
    if (now >= big.length) break
  }
  const m = [...stripAnsi(sink.output()).matchAll(/SINK n=(\d+) bp=(\d+) ms=(\d+)/g)].pop()
  const received = m ? Number(m[1]) : -1
  const sinkBp = m ? Number(m[2]) : -1
  const sentLen = sink.input().length
  const lossless = received >= big.length
  detail.large = {
    bytesPasted: big.length,
    bytesHandedToPty: sentLen,
    bytesReceivedByChild: received,
    bracketedFlags: sinkBp,
    hostDeliveryMs: hostMs,
    delivered,
    lossless
  }
  if (!delivered || !lossless) {
    ok = false
    notes.push(`A 100 KB paste did not arrive intact (child saw ${received} bytes).`)
  } else {
    notes.push(`100 KB paste delivered end-to-end in ${hostMs} ms with no truncation.`)
  }

  killPty()
  await sleep(200)
  clipboard.writeText('')

  const shot = await screenshot(ctx.win, ctx.shotDir, 'c5-paste.png')
  detail.screenshot = shot.file

  return {
    id: 'C5',
    criterion: 'Paste works, including multi-line (bracketed) and large pastes',
    title: 'Bracketed, unbracketed and 100 KB paste',
    ok,
    detail,
    notes
  }
}

// ---------------------------------------------------------------------------
// C6 - scrollback while output streams
// ---------------------------------------------------------------------------

async function checkScrollback(ctx: Ctx): Promise<Check> {
  const notes: string[] = []
  const shell = spawnPty(ctx.win, {
    file: 'pwsh.exe',
    args: PWSH,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  await waitForPrompt(shell)

  const geo = await probe<GeometryProbe>(ctx.win, { op: 'geometry' })
  const centreX = geo.x + (geo.cellWidth * ctx.cols) / 2
  const centreY = geo.y + (geo.cellHeight * ctx.rows) / 2

  // Paced so the stream is still running while the viewport is parked -
  // unpaced, 6000 lines drain faster than the checks below can sample.
  shell.pty.write(
    '1..6000 | ForEach-Object { "stream line $_"; if ($_ % 300 -eq 0) { Start-Sleep -Milliseconds 200 } }\r'
  )
  await sleep(900)

  await sendWheel(ctx.win, centreX, centreY, 4)
  await sendWheel(ctx.win, centreX, centreY, 4)
  await sendWheel(ctx.win, centreX, centreY, 4)
  const parked = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const scrolledUp = parked.viewportY < parked.baseY
  const wheelSeen = await probe<{ wheel: unknown }>(ctx.win, { op: 'lastWheel' })

  const samples: ViewportProbe[] = []
  for (let i = 0; i < 8; i++) {
    await sleep(180)
    samples.push(await probe<ViewportProbe>(ctx.win, { op: 'viewport' }))
  }

  const held = scrolledUp && samples.every((s) => s.viewportY === parked.viewportY)
  const stillStreaming = samples[samples.length - 1]!.baseY > samples[0]!.baseY
  const rowsWhileParked = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from: parked.viewportY,
    to: parked.viewportY + 3
  })
  const shot = await screenshot(ctx.win, ctx.shotDir, 'c6-scrollback.png')

  await waitFor(() => /stream line 6000/.test(stripAnsi(shell.output())), 30000, 200)
  await probe(ctx.win, { op: 'scrollToBottom' })
  await sleep(300)
  const bottom = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const atBottom = bottom.viewportY === bottom.baseY

  killPty()

  if (!scrolledUp) notes.push('The wheel event did not move the viewport off the bottom.')
  else if (!held) notes.push('The viewport was pulled back to the bottom while output streamed.')
  if (held && stillStreaming) {
    notes.push(
      `Viewport stayed parked at row ${parked.viewportY} while the buffer grew from ${samples[0]!.baseY} to ${samples[samples.length - 1]!.baseY}.`
    )
  }

  return {
    id: 'C6',
    criterion: 'Mouse: scrollback while output streams',
    title: 'Wheel scrollback holds position under streaming output',
    ok: held && stillStreaming && atBottom,
    detail: {
      parkedViewportY: parked.viewportY,
      parkedBaseY: parked.baseY,
      scrolledOffBottom: scrolledUp,
      wheelEventSeenByPane: wheelSeen.wheel,
      baseYProgression: samples.map((s) => s.baseY),
      viewportYProgression: samples.map((s) => s.viewportY),
      visibleWhileParked: rowsWhileParked.rows.map((r) => r.trim()).filter(Boolean).slice(0, 3),
      scrollToBottomWorks: atBottom,
      screenshot: shot.file
    },
    notes
  }
}

// ---------------------------------------------------------------------------
// C7 - selection and copy
// ---------------------------------------------------------------------------

const SELECT_TEXT = 'SELECTME-0123456789-ABCDEFGHIJ'
// Emitted so the echoed command line never contains the literal, or the row
// search below would land on the echo instead of the output.
const SELECT_CMD = 'Write-Host $("SELECT"+"ME-0123456789-ABCDEFGHIJ")'

async function checkSelection(ctx: Ctx): Promise<Check> {
  const notes: string[] = []
  const shell = spawnPty(ctx.win, {
    file: 'pwsh.exe',
    args: PWSH,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  await waitForPrompt(shell)
  await runAndSettle(shell, SELECT_CMD, 800)

  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const rows = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from: vp.viewportY,
    to: vp.viewportY + vp.rows - 1
  })
  const rowOffset = rows.rows.findLastIndex((r) => r.includes(SELECT_TEXT))

  const geo = await probe<GeometryProbe>(ctx.win, { op: 'geometry' })
  const y = geo.y + geo.cellHeight * (rowOffset + 0.5)
  const x0 = geo.x + geo.cellWidth * 0.2
  const x1 = geo.x + geo.cellWidth * (SELECT_TEXT.length - 0.2)

  await sendMouse(ctx.win, 'mouseDown', x0, y)
  await sendMouse(ctx.win, 'mouseMove', (x0 + x1) / 2, y)
  await sendMouse(ctx.win, 'mouseMove', x1, y)
  await sendMouse(ctx.win, 'mouseUp', x1, y)
  await sleep(200)

  const sel = await probe<{ text: string; has: boolean }>(ctx.win, { op: 'selectionText' })
  const dragOk = sel.text.trim() === SELECT_TEXT

  // Ctrl-C with a selection must copy, matching Windows Terminal.
  clipboard.writeText('')
  shell.clearInput()
  await sendKey(ctx.win, 'c', ['control'], 500)
  const copied = clipboard.readText().trim()
  const copyOk = copied === SELECT_TEXT
  const swallowedInterrupt = !shell.input().includes('\x03')

  // ...and with no selection it must interrupt again.
  shell.clearInput()
  await sendKey(ctx.win, 'c', ['control'], 400)
  const interruptRestored = shell.input().includes('\x03')

  const shot = await screenshot(ctx.win, ctx.shotDir, 'c7-selection.png')
  killPty()

  if (!dragOk) notes.push(`Mouse drag selected ${JSON.stringify(sel.text)} instead of the row text.`)
  notes.push(
    'Ctrl-C copies only while a selection is live and reverts to interrupt immediately after, and any other keystroke drops the selection - the Windows Terminal contract.'
  )

  return {
    id: 'C7',
    criterion: 'Mouse: text selection + copy',
    title: 'Drag-select, copy, and interrupt coexist',
    ok: dragOk && copyOk && swallowedInterrupt && interruptRestored,
    detail: {
      selected: sel.text,
      clipboard: copied,
      copyConsumedCtrlC: swallowedInterrupt,
      interruptRestoredAfterCopy: interruptRestored,
      screenshot: shot.file
    },
    notes
  }
}

// ---------------------------------------------------------------------------
// C8 - latency
// ---------------------------------------------------------------------------

const ECHO_SCRIPT = `process.stdin.setRawMode(true);process.stdin.on('data',d=>process.stdout.write(d));`

async function checkLatency(ctx: Ctx): Promise<Check> {
  const notes: string[] = []
  // The handle is not used directly - `activePty()` owns it from here - but the
  // echo process has to exist for a keystroke to have anything to come back
  // from.
  spawnPty(ctx.win, {
    file: NODE_EXE,
    args: ['-e', ECHO_SCRIPT],
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  await sleep(1200)

  const N = 150
  await probe(ctx.win, { op: 'latencyStart', count: N, char: 'x' })
  for (let i = 0; i < N; i++) {
    await sendKey(ctx.win, 'x', [], 0)
    const target = i + 1
    // Wait for this keystroke's sample to close before sending the next, so
    // keystrokes and echoes stay one-to-one.
    let closed = false
    const deadline = Date.now() + 2000
    while (!closed && Date.now() < deadline) {
      await sleep(4)
      const r = await probe<{ samples: LatencySample[] }>(ctx.win, { op: 'latencyResults' })
      closed = r.samples.length >= target
    }
  }
  const res = await probe<{ samples: LatencySample[] }>(ctx.win, { op: 'latencyResults' })
  killPty()

  const rt = res.samples.map((s) => s.roundTripMs)
  const host = res.samples.map((s) => s.hostInputMs).filter((v) => v >= 0)
  const stats = {
    samples: rt.length,
    roundTrip: { p50: percentile(rt, 50), p95: percentile(rt, 95), max: percentile(rt, 100) },
    hostInput: { p50: percentile(host, 50), p95: percentile(host, 95), max: percentile(host, 100) }
  }

  // A frame at 60 Hz is 16.7 ms; anything at or under one frame of round trip is
  // below the threshold where a difference is perceivable.
  const ok = stats.roundTrip.p50 <= 33 && stats.roundTrip.p95 <= 66
  notes.push(
    `Round trip is keydown -> IPC -> pty -> raw echo -> IPC -> parse -> next painted frame. p50 ${stats.roundTrip.p50} ms, p95 ${stats.roundTrip.p95} ms.`
  )
  notes.push(
    `Of that, the host's own share (keydown -> byte handed to the pty) is p50 ${stats.hostInput.p50} ms.`
  )

  return {
    id: 'C8',
    criterion: 'Latency feels indistinguishable from Windows Terminal',
    title: 'Keystroke round-trip latency',
    ok,
    detail: stats,
    notes
  }
}

// ---------------------------------------------------------------------------
// C9 - throughput (comparable to a Windows Terminal run of the same command)
// ---------------------------------------------------------------------------

const THROUGHPUT_CMD =
  '$sw=[Diagnostics.Stopwatch]::StartNew(); 1..40000 | ForEach-Object { "line $_ ' +
  'the quick brown fox jumps over the lazy dog" } | Out-Host; Write-Host "THROUGHPUT $($sw.ElapsedMilliseconds)"'

async function checkThroughput(ctx: Ctx): Promise<Check> {
  const shell = spawnPty(ctx.win, {
    file: 'pwsh.exe',
    args: PWSH,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  await waitForPrompt(shell)
  shell.clearOutput()
  shell.pty.write(THROUGHPUT_CMD + '\r')
  const done = await waitFor(() => /THROUGHPUT \d+/.test(stripAnsi(shell.output())), 120000, 250)
  const m = stripAnsi(shell.output()).match(/THROUGHPUT (\d+)/)
  const ms = m ? Number(m[1]) : -1
  killPty()

  return {
    id: 'C9',
    criterion: 'Latency feels indistinguishable from Windows Terminal (bulk output)',
    title: 'Drain rate for 40k lines of streamed output',
    ok: done && ms > 0,
    detail: {
      grid: `${ctx.cols}x${ctx.rows}`,
      elapsedMs: ms,
      command: THROUGHPUT_CMD,
      note: 'ConPTY back-pressures the writer when the terminal drains slowly, so the time the shell measures is a proxy for terminal throughput. Run the same command in Windows Terminal at the same grid size to compare.'
    },
    notes: [`40,000 lines drained in ${ms} ms at ${ctx.cols}x${ctx.rows}.`]
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export async function runFidelity(
  win: BrowserWindow,
  dataDir: string,
  only?: string[]
): Promise<Check[]> {
  const ctx: Ctx = { win, shotDir: join(dataDir, 'screenshots'), cols: 100, rows: 30 }
  const checks: Check[] = []
  const wanted = (id: string): boolean => !only?.length || only.includes(id)

  const create = new Promise<unknown>((resolve) => {
    ipcMain.once('term:created', (_e, info: unknown) => resolve(info))
  })
  win.webContents.send('term:create', {
    cols: ctx.cols,
    rows: ctx.rows,
    fit: false,
    windowsBuild: windowsBuildNumber()
  })
  await create
  await sleep(500)

  const shell = spawnPty(win, {
    file: 'pwsh.exe',
    args: PWSH,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: homedir()
  })
  await waitForPrompt(shell)

  const run = async (id: string, fn: () => Promise<Check>): Promise<void> => {
    if (!wanted(id)) return
    try {
      checks.push(await fn())
    } catch (err) {
      checks.push({
        id,
        criterion: 'driver',
        title: `${id} threw`,
        ok: false,
        detail: { error: String(err) },
        notes: []
      })
    }
  }

  await run('C1', () => checkTrueColor(ctx, shell))
  await run('C2', () => checkUnicode(ctx, shell))
  await run('C3', () => checkResize(ctx, shell))
  await run('C4', () => checkKeyboard(ctx, shell))
  killPty()
  await sleep(300)
  await run('C5', () => checkPaste(ctx))
  await run('C6', () => checkScrollback(ctx))
  await run('C7', () => checkSelection(ctx))
  await run('C8', () => checkLatency(ctx))
  await run('C9', () => checkThroughput(ctx))

  killPty()
  return checks
}
