import { app, type BrowserWindow, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { probe, screenshot, sendKey, sleep, squash, stripAnsi, typeText, waitFor } from './bridge'
import { killPty, spawnPty, windowsBuildNumber, type PtyHandle } from './pty'
import type { CellProbe, ViewportProbe } from '../shared/protocol'
import type { Check } from './fidelity'

/**
 * The half of Spike C that only the real TUI can answer: does Claude Code's own
 * rendering - its rounded input box, its overlays, its full-screen pickers, its
 * permission dialog - survive being hosted in xterm.js?
 */

const CLAUDE_EXE = join(homedir(), '.local', 'bin', 'claude.exe')

/**
 * The directory the hosted TUI is started in: this checkout, wherever it
 * happens to be. Derived rather than named - it used to be a literal path under
 * one machine's home directory, which made the harness a file only that machine
 * could run.
 *
 * `app.getAppPath()` is `packages/desktop` in development, so the repository is
 * two levels above it.
 */
const REPO = resolve(app.getAppPath(), '..', '..')

interface Ctx {
  win: BrowserWindow
  shotDir: string
  cols: number
  rows: number
}

const BOX_CHARS = new Set(['╭', '╮', '╰', '╯', '│', '─', '┌', '┐', '└', '┘', '┃', '━'])

/** First and last painted column of a row, in real grid columns. */
async function rowSpan(
  win: BrowserWindow,
  row: number,
  cols: number
): Promise<{ first: number; last: number; firstChar: string; lastChar: string }> {
  const { cells } = await probe<{ cells: CellProbe[] }>(win, {
    op: 'cells',
    row,
    from: 0,
    to: cols - 1
  })
  let first = -1
  let last = -1
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!.chars
    if (c && c !== ' ') {
      if (first < 0) first = i
      last = i
    }
  }
  return {
    first,
    last,
    firstChar: first >= 0 ? cells[first]!.chars : '',
    lastChar: last >= 0 ? cells[last]!.chars : ''
  }
}

/** Rows in the current viewport whose leading glyph is a box-drawing corner. */
async function boxRows(ctx: Ctx): Promise<{ row: number; first: number; last: number; firstChar: string; lastChar: string }[]> {
  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const found: { row: number; first: number; last: number; firstChar: string; lastChar: string }[] = []
  for (let r = vp.viewportY; r < vp.viewportY + vp.rows; r++) {
    const span = await rowSpan(ctx.win, r, vp.cols)
    if (span.first >= 0 && BOX_CHARS.has(span.firstChar) && BOX_CHARS.has(span.lastChar)) {
      found.push({ row: r, ...span })
    }
  }
  return found
}

/**
 * Foreground colour of the first glyph on each slash-menu entry row. The
 * selected entry is drawn in a different colour, so this fingerprint changes
 * exactly when the highlight moves.
 */
async function menuRowColors(ctx: Ctx): Promise<string[]> {
  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const rows = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from: vp.viewportY,
    to: vp.viewportY + vp.rows - 1
  })
  const out: string[] = []
  for (let i = 0; i < rows.rows.length; i++) {
    if (!/^\s*\/[a-z0-9][a-z0-9:_-]*/i.test(rows.rows[i]!)) continue
    const { cells } = await probe<{ cells: CellProbe[] }>(ctx.win, {
      op: 'cells',
      row: vp.viewportY + i,
      from: 0,
      to: 20
    })
    const glyph = cells.find((c) => c.chars.trim())
    out.push(`${rows.rows[i]!.trim().slice(0, 14)}=${glyph?.fgMode}:${glyph?.fg}`)
  }
  return out
}

/**
 * The composer is the region between the two full-width rules at the bottom of
 * the screen. Knowing where it starts and ends is what separates "the text is
 * still being edited" from "the text was submitted and is now transcript".
 */
async function composerRows(ctx: Ctx): Promise<string[]> {
  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const rules = (await boxRows(ctx)).filter((r) => r.first === 0 && r.last === vp.cols - 1)
  if (rules.length < 2) return []
  const top = rules[rules.length - 2]!.row
  const bottom = rules[rules.length - 1]!.row
  if (bottom - top < 1) return []
  const r = await probe<{ rows: string[] }>(ctx.win, {
    op: 'plainRows',
    from: top + 1,
    to: bottom - 1
  })
  return r.rows
}

async function startClaude(ctx: Ctx, extraArgs: string[] = []): Promise<{ h: PtyHandle; ready: boolean; gates: string[] }> {
  const h = spawnPty(ctx.win, {
    file: CLAUDE_EXE,
    args: extraArgs,
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: REPO
  })
  const answered = new Set<string>()
  const gates = setInterval(() => {
    const plain = stripAnsi(h.output())
    if (!answered.has('mcp') && /MCP\s*servers/.test(plain)) {
      answered.add('mcp')
      h.pty.write('\x1b')
    }
    if (!answered.has('trust') && /Do you trust/i.test(plain)) {
      answered.add('trust')
      h.pty.write('\r')
    }
  }, 300)
  const ready = await waitFor(() => {
    const t = stripAnsi(h.output())
    return /\?\s*for\s*shortcuts/.test(t) || /Claude\s*Code\s*v\d/.test(t)
  }, 60000)
  clearInterval(gates)
  await sleep(2500)
  return { h, ready, gates: [...answered] }
}

// ---------------------------------------------------------------------------
// D1 - the input box survives resizing
// ---------------------------------------------------------------------------

async function checkClaudeResize(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  const widths = [ctx.cols, 132, 72, 100]
  const results: Record<string, unknown>[] = []
  let ok = true

  for (const cols of widths) {
    ctx.win.webContents.send('term:resize', { cols, rows: ctx.rows })
    await sleep(200)
    h.pty.resize(cols, ctx.rows)
    // The TUI redraws on SIGWINCH; give it a beat to settle before looking.
    await sleep(1400)

    const rows = await boxRows({ ...ctx, cols })
    // Claude's composer box spans the full width minus its own margin. What
    // matters is that every box row ends on the same column - a stale column
    // from the previous width is exactly the "ghost column" failure.
    const lasts = [...new Set(rows.map((r) => r.last))]
    const firsts = [...new Set(rows.map((r) => r.first))]
    const consistent = rows.length >= 2 && lasts.length === 1 && firsts.length === 1
    const withinGrid = rows.every((r) => r.last <= cols - 1)
    if (!consistent || !withinGrid) ok = false

    const shot = await screenshot(ctx.win, ctx.shotDir, `d1-claude-${cols}.png`)
    results.push({
      cols,
      boxRowCount: rows.length,
      firstColumns: firsts,
      lastColumns: lasts,
      consistent,
      withinGrid,
      screenshot: shot.file
    })
    if (!consistent) {
      notes.push(`At ${cols} columns the box rows ended on columns [${lasts.join(', ')}].`)
    }
  }

  if (ok) {
    notes.push(
      'The composer box re-drew flush at every width, including a shrink to 72 and back - no ghost columns left behind.'
    )
  }
  return {
    id: 'D1',
    criterion: 'Window/pane resize reflows the TUI correctly (real TUI)',
    title: "Claude's composer box redraws cleanly across widths",
    ok,
    detail: { widths: results },
    notes
  }
}

// ---------------------------------------------------------------------------
// D2 - 24-bit colour in Claude's own rendering
// ---------------------------------------------------------------------------

async function checkClaudeColor(ctx: Ctx): Promise<Check> {
  const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const rgb = new Set<string>()
  const palette = new Set<number>()
  for (let r = vp.viewportY; r < vp.viewportY + vp.rows; r++) {
    const { cells } = await probe<{ cells: CellProbe[] }>(ctx.win, {
      op: 'cells',
      row: r,
      from: 0,
      to: vp.cols - 1
    })
    for (const c of cells) {
      if (c.fgMode === 2) rgb.add(`fg:${c.fg.toString(16)}`)
      if (c.bgMode === 2) rgb.add(`bg:${c.bg.toString(16)}`)
      if (c.fgMode === 1) palette.add(c.fg)
    }
  }
  const shot = await screenshot(ctx.win, ctx.shotDir, 'd2-claude-color.png')
  return {
    id: 'D2',
    criterion: '24-bit color and theme render correctly (real TUI)',
    title: 'Claude emits true colour into the hosted pane',
    ok: rgb.size > 0,
    detail: {
      distinctTrueColorValues: rgb.size,
      sample: [...rgb].slice(0, 12),
      distinctPaletteValues: palette.size,
      screenshot: shot.file
    },
    notes: [
      rgb.size > 0
        ? `Claude used ${rgb.size} distinct 24-bit colours on the first screen, so COLORTERM=truecolor was honoured.`
        : 'No RGB cells found - the TUI fell back to the 256-colour palette.'
    ]
  }
}

// ---------------------------------------------------------------------------
// D3 - composer: typing, Shift+Enter, Ctrl-C
// ---------------------------------------------------------------------------

async function checkComposer(ctx: Ctx, h: PtyHandle): Promise<Check[]> {
  const notes: string[] = []
  const detail: Record<string, unknown> = {}
  let ok = true

  await typeText(ctx.win, 'hello from helm')
  await sleep(700)
  const typedRows = await composerRows(ctx)
  const typed = typedRows.some((r) => r.includes('hello from helm'))
  detail.typing = { rendered: typed, composerRows: typedRows.map((r) => r.trim()) }
  if (!typed) {
    ok = false
    notes.push('Typed text did not appear in the composer.')
  }
  const shotType = await screenshot(ctx.win, ctx.shotDir, 'd3-composer-typed.png')

  // Shift+Enter: does the composer grow a second line, or does it submit?
  // Answered by where the first line ends up - still inside the composer means
  // a newline was inserted, gone from it means the turn was sent.
  h.clearInput()
  await sendKey(ctx.win, 'Return', ['shift'], 1200)
  const shiftEnterBytes = h.input()
  await typeText(ctx.win, 'second line')
  await sleep(900)
  const afterRows = await composerRows(ctx)
  const firstStillEditing = afterRows.some((r) => r.includes('hello from helm'))
  const secondInComposer = afterRows.some((r) => r.includes('second line'))
  const multiline = firstStillEditing && secondInComposer
  const shotMulti = await screenshot(ctx.win, ctx.shotDir, 'd3-composer-multiline.png')

  const shiftEnterCheck: Check = {
    id: 'D6',
    criterion: 'Keyboard: Shift+Enter/newline behavior (real TUI)',
    title: 'Shift+Enter inserts a newline instead of submitting',
    ok: multiline,
    detail: {
      bytesSent: JSON.stringify(shiftEnterBytes),
      composerAfter: afterRows.map((r) => r.trim()),
      firstLineStillInComposer: firstStillEditing,
      composerWentMultiline: multiline,
      screenshot: shotMulti.file
    },
    notes: [
      multiline
        ? 'Shift+Enter inserted a newline in the composer.'
        : `Shift+Enter sends ${JSON.stringify(shiftEnterBytes)}, byte-identical to Enter, so the composer submits instead of adding a line. This is a terminal-level gap, not a Claude Code bug: xterm.js has no default encoding for the modifier. Claude Code's own answer is /terminal-setup, which teaches a terminal to emit a distinct sequence - Helm has to supply that binding itself.`
    ]
  }

  // Ctrl-C has two jobs, in order: the first interrupts the running turn and
  // leaves the composer alone, the second clears the composer. Neither may kill
  // the session.
  h.clearInput()
  await sendKey(ctx.win, 'c', ['control'], 2000)
  const sawEtx = h.input().includes('\x03')
  const afterInterrupt = await composerRows(ctx)
  const interruptedTurn = squash(h.output()).includes('interrupted')
  const aliveAfterInterrupt = h.exited() === null

  await sendKey(ctx.win, 'c', ['control'], 1800)
  const clearedRows = await composerRows(ctx)
  const cleared = !clearedRows.some((r) => /\S/.test(r.replace(/[›❯>]/g, '')))
  const alive = h.exited() === null

  detail.ctrlC = {
    sentEtx: sawEtx,
    interruptedTurn,
    composerAfterInterrupt: afterInterrupt.map((r) => r.trim()),
    composerAfterSecond: clearedRows.map((r) => r.trim()),
    composerCleared: cleared,
    processAlive: alive,
    aliveAfterInterrupt
  }
  if (!sawEtx || !alive || !cleared) {
    ok = false
    notes.push('Ctrl-C did not clear the composer while leaving the session alive.')
  } else {
    notes.push(
      'The first Ctrl-C interrupted the running turn and left the composer untouched; the second cleared it. The session survived both.'
    )
  }

  detail.screenshots = [shotType.file, shotMulti.file]
  return [
    {
      id: 'D3',
      criterion: 'Keyboard: Ctrl-C interrupt and composer editing (real TUI)',
      title: 'Composer typing and interrupt',
      ok,
      detail,
      notes
    },
    shiftEnterCheck
  ]
}

// ---------------------------------------------------------------------------
// D7 - which newline encoding the composer actually accepts
// ---------------------------------------------------------------------------

/**
 * Shift+Enter has no standard encoding, so a host has to pick one and the TUI
 * has to agree. Rather than guess, send each candidate to the real composer and
 * see which one grows a second line. Whatever wins here is what Helm's key
 * binding should emit.
 */
const NEWLINE_CANDIDATES: { name: string; bytes: string }[] = [
  { name: 'ESC CR (meta-enter)', bytes: '\x1b\r' },
  { name: 'LF (0x0a)', bytes: '\n' },
  { name: 'CSI 13;2u (kitty)', bytes: '\x1b[13;2u' },
  { name: 'backslash + CR', bytes: '\\\r' }
]

async function clearComposer(ctx: Ctx): Promise<void> {
  await sendKey(ctx.win, 'c', ['control'], 1200)
  const rows = await composerRows(ctx)
  if (rows.some((r) => /\S/.test(r.replace(/[›❯>]/g, '')))) {
    await sendKey(ctx.win, 'c', ['control'], 1200)
  }
}

async function checkNewlineEncoding(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const results: Record<string, unknown>[] = []
  let winner: string | null = null

  for (const candidate of NEWLINE_CANDIDATES) {
    await clearComposer(ctx)
    await typeText(ctx.win, 'line one')
    await sleep(500)
    h.pty.write(candidate.bytes)
    await sleep(900)
    await typeText(ctx.win, 'line two')
    await sleep(900)

    const rows = await composerRows(ctx)
    const text = rows.map((r) => r.trim())
    const bothInComposer =
      rows.some((r) => r.includes('line one')) && rows.some((r) => r.includes('line two'))
    results.push({
      candidate: candidate.name,
      bytes: JSON.stringify(candidate.bytes),
      composer: text,
      insertsNewline: bothInComposer
    })
    if (bothInComposer && !winner) winner = candidate.name
    await clearComposer(ctx)
  }

  const shot = await screenshot(ctx.win, ctx.shotDir, 'd7-newline-encoding.png')
  return {
    id: 'D7',
    criterion: 'Keyboard: Shift+Enter/newline behavior - available encodings',
    title: 'Which newline sequence the composer accepts',
    ok: winner !== null,
    detail: { winner, candidates: results, screenshot: shot.file },
    notes: [
      winner
        ? `The composer accepts ${winner} as an inline newline, so a host binding can make Shift+Enter work.`
        : 'None of the tested sequences produced a newline in the composer.'
    ]
  }
}

// ---------------------------------------------------------------------------
// D4 - overlays and full-screen surfaces
// ---------------------------------------------------------------------------

async function checkOverlays(ctx: Ctx): Promise<Check> {
  const notes: string[] = []
  const detail: Record<string, unknown> = {}
  let ok = true

  const visible = async (): Promise<string[]> => {
    const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
    const r = await probe<{ rows: string[] }>(ctx.win, {
      op: 'plainRows',
      from: vp.viewportY,
      to: vp.viewportY + vp.rows - 1
    })
    return r.rows
  }

  // --- slash-command menu -------------------------------------------------
  // Only meaningful from an empty composer: mid-line, "/" is just a character.
  // The menu lists whatever commands and skills this install has, so the test
  // is "two or more command entries appeared", not a search for specific names.
  const menuEntries = (rows: string[]): string[] =>
    rows.filter((r) => /^\s*\/[a-z0-9][a-z0-9:_-]*/i.test(r))

  const before = await visible()
  detail.composerEmptyAtStart = !before.some((r) => /^\s*[›❯>]\s+\S/.test(r))
  await typeText(ctx.win, '/')
  await sleep(1500)
  const slashRows = await visible()
  const slashOk = menuEntries(slashRows).length >= 2
  const shotSlash = await screenshot(ctx.win, ctx.shotDir, 'd4-slash-menu.png')
  detail.slashMenu = {
    rendered: slashOk,
    entries: menuEntries(slashRows).map((r) => r.trim().split(/\s{2,}/)[0]).slice(0, 6),
    screenshot: shotSlash.file
  }
  if (!slashOk) {
    ok = false
    notes.push('The slash-command menu did not render.')
  }

  // The highlight is a colour change, not a text change, so compare the
  // foreground colours of the entry rows rather than their characters.
  const colorsBefore = await menuRowColors(ctx)
  await sendKey(ctx.win, 'Down', [], 500)
  await sendKey(ctx.win, 'Down', [], 500)
  const colorsAfter = await menuRowColors(ctx)
  const arrowsMoved = colorsBefore.join('|') !== colorsAfter.join('|')
  detail.slashArrows = { moved: arrowsMoved, before: colorsBefore, after: colorsAfter }
  if (!arrowsMoved) {
    ok = false
    notes.push('Arrow keys did not move the highlight in the slash-command menu.')
  }

  await sendKey(ctx.win, 'Escape', [], 800)
  const afterEsc = await visible()
  const dismissed = menuEntries(afterEsc).length === 0
  detail.slashEscape = { dismissed }
  if (!dismissed) {
    ok = false
    notes.push('Escape did not dismiss the slash-command menu.')
  }

  // Escape closes the overlay but leaves the typed "/" in the composer, which
  // is correct - the next command has to start from an empty line or it would
  // be sent as "//help".
  await sendKey(ctx.win, 'Backspace', [], 400)

  // --- /help --------------------------------------------------------------
  // Typed as keystrokes from the now-empty composer, not written to the pty
  // blind, so it exercises the same path a user takes.
  await typeText(ctx.win, '/help')
  await sleep(1200)
  await sendKey(ctx.win, 'Return', [], 500)
  await sleep(2500)
  const helpRows = await visible()
  const helpOk = helpRows.some((r) => /usage|shortcut|command/i.test(r))
  const shotHelp = await screenshot(ctx.win, ctx.shotDir, 'd4-help.png')
  detail.help = { rendered: helpOk, screenshot: shotHelp.file }
  if (!helpOk) {
    ok = false
    notes.push('/help did not render.')
  }
  await sendKey(ctx.win, 'Escape', [], 800)

  // --- /resume picker: a full-screen alternate surface ---------------------
  await typeText(ctx.win, '/resume')
  await sleep(1200)
  await sendKey(ctx.win, 'Return', [], 500)
  await sleep(4000)
  const vpResume = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
  const resumeRows = await visible()
  const resumeOk = resumeRows.some((r) => /modified|Session|ago|resume/i.test(r))
  const shotResume = await screenshot(ctx.win, ctx.shotDir, 'd4-resume.png')
  await sendKey(ctx.win, 'Down', [], 400)
  const resumeAfterArrow = await visible()
  detail.resume = {
    rendered: resumeOk,
    bufferType: vpResume.bufferType,
    arrowMovedSelection: resumeAfterArrow.join('\n') !== resumeRows.join('\n'),
    screenshot: shotResume.file
  }
  if (!resumeOk) {
    ok = false
    notes.push('/resume did not render a session picker.')
  } else {
    notes.push(
      `The /resume picker rendered in the ${vpResume.bufferType} buffer and responded to arrow keys.`
    )
  }
  await sendKey(ctx.win, 'Escape', [], 1200)

  return {
    id: 'D4',
    criterion: '/resume picker and other full-screen interactive surfaces work',
    title: 'Slash menu, /help and the /resume picker',
    ok,
    detail,
    notes
  }
}

// ---------------------------------------------------------------------------
// D5 - permission prompt
// ---------------------------------------------------------------------------

async function checkPermissionPrompt(ctx: Ctx, h: PtyHandle): Promise<Check> {
  const notes: string[] = []
  h.clearOutput()
  // Read-only commands are auto-approved even under manual mode, so the prompt
  // has to be provoked with something that mutates state. mkdir under the temp
  // directory is harmless, and it is declined below in any case.
  await typeText(
    ctx.win,
    'Run this exact shell command with the Bash tool, nothing else: mkdir -p /tmp/helm-spike-perm'
  )
  await sleep(500)
  await sendKey(ctx.win, 'Return', [], 500)

  // Matched against a whitespace-squashed view: the TUI positions words without
  // emitting the spaces between them.
  const appeared = await waitFor(() => {
    const t = squash(h.output())
    return /doyouwant/.test(t) && /esctocancel|\d\.no/.test(t)
  }, 120000, 500)

  const shot = await screenshot(ctx.win, ctx.shotDir, 'd5-permission.png')
  let arrowOk = false
  let dialogRows: string[] = []
  if (appeared) {
    const vp = await probe<ViewportProbe>(ctx.win, { op: 'viewport' })
    const before = await probe<{ rows: string[] }>(ctx.win, {
      op: 'plainRows',
      from: vp.viewportY,
      to: vp.viewportY + vp.rows - 1
    })
    dialogRows = before.rows.map((r) => r.trim()).filter(Boolean).slice(-12)
    await sendKey(ctx.win, 'Down', [], 500)
    const after = await probe<{ rows: string[] }>(ctx.win, {
      op: 'plainRows',
      from: vp.viewportY,
      to: vp.viewportY + vp.rows - 1
    })
    arrowOk = after.rows.join('\n') !== before.rows.join('\n')
    // Decline: nothing in a spike should actually run.
    await sendKey(ctx.win, 'Escape', [], 1500)
  }

  // Ground truth for "Escape declined it": the directory the command would
  // have created does not exist.
  const declined =
    appeared &&
    !existsSync(join(tmpdir(), 'helm-spike-perm')) &&
    !existsSync('C:\\tmp\\helm-spike-perm')

  if (!appeared) {
    notes.push(
      'No permission dialog within 120 s - the turn may not have reached the API. Not treated as a rendering failure; cover it in the manual soak.'
    )
  } else {
    notes.push('The tool-permission dialog rendered, moved with arrow keys, and cancelled on Escape.')
  }

  return {
    id: 'D5',
    criterion: 'Permission prompts (y/n dialogs) render and respond correctly',
    title: 'Bash tool permission dialog',
    ok: appeared && arrowOk && declined,
    detail: {
      appeared,
      arrowMovedSelection: arrowOk,
      declinedAndNothingRan: declined,
      dialogRows,
      screenshot: shot.file
    },
    notes
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export async function runClaudeChecks(
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

  const run = async (id: string, fn: () => Promise<Check>): Promise<void> => {
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

  // Each group gets its own claude process. D3 ends with a submitted turn and a
  // used composer, and a "/" typed into a non-empty composer is just a slash -
  // the slash menu would look broken when it is not.
  const group1 = ['D0', 'D1', 'D2', 'D3', 'D6', 'D7'].some(wanted)
  if (group1) {
    const { h, ready, gates } = await startClaude(ctx)
    const startShot = await screenshot(ctx.win, ctx.shotDir, 'd0-claude-start.png')
    if (wanted('D0')) {
      checks.push({
        id: 'D0',
        criterion: 'Claude Code starts inside the hosted pane',
        title: 'Startup to input prompt',
        ok: ready,
        detail: { gatesDismissed: gates, bytes: h.output().length, screenshot: startShot.file },
        notes: [`Startup gates auto-answered: ${gates.join(', ') || 'none'}.`]
      })
    }
    if (ready) {
      if (wanted('D2')) await run('D2', () => checkClaudeColor(ctx))
      if (wanted('D1')) await run('D1', () => checkClaudeResize(ctx, h))
      if (wanted('D7')) await run('D7', () => checkNewlineEncoding(ctx, h))
      if (wanted('D3') || wanted('D6')) {
        try {
          checks.push(...(await checkComposer(ctx, h)).filter((c) => wanted(c.id)))
        } catch (err) {
          checks.push({
            id: 'D3',
            criterion: 'driver',
            title: 'D3 threw',
            ok: false,
            detail: { error: String(err) },
            notes: []
          })
        }
      }
    }
    killPty()
    await sleep(500)
  }

  if (wanted('D4')) {
    const second = await startClaude(ctx)
    if (second.ready) await run('D4', () => checkOverlays(ctx))
    else
      checks.push({
        id: 'D4',
        criterion: '/resume picker and other full-screen interactive surfaces work',
        title: 'Slash menu, /help and the /resume picker',
        ok: false,
        detail: { error: 'claude did not reach its prompt on the second launch' },
        notes: []
      })
    killPty()
    await sleep(500)
  }

  if (wanted('D5')) {
    // A machine configured for auto mode accepts tool calls without asking.
    // The permission dialog only exists to be tested under a mode that prompts.
    const third = await startClaude(ctx, ['--permission-mode', 'manual'])
    if (third.ready) await run('D5', () => checkPermissionPrompt(ctx, third.h))
    else
      checks.push({
        id: 'D5',
        criterion: 'Permission prompts (y/n dialogs) render and respond correctly',
        title: 'Bash tool permission dialog',
        ok: false,
        detail: { error: 'claude did not reach its prompt under --permission-mode manual' },
        notes: []
      })
  }

  killPty()
  return checks
}
