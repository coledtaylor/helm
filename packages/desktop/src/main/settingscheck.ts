import { nativeTheme, type BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, type AppSettings } from '@helm/core'
import { screenshot, sendKey, sleep, typeText } from './bridge'
import type { Check } from './fidelity'
import type { M2Context } from './m2check'
import { answerPicker } from './m7check'

/**
 * The settings pane, driven through the real window.
 *
 * The discipline is the one every check here follows: nothing is believed on
 * Helm's word. Beside every assertion about the UI there is a read this file
 * makes for itself, and for a setting the honest second read is the database -
 * opened here as its **own read-only connection to the file on disk**, not
 * through `services.store`, which is the handle the app just wrote through. A
 * value that has reached the file is a value a restart will find; a value the
 * app is holding in memory is not.
 *
 * Three things cannot be settled by reading a row at all:
 *
 *   Persistence. "It survives a restart" cannot be asserted by the process that
 *   set it - it never restarted. So this driver parks four settings on values
 *   the defaults could not have produced and `scripts/run-settings.mjs` starts
 *   the app again to read them back, exactly the way `usage-check` does.
 *
 *   The side effects. A theme that writes a row and repaints nothing is a
 *   broken setting, so the theme check reads the class on `<html>`, the token
 *   CSS actually resolved, and the colour Electron was handed for the Window
 *   Controls Overlay - captured by wrapping `setTitleBarOverlay` on the window
 *   itself, so it is the argument the platform got rather than Helm's account
 *   of it. Removing a scan root is checked against the *next scan's* project
 *   set, not against the list of roots.
 *
 *   The rejection. "An invalid write does not persist" is exactly the shape of
 *   assertion CLAUDE.md warns about: a probe that can pass because nothing ever
 *   persists proves nothing. So every rejection case is preceded by a valid
 *   write of the same key through the same channel, which must land - if the
 *   control does not persist, the case is discarded rather than passed.
 *
 * `pnpm settings-check` -> helm-data/settings-report.json
 */

const GROUPS = [
  'pane',
  'claude',
  'roots',
  'appearance',
  'accessors',
  'validation',
  'terminal',
  'github'
] as const
type Group = (typeof GROUPS)[number]

/**
 * The built-in font stack, written out again rather than imported from
 * `terminal.ts`.
 *
 * This is the check's own statement of what "the default stack" is, and the
 * whole of M9's font rule is that a user's family goes in *front* of it rather
 * than instead of it. Importing the constant would make the assertion "the code
 * agrees with itself".
 */
const DEFAULT_FONT_STACK = '"Cascadia Mono", "Consolas", monospace'

/** Terminal defaults this driver expects a fresh install to be at. Same reason. */
const DEFAULT_TERMINAL = {
  fontSize: 14,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000
} as const

/**
 * The shells this driver goes looking for itself, and the arguments it expects
 * each to be launched with.
 *
 * Its own table, not `pterm.ts`'s. The bug the per-shell table replaces was a
 * substring test that gave `-NoLogo` to anything whose *path* contained `pwsh`
 * or `powershell`, so a second opinion about which flags belong to which
 * program is the point.
 */
const EXPECTED_SHELL_ARGS: Record<string, string[]> = {
  'pwsh.exe': ['-NoLogo'],
  'powershell.exe': ['-NoLogo'],
  'cmd.exe': [],
  'wsl.exe': [],
  'bash.exe': []
}

/**
 * The shells that must actually stay running once launched.
 *
 * `wsl.exe` is deliberately not among them: it exists on any machine with the
 * optional component installed and exits immediately when no distribution is,
 * which is a fact about this machine rather than about Helm's arguments.
 */
const MUST_SURVIVE = ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash.exe']

/**
 * What the pane paints in a fact it has no value for.
 *
 * Written out again rather than imported from the component: this is the
 * check's own statement of what "nothing to show" looks like, and if the pane
 * starts painting something else the two disagree, which is the point.
 */
const NOTHING = '-'

// ---------------------------------------------------------------------------
// The driver's own reads
// ---------------------------------------------------------------------------

/**
 * One setting, read out of the database file by this driver.
 *
 * A separate connection, opened read-only for the length of one query. Reading
 * through `services.store` would be reading the app's own handle - the same
 * object that just performed the write - and would pass just as happily if
 * nothing had ever been committed.
 *
 * `undefined` means there is no row at all, which is a different fact from a
 * row holding `null` and is why this does not collapse the two.
 */
function rowValue(dbFile: string, key: keyof AppSettings): unknown {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (row === undefined) return undefined
    try {
      return JSON.parse(row.value)
    } catch {
      return { unparseable: row.value }
    }
  } finally {
    db.close()
  }
}

/** Every settings row, the same way. */
function allRows(dbFile: string): Record<string, unknown> {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
      key: string
      value: string
    }>
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        out[row.key] = { unparseable: row.value }
      }
    }
    return out
  } finally {
    db.close()
  }
}

/** What a program says about itself, asked of it directly. */
function versionOf(exe: string): string | null {
  try {
    const isScript = /\.(cmd|bat)$/i.test(exe)
    const out = isScript
      ? execFileSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', exe, '--version'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 20_000
        })
      : execFileSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    return out.trim()
  } catch {
    return null
  }
}

/** `where.exe <name>`, which is what a person would type to find out. */
function whereIs(name: string): string[] {
  try {
    return execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

const whereClaude = (): string[] => whereIs('claude')

/** What Windows says a live process actually is. */
function imageNameOf(pid: number): string | null {
  try {
    const out = execFileSync(
      'tasklist.exe',
      ['/FI', `PID eq ${String(pid)}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 }
    )
    const first = out.split(/\r?\n/).find((line) => line.startsWith('"'))
    return first?.split('","')[0]?.replace(/^"/, '') ?? null
  } catch {
    return null
  }
}

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** `#12131f` -> `rgb(18, 19, 31)`, so a hex and a computed colour can be compared. */
function hexToRgb(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const digits = match?.[1]
  if (digits === undefined) return null
  const channel = (at: number): string => String(Number.parseInt(digits.slice(at, at + 2), 16))
  return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`
}

// ---------------------------------------------------------------------------
// Talking to the window
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  try {
    return (await win.webContents.executeJavaScript(expression, true)) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(`renderer expression failed: ${detail}\n${expression}`, { cause: err })
  }
}

const q = (selector: string): string => JSON.stringify(selector)

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function exists(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(win, `Boolean(document.querySelector(${q(selector)}))`)
}

async function text(win: BrowserWindow, selector: string): Promise<string> {
  return js<string>(win, `(document.querySelector(${q(selector)})?.textContent ?? '').trim()`)
}

async function attr(win: BrowserWindow, selector: string, name: string): Promise<string | null> {
  return js<string | null>(
    win,
    `(document.querySelector(${q(selector)})?.getAttribute(${q(name)}) ?? null)`
  )
}

async function disabled(win: BrowserWindow, selector: string): Promise<boolean | null> {
  return js<boolean | null>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      return el === null ? null : Boolean(el.disabled) })()`
  )
}

/**
 * An expression finding the element whose `data-<name>` is exactly `value`.
 *
 * Not a CSS attribute selector, because the values here are Windows paths and
 * CSS reads a backslash as an escape: in `[data-settings-root="D:\proj\x"]` the
 * `\p` is an identity escape, so the selector matches an element whose
 * attribute reads `D:projx` - and `\a` would be a hex escape rather than a
 * letter at all. Comparing the attribute in JavaScript has no such rules.
 */
const byData = (name: string, value: string): string =>
  `[...document.querySelectorAll('[data-${name}]')].find((el) => el.getAttribute('data-${name}') === ${JSON.stringify(value)})`

async function clickByData(win: BrowserWindow, name: string, value: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = ${byData(name, value)}; if (!el) return false; el.click(); return true })()`
  )
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    if (Date.now() > deadline) return false
    await sleep(200)
  }
}

/**
 * A sidebar row, clicked by the path in its `title`.
 *
 * Matched in JavaScript rather than by a CSS attribute selector for the reason
 * `byData` gives: these are Windows paths, and a backslash in a selector is an
 * escape.
 */
async function clickProject(win: BrowserWindow, path: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('aside button[title]')]
        .find((b) => b.title === ${JSON.stringify(path)});
      if (!el) return false; el.click(); return true })()`
  )
}

/** Focus a field, replace what is in it, and commit with Enter. Real keystrokes. */
async function typeInto(win: BrowserWindow, selector: string, text: string): Promise<boolean> {
  const focused = await js<boolean>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return false; el.focus(); el.select(); return true })()`
  )
  if (!focused) return false
  await typeText(win, text)
  await sendKey(win, 'Return')
  return true
}

/**
 * Set a `<select>` and let React hear about it.
 *
 * Whether the value took is decided **before** the event is dispatched. React
 * flushes a discrete event synchronously, so by the time `dispatchEvent`
 * returns the component has already re-rendered from props that the write has
 * not come back and changed yet - which puts the old value back on the element.
 * Reading it afterwards reports a failure for a selection that worked.
 */
async function chooseOption(
  win: BrowserWindow,
  selector: string,
  value: string
): Promise<{ found: boolean; offered: boolean; set: boolean }> {
  return js<{ found: boolean; offered: boolean; set: boolean }>(
    win,
    `(() => { const el = document.querySelector(${q(selector)});
      if (!el) return { found: false, offered: false, set: false };
      const wanted = ${JSON.stringify(value)};
      const offered = [...el.options].some((o) => o.value === wanted);
      el.value = wanted;
      const set = el.value === wanted;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, offered, set } })()`
  )
}

/**
 * This driver's own answer to "does this machine have that font".
 *
 * Written here rather than shared with the pane, because the pane's hint is one
 * of the things under test. Same principle, different code: a probe string is
 * laid out with the family in front of two fallbacks and again with each
 * fallback alone, and a family that resolves is one that changes a width.
 */
function driverSeesFont(win: BrowserWindow, family: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;left:-9999px;white-space:pre;font-size:72px';
      probe.textContent = 'MWMWiill 0123';
      document.body.appendChild(probe);
      const at = (stack) => { probe.style.fontFamily = stack; return probe.getBoundingClientRect().width };
      const family = ${JSON.stringify(family)};
      const answer = ['monospace', 'serif'].some(
        (f) => at('"' + family + '", ' + f) !== at(f)
      );
      probe.remove();
      return answer })()`
  )
}

/** One live terminal, as the renderer's inspector reports it. */
interface TerminalReport {
  key: string
  fontFamily: string
  fontSize: number
  cursorStyle: string
  cursorBlink: boolean
  scrollback: number
  cols: number
  rows: number
  screen: { width: number; height: number } | null
  attached: boolean
}

interface TerminalSnapshot {
  prefs: Record<string, unknown>
  sessions: TerminalReport[]
  shells: Array<TerminalReport & { path: string; shell: string }>
}

const terminalSnapshot = (win: BrowserWindow): Promise<TerminalSnapshot> =>
  js<TerminalSnapshot>(win, `window.__helmTerminals()`)

/**
 * The driver's own measurement of a monospace cell, made in the window.
 *
 * A canvas of this file's making, with a font string this file composed - so
 * "the terminal is drawing at 20px in Consolas" is checked against a
 * measurement Helm had no part in rather than against Helm's own arithmetic.
 */
function measureCell(win: BrowserWindow, size: number, stack: string): Promise<CellMeasurement> {
  return js<CellMeasurement>(
    win,
    `(() => {
      const size = ${JSON.stringify(size)};
      const stack = ${JSON.stringify(stack)};
      const c = document.createElement('canvas').getContext('2d');
      c.font = size + 'px ' + stack;
      const m = c.measureText('W');
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:pre;'
        + 'font-kerning:none;line-height:normal;font-size:' + size + 'px;font-family:' + stack;
      span.textContent = 'W'.repeat(32);
      document.body.appendChild(span);
      const r = span.getBoundingClientRect();
      span.remove();
      return {
        canvasWidth: m.width,
        canvasBox: m.fontBoundingBoxAscent + m.fontBoundingBoxDescent,
        spanWidth: r.width / 32,
        spanHeight: r.height,
        dpr: window.devicePixelRatio
      } })()`
  )
}

/**
 * A cell measured two ways by this driver.
 *
 * `span*` is how xterm's own `CharSizeService` does it - a `white-space: pre`
 * element in the document, whose width is divided by the number of characters
 * in it - so that is the number the terminal's painted geometry is checked
 * against. The canvas figures are here because `estimateGrid` uses a canvas
 * (there is no terminal to measure yet when it runs), and the difference
 * between the two is the whole reason a pre-spawn estimate can be off.
 */
interface CellMeasurement {
  canvasWidth: number
  canvasBox: number
  spanWidth: number
  spanHeight: number
  dpr: number
}

/** Every project path the sidebar tree is currently showing. */
async function sidebarPaths(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('aside button[title]')].map((b) => b.title)`
  )
}

/**
 * A settings write sent by hand through the real channel.
 *
 * The same route the pane's own controls take - preload, contract, handler -
 * so a rejection here is the rejection a caller would actually get. Resolved
 * either way: whether it was refused is the thing being measured.
 */
async function sendWrite(
  win: BrowserWindow,
  patch: Record<string, unknown>
): Promise<{ accepted: boolean; error: string }> {
  return js<{ accepted: boolean; error: string }>(
    win,
    `window.helm.invoke('settings:write', ${JSON.stringify(patch)})
       .then(() => ({ accepted: true, error: '' }))
       .catch((err) => ({ accepted: false, error: String(err && err.message ? err.message : err) }))`
  )
}

/** Opens the settings pane if it is not already the pane on screen. */
async function openSettings(win: BrowserWindow): Promise<boolean> {
  if (await exists(win, '[data-settings-pane]')) return true
  await click(win, '[data-open-settings]')
  return pollJs(win, `document.querySelector('[data-settings-pane]')`, 10_000)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  dir: string
  /** A scan root with one project under it. Added, and left for phase two. */
  rootA: string
  /** A scan root with two projects under it. Added, then removed. */
  rootB: string
  aProjects: string[]
  bProjects: string[]
  /** A program that answers `--version` with 9.9.9 and nothing else. */
  stubCli: string
  /**
   * A `gh` that is installed and not signed in: it answers `--version` and
   * fails `auth status` the way the real one does when there is no token.
   * Which is how the "run gh auth login" sentence is provoked on a machine
   * where gh *is* signed in.
   */
  ghStub: string
  /** A scan root for the terminal group, with two projects to open shells in. */
  termRoot: string
  termProjects: string[]
}

function buildFixtures(dataDir: string): Fixtures {
  const dir = join(dataDir, 'settings-fixtures')
  rmSync(dir, { recursive: true, force: true })

  const rootA = join(dir, 'root a')
  const rootB = join(dir, 'root-b')
  const termRoot = join(dir, 'root-term')
  const aProjects = [join(rootA, 'alpha one')]
  const bProjects = [join(rootB, 'beta-one'), join(rootB, 'beta-two')]
  const termProjects = [join(termRoot, 'term one'), join(termRoot, 'term-two')]
  // A path with a space in it on purpose: Windows-first, and every path Helm
  // stores has to survive one.
  for (const path of [...aProjects, ...bProjects, ...termProjects]) {
    mkdirSync(join(path, '.claude'), { recursive: true })
  }

  const stubDir = join(dir, 'stub')
  mkdirSync(stubDir, { recursive: true })
  const stubCli = join(stubDir, 'claude.cmd')
  writeFileSync(stubCli, '@echo off\r\nif "%1"=="--version" echo 9.9.9 (Claude Code)\r\n')

  const ghStub = join(stubDir, 'gh.cmd')
  writeFileSync(
    ghStub,
    [
      '@echo off',
      'if "%1"=="--version" (',
      '  echo gh version 9.9.9 ^(fixture^)',
      '  echo https://github.com/cli/cli',
      '  exit /b 0',
      ')',
      'if "%1"=="auth" (',
      '  echo You are not logged into any GitHub hosts. 1>&2',
      '  exit /b 1',
      ')',
      'echo gh: not signed in 1>&2',
      'exit /b 1',
      ''
    ].join('\r\n')
  )

  return { dir, rootA, rootB, aProjects, bProjects, stubCli, ghStub, termRoot, termProjects }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface SettingsCheckResult {
  checks: Check[]
  /** What the run left in the database for the restart phase to find. */
  parked: Partial<AppSettings>
}

export async function runSettingsChecks(
  ctx: M2Context,
  shotDir: string,
  dataDir: string,
  only?: readonly string[]
): Promise<SettingsCheckResult> {
  const wanted = new Set<string>(only && only.length > 0 ? only : GROUPS)
  const run = (group: Group): boolean => wanted.has(group)
  const checks: Check[] = []
  const { win, services, usage } = ctx
  const dbFile = services.store.file

  const fixtures = buildFixtures(dataDir)

  /**
   * Everything as it was before this driver touched it, written down before
   * anything is changed. The restart phase puts these back: this runs against
   * the real database, because the claim under test is about the real one.
   */
  const asFound = readSettings(services.store)
  /**
   * Anything of this driver's own is scrubbed out of what gets restored: a run
   * that was killed before its restore leaves a fixture root or a stub CLI
   * behind, and carrying those forward would let them accumulate one per run.
   * What is put back is the user's settings, not the last run's leftovers.
   */
  const mine = (path: string | null): boolean =>
    path !== null && path.toLowerCase().startsWith(fixtures.dir.toLowerCase())
  const original: AppSettings = {
    ...asFound,
    scanRoots: asFound.scanRoots.filter((root) => !mine(root)),
    claudePath: mine(asFound.claudePath) ? null : asFound.claudePath
  }
  writeFileSync(join(dataDir, 'settings-original.json'), JSON.stringify(original, null, 2))

  /**
   * The executable to park in `claudePath`, decided now.
   *
   * Now, because the validation group writes a stub into that setting on its
   * way past, and anything asked afterwards - `findClaudeExecutable` included -
   * would answer with the stub. `where.exe` first: parking a real program means
   * a restore that somehow does not happen leaves the app working.
   */
  const claudeForPark = whereClaude()[0] ?? original.claudePath

  /**
   * The colour Electron was handed for the window controls, captured at the
   * source. Wrapping the method on the instance means what is recorded is the
   * argument the platform received - not a value read back out of Helm.
   */
  const overlayCalls: Array<{ color: string; symbolColor: string }> = []
  const realSetOverlay = win.setTitleBarOverlay.bind(win)
  win.setTitleBarOverlay = (options: Electron.TitleBarOverlay): void => {
    overlayCalls.push({
      color: String(options.color ?? ''),
      symbolColor: String(options.symbolColor ?? '')
    })
    realSetOverlay(options)
  }

  await sleep(800)

  // -------------------------------------------------------------------------
  // S-1: the gear opens it, every group renders, Ctrl+Tab reaches it
  // -------------------------------------------------------------------------
  if (run('pane')) {
    const gearThere = await exists(win, '[data-open-settings]')
    const paneBefore = await exists(win, '[data-settings-pane]')

    await click(win, '[data-open-settings]')
    const opened = await pollJs(win, `document.querySelector('[data-settings-pane]')`, 10_000)
    await sleep(400)

    const groups = await js<string[]>(
      win,
      `[...document.querySelectorAll('[data-settings-group]')].map((el) => el.dataset.settingsGroup)`
    )
    const tabSelected = await attr(win, '[role="tab"][data-tab="settings"]', 'aria-selected')
    const controls = await js<Record<string, boolean>>(
      win,
      `({
         claudePath: Boolean(document.querySelector('[data-settings-claude-path]')),
         locate: Boolean(document.querySelector('[data-settings-locate]')),
         clear: Boolean(document.querySelector('[data-settings-clear-claude]')),
         addRoot: Boolean(document.querySelector('[data-settings-add-root]')),
         theme: Boolean(document.querySelector('[data-settings-theme]')),
         usage: Boolean(document.querySelector('[data-settings-usage]')),
         terminalFont: Boolean(document.querySelector('[data-settings-terminal-font]')),
         terminalSize: Boolean(document.querySelector('[data-settings-terminal-size]')),
         terminalCursor: Boolean(document.querySelector('[data-settings-terminal-cursor]')),
         terminalBlink: Boolean(document.querySelector('[data-settings-terminal-blink]')),
         terminalScrollback: Boolean(document.querySelector('[data-settings-terminal-scrollback]')),
         terminalShell: Boolean(document.querySelector('[data-settings-terminal-shell]')),
         terminalPreview: Boolean(document.querySelector('[data-settings-terminal-preview]')),
         ghPath: Boolean(document.querySelector('[data-settings-gh-path]')),
         ghLocate: Boolean(document.querySelector('[data-settings-gh-locate]')),
         ghClear: Boolean(document.querySelector('[data-settings-clear-gh]')),
         prPoll: Boolean(document.querySelector('[data-settings-pr-poll]')),
         prPrompt: Boolean(document.querySelector('[data-settings-pr-prompt]')),
         prPromptReset: Boolean(document.querySelector('[data-settings-pr-prompt-reset]')),
         prCheckout: Boolean(document.querySelector('[data-settings-pr-checkout]'))
       })`
    )
    // Internal state is not a preference, and the pane must not have grown a
    // row for either while nobody was looking.
    const internalLeaked = await js<boolean>(
      win,
      `/windowBounds|firstRunCompletedAt/.test(document.querySelector('[data-settings-pane]')?.textContent ?? '')`
    )

    const shot = await screenshot(win, shotDir, 'settings-1-pane.png')

    // A second workspace tab, so the ring has something to cycle between.
    await click(win, '[data-open-history]')
    const historyUp = await pollJs(
      win,
      `document.querySelector('[role="tab"][data-tab="history"][aria-selected="true"]')`,
      10_000
    )
    // Ctrl+Tab is bound on the window in capture, so this is the real keystroke
    // rather than a click on a tab.
    await sendKey(win, 'Tab', ['control'])
    const cycledBack = await pollJs(
      win,
      `document.querySelector('[role="tab"][data-tab="settings"][aria-selected="true"]')`,
      5_000
    )
    const paneAfterCycle = await exists(win, '[data-settings-pane]')

    checks.push({
      id: 'S-1',
      criterion: 'Gear in the title bar opens the Settings tab; every group renders',
      title: 'The gear opens a Settings pane with all five groups, and Ctrl+Tab cycles to it',
      ok:
        gearThere &&
        !paneBefore &&
        opened &&
        tabSelected === 'true' &&
        groups.join(',') === 'claude,workspace,appearance,terminal,github' &&
        Object.values(controls).every(Boolean) &&
        !internalLeaked &&
        historyUp &&
        cycledBack &&
        paneAfterCycle,
      detail: {
        gearInTitleBar: gearThere,
        paneBeforeClick: paneBefore,
        groups,
        tabSelected,
        controlsPresent: controls,
        internalKeysOnScreen: internalLeaked,
        secondTabOpened: historyUp,
        ctrlTabReturnedToSettings: cycledBack,
        screenshot: shot.file
      },
      notes: [
        'The pane does not exist in the DOM until the gear is clicked, so its',
        'absence beforehand is what makes the click evidence of anything.',
        'Ctrl+Tab is sent as a real keystroke through Chromium, not simulated by',
        'clicking the tab: the handler is bound in capture on the window.',
        '`windowBounds` and `firstRunCompletedAt` are state rather than',
        'preferences, and the pane is checked for not having grown a row for them.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-2: the CLI is viewable, settable and clearable after first run
  // -------------------------------------------------------------------------
  if (run('claude')) {
    await openSettings(win)
    await sleep(300)

    /**
     * Start from "no override", whatever the database happened to hold.
     *
     * This runs against the real profile, and a previous run of this driver
     * parks one on purpose - so clearing first is what makes the rest of the
     * group mean the same thing on every run. It is also the button under test,
     * exercised from the state a user who has picked an executable is in.
     */
    const overrideAtStart = rowValue(dbFile, 'claudePath')
    if (overrideAtStart !== null && overrideAtStart !== undefined) {
      await click(win, '[data-settings-clear-claude]')
      await pollJs(
        win,
        `window.helm.invoke('setup:status').then((s) => s.source === 'discovered')`,
        20_000
      )
      await sleep(600)
    }

    // What the pane says, and what the executable says when asked directly.
    const paintedPath = await text(win, '[data-settings-claude-path]')
    const paintedVersion = await text(win, '[data-settings-claude-version]')
    const onPath = whereClaude()
    const directVersion = paintedPath === NOTHING ? null : versionOf(paintedPath)
    // `where.exe` is the answer a person would get by typing it, and Helm's
    // discovery is supposed to arrive at the same executable.
    const agreesWithPath =
      onPath.length === 0 ||
      onPath.some((entry) => entry.toLowerCase() === paintedPath.toLowerCase())
    const clearDisabledBefore = await disabled(win, '[data-settings-clear-claude]')

    // Pick a stub by hand, through the same handler the picker calls.
    answerPicker('file', fixtures.stubCli)
    await click(win, '[data-settings-locate]')
    const overrideShown = await pollJs(
      win,
      `(document.querySelector('[data-settings-claude-path]')?.textContent ?? '')
        .includes(${JSON.stringify('claude.cmd')})`,
      20_000
    )
    await sleep(500)

    const overriddenPath = await text(win, '[data-settings-claude-path]')
    const overriddenVersion = await text(win, '[data-settings-claude-version]')
    const stubSays = versionOf(fixtures.stubCli)
    const rowAfterPick = rowValue(dbFile, 'claudePath')
    const clearDisabledAfter = await disabled(win, '[data-settings-clear-claude]')
    // The override has to reach `setup:status`, which is where every other
    // surface asks what the CLI is.
    const statusAfterPick = await js<{ path: string | null; source: string | null }>(
      win,
      `window.helm.invoke('setup:status')`
    )
    const shot = await screenshot(win, shotDir, 'settings-2-claude-override.png')

    await click(win, '[data-settings-clear-claude]')
    const cleared = await pollJs(
      win,
      `!(document.querySelector('[data-settings-claude-path]')?.textContent ?? '')
        .includes(${JSON.stringify('claude.cmd')})`,
      20_000
    )
    await sleep(500)
    const rowAfterClear = rowValue(dbFile, 'claudePath')
    const restoredPath = await text(win, '[data-settings-claude-path]')
    const statusAfterClear = await js<{ path: string | null; source: string | null }>(
      win,
      `window.helm.invoke('setup:status')`
    )

    checks.push({
      id: 'S-2',
      criterion: 'The Claude CLI override is viewable, settable and clearable after first run',
      title: 'The pane shows what the CLI actually is, takes an override, and gives it back',
      ok:
        paintedPath !== '' &&
        paintedPath !== NOTHING &&
        directVersion !== null &&
        paintedVersion === directVersion &&
        agreesWithPath &&
        clearDisabledBefore === true &&
        overrideShown &&
        overriddenPath === fixtures.stubCli &&
        stubSays !== null &&
        overriddenVersion === stubSays &&
        rowAfterPick === fixtures.stubCli &&
        clearDisabledAfter === false &&
        statusAfterPick.path === fixtures.stubCli &&
        statusAfterPick.source === 'setting' &&
        cleared &&
        rowAfterClear === null &&
        restoredPath === paintedPath &&
        statusAfterClear.source === 'discovered',
      detail: {
        overrideFoundAtStart: overrideAtStart ?? null,
        painted: { path: paintedPath, version: paintedVersion },
        askedTheExecutableDirectly: directVersion,
        whereExeSays: onPath,
        paintedPathIsTheOneOnPath: agreesWithPath,
        clearDisabledWithNoOverride: clearDisabledBefore,
        afterPicking: {
          painted: { path: overriddenPath, version: overriddenVersion },
          stubSaysDirectly: stubSays,
          databaseRow: rowAfterPick,
          setupStatus: statusAfterPick,
          clearEnabled: clearDisabledAfter === false
        },
        afterClearing: {
          databaseRow: rowAfterClear,
          painted: restoredPath,
          setupStatus: statusAfterClear
        },
        screenshot: shot.file
      },
      notes: [
        'The version on screen is compared with what the executable answers when',
        'this driver runs it, and the path against `where.exe claude` - Helm is',
        'not asked twice.',
        'Any override already in the database is cleared first, because this runs',
        'against the real profile and a previous run parks one on purpose.',
        'The override is a real program on disk answering 9.9.9, picked through',
        'the same `setup:locateClaude` handler the picker calls, and the value is',
        'read back out of the database file rather than out of the app.',
        'This is the gap the pane closes: before it, `claudePath` was reachable',
        'only during first run, so a wrong pick was permanent.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-3: scan roots can be added and removed - `roots:remove` gets its caller
  // -------------------------------------------------------------------------
  if (run('roots')) {
    await openSettings(win)
    await sleep(300)

    const rootsBefore = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsBefore = await sidebarPaths(win)

    for (const root of [fixtures.rootA, fixtures.rootB]) {
      answerPicker('directory', root)
      await click(win, '[data-settings-add-root]')
      await pollJs(win, byData('settings-root', root), 20_000)
    }
    // The scan the addition kicked off has to land before the tree means
    // anything.
    await pollJs(
      win,
      `[...document.querySelectorAll('aside button[title]')]
        .filter((b) => b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.rootB.toLowerCase()
        )})).length === 2`,
      45_000
    )
    await sleep(600)

    const rootsAfterAdd = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsAfterAdd = await sidebarPaths(win)
    const bShownBefore = projectsAfterAdd.filter((path) =>
      path.toLowerCase().startsWith(fixtures.rootB.toLowerCase())
    )
    const shot = await screenshot(win, shotDir, 'settings-3-roots.png')

    // Remove one, through the row's own button.
    const removed = await clickByData(win, 'settings-remove-root', fixtures.rootB)
    const rowGone = await pollJs(win, `!${byData('settings-root', fixtures.rootB)}`, 15_000)
    const treeShrank = await pollJs(
      win,
      `[...document.querySelectorAll('aside button[title]')]
        .every((b) => !b.title.toLowerCase().startsWith(${JSON.stringify(
          fixtures.rootB.toLowerCase()
        )}))`,
      45_000
    )
    await sleep(600)

    const rootsAfterRemove = rowValue(dbFile, 'scanRoots') as string[] | undefined
    const projectsAfterRemove = await sidebarPaths(win)
    const aStillShown = projectsAfterRemove.filter((path) =>
      path.toLowerCase().startsWith(fixtures.rootA.toLowerCase())
    )

    const lower = (list: string[] | undefined): string[] =>
      (list ?? []).map((entry) => entry.toLowerCase())

    checks.push({
      id: 'S-3',
      criterion: 'Scan roots can be added AND removed from the pane',
      title: 'Two roots added, one removed, and the next scan lost exactly its projects',
      ok:
        lower(rootsAfterAdd).includes(fixtures.rootA.toLowerCase()) &&
        lower(rootsAfterAdd).includes(fixtures.rootB.toLowerCase()) &&
        // The fixture has to be discriminating: unless the removed root was
        // actually contributing projects, losing them proves nothing.
        bShownBefore.length === fixtures.bProjects.length &&
        removed &&
        rowGone &&
        treeShrank &&
        !lower(rootsAfterRemove).includes(fixtures.rootB.toLowerCase()) &&
        lower(rootsAfterRemove).includes(fixtures.rootA.toLowerCase()) &&
        aStillShown.length === fixtures.aProjects.length &&
        projectsAfterRemove.length === projectsAfterAdd.length - fixtures.bProjects.length,
      detail: {
        rootsBefore,
        rootsAfterAdd,
        rootsAfterRemove,
        fixtureProjects: { rootA: fixtures.aProjects, rootB: fixtures.bProjects },
        sidebarProjectCounts: {
          before: projectsBefore.length,
          afterAdd: projectsAfterAdd.length,
          afterRemove: projectsAfterRemove.length
        },
        removedRootsProjectsWhileScanned: bShownBefore,
        keptRootsProjectsAfterwards: aStillShown,
        screenshot: shot.file
      },
      notes: [
        'The `roots:remove` channel has had a handler since M7 and no caller at',
        'all. This is the caller, and the row is read out of the database file.',
        'Removal is checked against the next scan rather than against the list of',
        'roots: the setting exists to change what Helm looks at, so the tree',
        'losing exactly the removed roots two projects is the thing worth proving.',
        'The fixture is asserted to have been contributing those projects first.',
        'Both fixture roots contain a path with a space in it - Windows-first.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-4: theme, and the repaint it has to cause
  // -------------------------------------------------------------------------
  if (run('appearance')) {
    await openSettings(win)
    await sleep(300)

    const observed: Array<Record<string, unknown>> = []
    let everyThemeApplied = true

    for (const theme of ['dark', 'light'] as const) {
      overlayCalls.length = 0
      const label = theme === 'dark' ? 'Dark theme' : 'Light theme'
      const clicked = await click(
        win,
        `[data-settings-theme] button[aria-label=${q(label)}]`
      )
      await pollJs(
        win,
        `document.documentElement.classList.contains('dark') === ${String(theme === 'dark')}`,
        10_000
      )
      await sleep(700)

      const painted = await js<{ dark: boolean; canvas: string; scheme: string; checked: string }>(
        win,
        `(() => {
           const style = getComputedStyle(document.documentElement);
           const chosen = document.querySelector('[data-settings-theme] button[aria-checked="true"]');
           return {
             dark: document.documentElement.classList.contains('dark'),
             canvas: style.getPropertyValue('--helm-bg').trim(),
             scheme: document.documentElement.style.colorScheme,
             checked: chosen ? chosen.getAttribute('aria-label') : ''
           } })()`
      )
      const row = rowValue(dbFile, 'theme')
      const overlay = overlayCalls.at(-1) ?? null
      // The colour the platform was handed has to be the canvas the page is
      // actually painting - two sources, compared as one value.
      const overlayMatchesCanvas =
        overlay !== null &&
        painted.canvas !== '' &&
        overlay.color.toLowerCase() === painted.canvas.toLowerCase()

      const ok =
        clicked &&
        painted.dark === (theme === 'dark') &&
        painted.scheme === theme &&
        painted.checked === label &&
        row === theme &&
        nativeTheme.themeSource === theme &&
        overlayMatchesCanvas
      if (!ok) everyThemeApplied = false

      observed.push({
        theme,
        clicked,
        htmlHasDarkClass: painted.dark,
        colorScheme: painted.scheme,
        canvasTokenCssResolved: painted.canvas,
        canvasAsRgb: hexToRgb(painted.canvas),
        overlayHandedToElectron: overlay,
        overlayMatchesCanvas,
        databaseRow: row,
        nativeThemeSource: nativeTheme.themeSource,
        paneShowsChecked: painted.checked,
        ok
      })
      await screenshot(win, shotDir, `settings-4-theme-${theme}.png`)
    }

    checks.push({
      id: 'S-4',
      criterion: 'Theme is settable from the pane, and the choice takes effect',
      title: 'Both themes flip the document class, repaint the window controls, and write the row',
      ok: everyThemeApplied,
      detail: { observed },
      notes: [
        'Three independent witnesses per theme: the class Chromium has on',
        '<html>, the colour Electron was handed for the Window Controls Overlay',
        '- captured by wrapping `setTitleBarOverlay` on the window itself - and',
        'the row in the database file.',
        'The overlay colour is compared against the `--helm-bg` token as the',
        'stylesheet resolved it, so "the buttons match the canvas" is measured',
        'rather than assumed from a table in the source.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-5: usage display, including the mode that may not be offered yet
  // -------------------------------------------------------------------------
  if (run('appearance')) {
    // Which modes may be offered is a function of whether the index has an
    // estimate, so drive it to completion first rather than racing it.
    let passes = 0
    let indexed
    do {
      indexed = usage.index.pass()
      passes++
    } while (!indexed.caughtUp && passes < 200)
    const snapshot = usage.refresh()
    await sleep(700)
    await openSettings(win)
    await sleep(300)

    const hasEstimate = snapshot.spend != null
    const costDisabled = await disabled(win, '[data-settings-usage="cost"]')
    const costTitle = await attr(win, '[data-settings-usage="cost"]', 'title')

    const walked: Array<Record<string, unknown>> = []
    const modes = hasEstimate ? (['off', 'cost', 'percent'] as const) : (['off', 'percent'] as const)
    let everyModeApplied = true

    for (const mode of modes) {
      await click(win, `[data-settings-usage=${q(mode)}]`)
      const reached = await pollJs(
        win,
        `document.querySelector('[data-usage-segment]')?.dataset.usageSegment === ${q(mode)}`,
        10_000
      )
      await sleep(400)
      const row = rowValue(dbFile, 'usageDisplay')
      const segmentText = await text(win, '[data-usage-segment]')
      const checked = await attr(win, `[data-settings-usage=${q(mode)}]`, 'aria-checked')
      const ok = reached && row === mode && checked === 'true'
      if (!ok) everyModeApplied = false
      walked.push({ mode, statusBarFollowed: reached, databaseRow: row, segmentText, checked, ok })
    }

    await screenshot(win, shotDir, 'settings-5-usage.png')

    checks.push({
      id: 'S-5',
      criterion: 'Usage display is settable from the pane, honouring the offerable rule',
      title: 'Each offered mode reaches the status bar and the database; cost is offered only when it can be filled',
      ok:
        everyModeApplied &&
        costDisabled === !hasEstimate &&
        (hasEstimate || (costTitle ?? '').includes('index has caught up')),
      detail: {
        indexPasses: passes,
        indexHasEstimate: hasEstimate,
        costSegmentDisabled: costDisabled,
        costSegmentTitle: costTitle,
        walked
      },
      notes: [
        'The status bar is the side effect: each mode is confirmed on the segment',
        'a person actually looks at, not only in the row.',
        '`cost` is greyed out with the reason in its title until the transcript',
        'index has an estimate - the same rule the segment cycles by, from the',
        'same function, so the two cannot drift apart.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-6: the quick accessors still work, and the pane follows them
  // -------------------------------------------------------------------------
  if (run('accessors')) {
    await openSettings(win)
    await sleep(300)

    // The title bar's toggle - the one outside the pane.
    const before = await attr(win, '[data-settings-theme]', 'data-settings-theme')
    const target = before === 'dark' ? 'Light theme' : 'Dark theme'
    const targetTheme = target === 'Dark theme' ? 'dark' : 'light'
    const clickedToggle = await click(
      win,
      `.app-drag [role="radiogroup"][aria-label="Theme"] button[aria-label=${q(target)}]`
    )
    const paneFollowedTheme = await pollJs(
      win,
      `document.querySelector('[data-settings-theme]')?.dataset.settingsTheme === ${q(targetTheme)}`,
      10_000
    )
    await sleep(400)
    const themeRow = rowValue(dbFile, 'theme')

    // The status bar's segment - a click cycles it, and the pane has to agree
    // with wherever it landed.
    const usageBefore = await attr(win, '[data-usage-segment]', 'data-usage-segment')
    const clickedSegment = await click(win, '[data-usage-segment]')
    await sleep(700)
    const usageAfter = await attr(win, '[data-usage-segment]', 'data-usage-segment')
    const paneUsage = await attr(win, '[data-settings-usage][aria-checked="true"]', 'data-settings-usage')
    const usageRow = rowValue(dbFile, 'usageDisplay')

    checks.push({
      id: 'S-6',
      criterion: 'The existing quick accessors keep working and stay in sync with the pane',
      title: 'The title bar toggle and the status bar segment write through, and the pane follows both',
      ok:
        clickedToggle &&
        paneFollowedTheme &&
        themeRow === targetTheme &&
        clickedSegment &&
        usageAfter !== null &&
        usageAfter !== usageBefore &&
        paneUsage === usageAfter &&
        usageRow === usageAfter,
      detail: {
        theme: { before, clicked: target, paneFollowed: paneFollowedTheme, databaseRow: themeRow },
        usage: {
          segmentBefore: usageBefore,
          segmentAfter: usageAfter,
          paneShows: paneUsage,
          databaseRow: usageRow
        }
      },
      notes: [
        'Both accessors are clicked where they live - the title bar strip and the',
        'status bar - with the settings pane open behind them, so "stays in sync"',
        'is observed rather than inferred from both writing the same channel.',
        'The segment is cycled rather than set, which is also what proves the',
        'cycle still exists now that the setting has a home.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-7: runtime validation rejects malformed values for every key
  // -------------------------------------------------------------------------
  if (run('validation')) {
    const now = readSettings(services.store)
    const cases: Array<{
      key: keyof AppSettings
      good: unknown
      bad: unknown
      why: string
    }> = [
      { key: 'theme', good: 'light', bad: 'purple', why: 'not one of the three preferences' },
      { key: 'usageDisplay', good: 'off', bad: 'dollars', why: 'not one of the three modes' },
      {
        key: 'scanRoots',
        good: [fixtures.rootA],
        bad: ['projects/alpha'],
        why: 'a relative path resolves against whatever the cwd happens to be'
      },
      {
        key: 'claudePath',
        good: fixtures.stubCli,
        bad: 'claude',
        why: 'a bare name is not an executable Helm can hand to a pty'
      },
      {
        key: 'windowBounds',
        good: now.windowBounds ?? { width: 1280, height: 820 },
        bad: { width: 'wide', height: 820 },
        why: 'a width that is not a number reaches BrowserWindow'
      },
      {
        key: 'firstRunCompletedAt',
        good: '2026-08-11T00:00:00.000Z',
        bad: 'soon',
        why: 'not a timestamp anything can order'
      },
      {
        key: 'terminalFontFamily',
        good: 'Consolas',
        bad: 'Consolas; color: red',
        why: 'xterm puts this in an inline style, where a semicolon ends the declaration'
      },
      {
        key: 'terminalFontSize',
        good: 16,
        bad: 200,
        why: 'a grid two columns wide is not a terminal any TUI can lay out in'
      },
      {
        key: 'terminalCursorStyle',
        good: 'bar',
        bad: 'beam',
        why: 'not one of the three shapes xterm draws'
      },
      {
        key: 'terminalCursorBlink',
        good: false,
        bad: 'false',
        why: 'the string is truthy, so it would switch blinking on'
      },
      {
        key: 'terminalScrollback',
        good: 5000,
        bad: 5_000_000,
        why: 'a line is about a kilobyte of cell data, per pane'
      },
      {
        key: 'terminalShell',
        good: now.terminalShell ?? whereIs('cmd.exe')[0] ?? null,
        bad: 'cmd.exe',
        why: 'a bare name is resolved against whatever PATH Helm was started with'
      },
      {
        key: 'ghPath',
        good: whereIs('gh.exe')[0] ?? fixtures.stubCli,
        bad: 'gh',
        why: 'a bare name is not an executable Helm can run for a fetch'
      },
      {
        key: 'prPollMinutes',
        good: 15,
        bad: 1,
        why: 'a one-minute sweep is one gh per remote against the user’s own rate limit'
      },
      {
        key: 'prReviewPrompt',
        good: '/code-review {number}',
        bad: '   ',
        why: 'an empty template makes the review button start an ordinary session'
      },
      {
        key: 'prCheckout',
        good: 'none',
        bad: 'worktree',
        why: 'a mode that is planned and not built would silently do nothing'
      }
    ]

    // A key with no case here is a key nothing proves is validated, and the
    // table is hand-written, so it is checked against the settings object
    // itself rather than trusted to have kept up.
    const covered = cases.map((entry) => entry.key).sort()
    const everyKey = Object.keys(now).sort()
    const everyKeyCovered = covered.join(',') === everyKey.join(',')

    const results: Array<Record<string, unknown>> = []
    let allRejected = true
    let allControlsLanded = true

    for (const testCase of cases) {
      // The control first. Without it, "the row did not change" is also what a
      // channel that writes nothing at all would report.
      const control = await sendWrite(win, { [testCase.key]: testCase.good })
      await sleep(250)
      const afterGood = rowValue(dbFile, testCase.key)
      const controlLanded =
        control.accepted && JSON.stringify(afterGood) === JSON.stringify(testCase.good)
      if (!controlLanded) allControlsLanded = false

      const attempt = await sendWrite(win, { [testCase.key]: testCase.bad })
      await sleep(250)
      const afterBad = rowValue(dbFile, testCase.key)
      const rejected =
        !attempt.accepted &&
        attempt.error.includes(testCase.key) &&
        JSON.stringify(afterBad) === JSON.stringify(testCase.good)
      if (!rejected) allRejected = false

      results.push({
        key: testCase.key,
        why: testCase.why,
        control: { wrote: testCase.good, accepted: control.accepted, rowAfter: afterGood, landed: controlLanded },
        rejection: {
          wrote: testCase.bad,
          accepted: attempt.accepted,
          error: attempt.error.replace(/^Error: /, '').slice(0, 200),
          rowAfter: afterBad,
          rejected
        }
      })
    }

    // A patch is one edit: a good key travelling with a bad one lands neither.
    await sendWrite(win, { theme: 'dark' })
    await sleep(250)
    const mixed = await sendWrite(win, { theme: 'light', usageDisplay: 'dollars' })
    await sleep(250)
    const themeAfterMixed = rowValue(dbFile, 'theme')
    const partial = mixed.accepted || themeAfterMixed !== 'dark'

    // And the tolerance the file header promises is still there: a key this
    // build does not know is ignored, not rejected.
    const unknownKey = await sendWrite(win, { theme: 'light', somethingLater: 'whatever' })
    await sleep(250)
    const themeAfterUnknown = rowValue(dbFile, 'theme')
    const unknownStored = allRows(dbFile)['somethingLater']

    checks.push({
      id: 'S-7',
      criterion: 'Runtime validation rejects malformed values for every key; unknown keys still tolerated',
      title: 'A hand-sent bad write for every key is refused and changes nothing; every good one lands',
      ok:
        everyKeyCovered &&
        allControlsLanded &&
        allRejected &&
        !partial &&
        unknownKey.accepted &&
        themeAfterUnknown === 'light' &&
        unknownStored === undefined,
      detail: {
        keysProbed: covered,
        keysInAppSettings: everyKey,
        everyKeyCovered,
        cases: results,
        patchIsOneEdit: {
          wrote: { theme: 'light', usageDisplay: 'dollars' },
          accepted: mixed.accepted,
          themeAfter: themeAfterMixed,
          expectedThemeAfter: 'dark',
          partiallyApplied: partial
        },
        unknownKeyTolerated: {
          accepted: unknownKey.accepted,
          themeAfter: themeAfterUnknown,
          storedUnknownRow: unknownStored ?? null
        }
      },
      notes: [
        'Every write is sent from the renderer through the real `settings:write`',
        'channel, so what is measured is what a caller would actually get.',
        'Each key is probed twice, valid first: a rejection test whose valid case',
        'never lands cannot tell a working validator from a channel that writes',
        'nothing - the same trap M3-4 fell into.',
        'Reads are tolerant and writes are strict on purpose. A row from another',
        'build is a fact about the past; a malformed write is a bug happening now,',
        'and before this it reached `nativeTheme.themeSource`.',
        'The table of cases is checked against the keys of `AppSettings` itself,',
        'so a setting added later cannot quietly go unprobed.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // S-10 to S-12: the terminal settings (M9)
  // -------------------------------------------------------------------------
  if (run('terminal')) {
    /**
     * Every resize the main process actually put through to a pty, captured at
     * the source by wrapping the host objects the IPC handlers call.
     *
     * This is the second half of "the pane refit": a terminal whose options
     * changed but whose grid was never re-reported leaves the child process
     * drawing into a box that no longer exists. `applyFit` reports only when
     * the answer changed, and that is exactly what these counts measure.
     */
    const sessionResizes: Array<{ id: number; cols: number; rows: number }> = []
    const shellResizes: Array<{ id: number; cols: number; rows: number }> = []
    const realSessionResize = ctx.sessions.resize.bind(ctx.sessions)
    const realShellResize = ctx.pterm.resize.bind(ctx.pterm)
    ctx.sessions.resize = (id, cols, rows) => {
      sessionResizes.push({ id, cols, rows })
      realSessionResize(id, cols, rows)
    }
    ctx.pterm.resize = (id, cols, rows) => {
      shellResizes.push({ id, cols, rows })
      realShellResize(id, cols, rows)
    }

    try {
      // --- setup: a project pane with a shell, and a session beside it -------
      //
      // The CLI setting goes back to the real executable first. The validation
      // group leaves `claudePath` on a stub that answers `--version` and exits,
      // and a session launched from that is a process which is gone before
      // anything can look at it - which would make this group's failures a
      // report about the group that ran before it.
      await sendWrite(win, { claudePath: claudeForPark })
      // And the terminal settings start from their documented defaults, for the
      // same reason: the validation group parks each of them on a value of its
      // own choosing on the way past, so without this the deltas below would be
      // measured from wherever that left them.
      await sendWrite(win, {
        terminalFontFamily: null,
        terminalFontSize: DEFAULT_TERMINAL.fontSize,
        terminalCursorStyle: DEFAULT_TERMINAL.cursorStyle,
        terminalCursorBlink: DEFAULT_TERMINAL.cursorBlink,
        terminalScrollback: DEFAULT_TERMINAL.scrollback,
        terminalShell: null
      })
      await sleep(600)

      await js<unknown>(
        win,
        `window.helm.invoke('roots:accept', { path: ${JSON.stringify(fixtures.termRoot)} })`
      )
      await js<unknown>(win, `window.helm.invoke('discovery:scan', { includeGit: false })`)
      const treeHasFixtures = await pollJs(
        win,
        `[...document.querySelectorAll('aside button[title]')]
          .filter((b) => b.title.toLowerCase().startsWith(${JSON.stringify(
            fixtures.termRoot.toLowerCase()
          )})).length === 2`,
        45_000
      )

      const projectOne = fixtures.termProjects[0] ?? ''
      await clickProject(win, projectOne)
      const shellUp = await pollJs(
        win,
        `window.__helmTerminals().shells.length > 0
         && document.querySelector('[data-shell-running]')?.dataset.shellRunning`,
        45_000
      )
      await sleep(1200)
      const shellNameInHeader = await attr(win, '[data-shell-running]', 'data-shell-running')

      // A real session, launched from the pane's own button. The process behind
      // it is irrelevant to every claim below - what is needed is a terminal in
      // the *other* registry, which only a session produces.
      const launched = await js<boolean>(
        win,
        `(() => { const el = [...document.querySelectorAll('button')]
            .find((b) => (b.textContent ?? '').includes('Start session here'));
          if (!el) return false; el.click(); return true })()`
      )
      const sessionUp = await pollJs(win, `window.__helmTerminals().sessions.length > 0`, 60_000)
      await sleep(2500)

      const sessionIds = ctx.sessions.list().map((record) => record.id)
      const sessionId = sessionIds.at(-1) ?? -1

      // ---------------------------------------------------------------------
      // S-10: a size change reaches every terminal, and only the visible pane's
      // pty is told - until the hidden one comes back
      // ---------------------------------------------------------------------
      const before = await terminalSnapshot(win)
      const shellIdBefore = ctx.pterm.list()[0]?.id ?? -1
      const sessionGridBefore = ctx.sessions.grid(sessionId)
      const shellGridBefore = ctx.pterm.grid(shellIdBefore)
      sessionResizes.length = 0
      shellResizes.length = 0

      const bigger = 20
      await sendWrite(win, { terminalFontSize: bigger })
      const sizeLanded = await pollJs(
        win,
        `window.__helmTerminals().sessions.concat(window.__helmTerminals().shells)
          .every((t) => t.fontSize === ${String(bigger)})`,
        15_000
      )
      await sleep(1200)

      const afterSize = await terminalSnapshot(win)
      const sessionGridAfter = ctx.sessions.grid(sessionId)
      const shellGridAfter = ctx.pterm.grid(shellIdBefore)
      const sessionResizedWhileVisible = sessionResizes.length
      const shellResizedWhileHidden = shellResizes.length

      /**
       * The three settings that change how a terminal looks without changing
       * how big a cell is.
       *
       * They have to reach every open terminal, and they must NOT put a resize
       * through: a cursor shape moves no cells, and a pty told its size has
       * changed when it has not is a full repaint of whatever TUI is running in
       * it. This is the other half of "only when it actually changed", and the
       * half a build that refits unconditionally would fail.
       */
      sessionResizes.length = 0
      shellResizes.length = 0
      const cosmetic = { cursorStyle: 'bar', cursorBlink: false, scrollback: 2500 } as const
      await sendWrite(win, {
        terminalCursorStyle: cosmetic.cursorStyle,
        terminalCursorBlink: cosmetic.cursorBlink,
        terminalScrollback: cosmetic.scrollback
      })
      const cosmeticLanded = await pollJs(
        win,
        `window.__helmTerminals().sessions.concat(window.__helmTerminals().shells)
          .every((t) => t.cursorStyle === '${cosmetic.cursorStyle}'
            && t.cursorBlink === false
            && t.scrollback === ${String(cosmetic.scrollback)})`,
        15_000
      )
      await sleep(1000)
      const afterCosmetic = await terminalSnapshot(win)
      const cosmeticResizes = sessionResizes.length + shellResizes.length
      const cosmeticIsFree = cosmeticLanded && cosmeticResizes === 0

      // The hidden pane comes back. Its terminal was reconfigured while it was
      // out of the document, measured 0x0, and refused to act on that; showing
      // it is the moment the pty is allowed to hear about the new cell size.
      shellResizes.length = 0
      await click(win, '[data-maximize="workspace"]')
      const shellVisible = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.attached)`,
        15_000
      )
      await sleep(1500)
      const shellGridShown = ctx.pterm.grid(shellIdBefore)
      const shellResizedOnceShown = shellResizes.length

      // The driver's own idea of how wide a cell is at the new size, measured
      // with a canvas of its own making.
      const sessionAfter = afterSize.sessions[0] ?? null
      const measured = await measureCell(win, bigger, sessionAfter?.fontFamily ?? '')
      const paintedCell =
        sessionAfter?.screen != null && sessionAfter.cols > 0
          ? sessionAfter.screen.width / sessionAfter.cols
          : 0
      const paintedRow =
        sessionAfter?.screen != null && sessionAfter.rows > 0
          ? sessionAfter.screen.height / sessionAfter.rows
          : 0
      // xterm quantises a cell to whole device pixels, so the painted cell is
      // this driver's own measurement rounded down - never wider than it, and
      // never more than one device pixel narrower. Anything outside that is a
      // terminal drawing at a size nobody asked for.
      const step = 1 / (measured.dpr || 1)
      const cellAgrees =
        paintedCell > 0 &&
        paintedCell <= measured.spanWidth + 1e-6 &&
        measured.spanWidth - paintedCell < step + 1e-6

      // A second write of the same value must move nothing: a settings change
      // that refits every terminal regardless is a SIGWINCH per unrelated write.
      sessionResizes.length = 0
      shellResizes.length = 0
      await sendWrite(win, { terminalFontSize: bigger })
      await sleep(900)
      const idempotent = sessionResizes.length === 0 && shellResizes.length === 0

      // And the pre-spawn estimate: a brand new shell, opened at the changed
      // size, has to land where the fit puts it. `opened` is the grid
      // `estimateGrid` produced before any pane had measured itself.
      const projectTwo = fixtures.termProjects[1] ?? ''
      await clickProject(win, projectTwo)
      const secondShellUp = await pollJs(
        win,
        `window.__helmTerminals().shells.length === 2`,
        45_000
      )
      await sleep(2000)
      const secondShell = ctx.pterm
        .list()
        .find((entry) => entry.path.toLowerCase() === projectTwo.toLowerCase())
      const estimate = secondShell?.opened ?? null
      const settled = secondShell?.grid ?? null
      const estimateTracks =
        estimate !== null &&
        settled !== null &&
        Math.abs(estimate.cols - settled.cols) <= 1 &&
        Math.abs(estimate.rows - settled.rows) <= 1

      const shot10 = await screenshot(win, shotDir, 'settings-10-terminal-size.png')

      const everyTerminalResized =
        afterSize.sessions.length > 0 &&
        afterSize.shells.length > 0 &&
        [...afterSize.sessions, ...afterSize.shells].every((t) => t.fontSize === bigger) &&
        [...before.sessions, ...before.shells].every(
          (t) =>
            t.fontSize === DEFAULT_TERMINAL.fontSize &&
            t.cursorStyle === DEFAULT_TERMINAL.cursorStyle &&
            t.cursorBlink === DEFAULT_TERMINAL.cursorBlink &&
            t.scrollback === DEFAULT_TERMINAL.scrollback
        )

      checks.push({
        id: 'S-10',
        criterion:
          'Font, size, cursor and scrollback apply live to every open terminal; the grid is re-reported to each pty only when it changed',
        title:
          'Size, cursor and scrollback reach both registries; only the size resizes a pty, the hidden pane waits until it is shown, and a repeat moves nothing',
        ok:
          treeHasFixtures &&
          shellUp &&
          launched &&
          sessionUp &&
          everyTerminalResized &&
          sizeLanded &&
          cosmeticIsFree &&
          sessionGridBefore !== null &&
          sessionGridAfter !== null &&
          sessionGridAfter.cols !== sessionGridBefore.cols &&
          sessionResizedWhileVisible > 0 &&
          shellResizedWhileHidden === 0 &&
          shellVisible &&
          shellResizedOnceShown > 0 &&
          shellGridShown !== null &&
          shellGridBefore !== null &&
          shellGridShown.cols !== shellGridBefore.cols &&
          cellAgrees &&
          idempotent &&
          secondShellUp &&
          estimateTracks,
        detail: {
          fixtureProjectsInTree: treeHasFixtures,
          shellStarted: shellUp,
          shellNameInHeader,
          sessionStarted: sessionUp,
          sizeChangedFrom: DEFAULT_TERMINAL.fontSize,
          sizeChangedTo: bigger,
          reportedBefore: [...before.sessions, ...before.shells],
          reportedAfter: [...afterSize.sessions, ...afterSize.shells],
          cursorAndScrollback: {
            wrote: cosmetic,
            reported: [...afterCosmetic.sessions, ...afterCosmetic.shells].map((t) => ({
              key: t.key,
              cursorStyle: t.cursorStyle,
              cursorBlink: t.cursorBlink,
              scrollback: t.scrollback
            })),
            reachedEveryTerminal: cosmeticLanded,
            ptyResizesItCaused: cosmeticResizes,
            costNothing: cosmeticIsFree
          },
          visiblePane: {
            grid: { before: sessionGridBefore, after: sessionGridAfter },
            ptyResizes: sessionResizedWhileVisible
          },
          hiddenPane: {
            grid: { before: shellGridBefore, whileHidden: shellGridAfter, onceShown: shellGridShown },
            ptyResizesWhileHidden: shellResizedWhileHidden,
            ptyResizesOnceShown: shellResizedOnceShown
          },
          cell: {
            paintedByXterm: { width: paintedCell, height: paintedRow },
            measuredByThisDriver: measured,
            stack: sessionAfter?.fontFamily ?? null,
            devicePixel: step,
            agrees: cellAgrees
          },
          rewritingTheSameValueMovedNothing: idempotent,
          preSpawnEstimate: { estimate, settledAfterFit: settled, tracks: estimateTracks }
        },
        notes: [
          'Every resize is captured by wrapping `sessions.resize` and',
          '`pterm.resize` on the host objects the IPC handlers call, so what is',
          'counted is what the pty was actually told rather than what the',
          'renderer believes it sent.',
          'A hidden pane measures 0x0 and `applyFit` refuses to act on that, so',
          'its pty must NOT be resized while it is out of the document and must',
          'be as soon as it comes back. Both halves are asserted; only asserting',
          'the second would pass for a build that resized a hidden pane to 1x1.',
          'The cell width xterm painted is compared with a measurement this',
          'driver made itself at the same size in the same stack.',
          'Cursor shape, blinking and scrollback are changed in a separate write',
          'and must reach every terminal while resizing none of them: none of',
          'the three moves a cell, and a pty told its size changed when it has',
          'not is a full repaint of whatever is running in it.',
          'The size is then written again unchanged: a settings write that',
          'refits regardless would put a SIGWINCH through every running TUI on',
          'an unrelated setting.',
          'The estimate is the grid `estimateGrid` produced before a pane had',
          'measured anything, recorded by the pty host at open. At 20px it can',
          'only land within a column of the fit if the estimate reads the',
          'setting rather than the built-in 14.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-11: the user's family is prepended, never substituted
      // ---------------------------------------------------------------------
      await openSettings(win)
      await sleep(400)
      await js<void>(
        win,
        `(() => { const el = document.querySelector('[data-settings-pane]');
          if (el) el.scrollTop = el.scrollHeight })()`
      )
      await sleep(300)

      const present = 'Consolas'
      const absent = 'Helm No Such Font'

      await typeInto(win, '[data-settings-terminal-font]', present)
      const presentLanded = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily.startsWith('"${present}"'))`,
        15_000
      )
      await sleep(800)
      const withPresent = await terminalSnapshot(win)
      const presentStack = withPresent.shells[0]?.fontFamily ?? ''
      const presentInstalled = await driverSeesFont(win, present)
      const hintWithPresent = await exists(win, '[data-settings-terminal-font-missing]')
      const rowWithPresent = rowValue(dbFile, 'terminalFontFamily')

      await typeInto(win, '[data-settings-terminal-font]', absent)
      const absentLanded = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily.startsWith('"${absent}"'))`,
        15_000
      )
      await sleep(800)
      const withAbsent = await terminalSnapshot(win)
      const absentStack = withAbsent.shells[0]?.fontFamily ?? ''
      const absentInstalled = await driverSeesFont(win, absent)
      const hintWithAbsent = await attr(
        win,
        '[data-settings-terminal-font-missing]',
        'data-settings-terminal-font-missing'
      )
      const rowWithAbsent = rowValue(dbFile, 'terminalFontFamily')

      // Three measurements this driver makes for itself. The default stack and
      // the nonsense-prepended stack must measure the same - that is the
      // fallback working. The nonsense family *alone* must measure differently,
      // which is what makes the first comparison mean anything: a build that
      // replaced the stack instead of prepending would land on that value.
      const wDefault = (await measureCell(win, 14, DEFAULT_FONT_STACK)).spanWidth
      const wPrepended = (await measureCell(win, 14, `"${absent}", ${DEFAULT_FONT_STACK}`)).spanWidth
      const wAlone = (await measureCell(win, 14, `"${absent}"`)).spanWidth
      const fallbackHeld = Math.abs(wPrepended - wDefault) <= 0.01
      const fixtureDiscriminates = Math.abs(wAlone - wDefault) > 0.5

      const shot11 = await screenshot(win, shotDir, 'settings-11-terminal-font.png')

      // Back to the built-in stack, through the pane's own button.
      await click(win, '[data-settings-terminal-font-clear]')
      const cleared = await pollJs(
        win,
        `window.__helmTerminals().shells.every((t) => t.fontFamily === ${JSON.stringify(
          DEFAULT_FONT_STACK
        )})`,
        15_000
      )
      const rowAfterClear = rowValue(dbFile, 'terminalFontFamily')

      checks.push({
        id: 'S-11',
        criterion:
          'The user font is prepended to the default stack, never replaces it; a font this machine lacks degrades per glyph',
        title:
          'Both an installed and an absent family land in front of the built-in stack, the absent one raises the hint, and rendering falls back',
        ok:
          presentLanded &&
          presentStack === `"${present}", ${DEFAULT_FONT_STACK}` &&
          presentInstalled &&
          !hintWithPresent &&
          rowWithPresent === present &&
          absentLanded &&
          absentStack === `"${absent}", ${DEFAULT_FONT_STACK}` &&
          !absentInstalled &&
          hintWithAbsent === absent &&
          rowWithAbsent === absent &&
          fallbackHeld &&
          fixtureDiscriminates &&
          cleared &&
          rowAfterClear === null,
        detail: {
          defaultStackThisDriverExpects: DEFAULT_FONT_STACK,
          installedFamily: {
            typed: present,
            resolvedStack: presentStack,
            thisDriverSeesTheFont: presentInstalled,
            hintShown: hintWithPresent,
            databaseRow: rowWithPresent
          },
          absentFamily: {
            typed: absent,
            resolvedStack: absentStack,
            thisDriverSeesTheFont: absentInstalled,
            hintNames: hintWithAbsent,
            databaseRow: rowWithAbsent
          },
          cellWidthAt14: {
            defaultStack: wDefault,
            absentPrependedToIt: wPrepended,
            absentFamilyAlone: wAlone,
            fallbackHeld,
            fixtureDiscriminates
          },
          clearedBackToBuiltIn: cleared,
          databaseRowAfterClear: rowAfterClear,
          screenshots: [shot11.file]
        },
        notes: [
          'Typed into the real field with real keystrokes and committed with',
          'Enter, so what is measured is the control a person uses.',
          'The expected stack is this file’s own constant, not an import from',
          '`terminal.ts`: the claim is about what the terminal ends up with, and',
          'importing the value would make it agree with itself.',
          'The fallback is proved by measurement, not by the string. A nonsense',
          'family in front of the stack must measure exactly what the stack',
          'measures - and the same family ALONE must measure something else, or',
          'the first comparison would pass for a build that had thrown the stack',
          'away.'
        ]
      })

      // ---------------------------------------------------------------------
      // S-12: the shell a project pane opens
      // ---------------------------------------------------------------------
      const swept: Record<string, string | null> = {}
      for (const name of Object.keys(EXPECTED_SHELL_ARGS)) {
        swept[name] = whereIs(name)[0] ?? null
      }
      const sweptNames = Object.entries(swept)
        .filter(([, path]) => path !== null)
        .map(([name]) => name)
        .sort()

      const offered = ctx.pterm.detected()
      const offeredNames = offered.map((shell) => shell.name.toLowerCase()).sort()
      const throughTheChannel = await js<Array<{ name: string; path: string; args: string[] }>>(
        win,
        `window.helm.invoke('pterm:shells')`
      )
      const listMatches = offeredNames.join(',') === sweptNames.join(',')
      const pathsMatch = offered.every(
        (shell) => (swept[shell.name.toLowerCase()] ?? '').toLowerCase() === shell.path.toLowerCase()
      )
      const argsMatch = offered.every(
        (shell) =>
          JSON.stringify(shell.args) ===
          JSON.stringify(EXPECTED_SHELL_ARGS[shell.name.toLowerCase()] ?? null)
      )
      const channelAgrees =
        throughTheChannel.map((s) => s.name.toLowerCase()).sort().join(',') === offeredNames.join(',')

      // Every detected shell, actually launched. `bash -NoLogo` - which the
      // substring test this table replaces would have produced for any bash
      // under a path containing "pwsh" - prints a usage error and exits, so a
      // shell that is still alive a second and a half later is the evidence
      // that its arguments were the right ones.
      const launchedShells: Array<Record<string, unknown>> = []
      let everyShellSurvived = true
      for (const [index, shell] of offered.entries()) {
        const dir = join(fixtures.dir, `shell-${String(index)}`)
        mkdirSync(dir, { recursive: true })
        let opened: { id: number; shell: string } | null = null
        try {
          opened = ctx.pterm.open({ path: dir, cols: 80, rows: 24, shell: shell.path })
        } catch (err) {
          opened = null
          launchedShells.push({ name: shell.name, spawnError: String(err) })
        }
        if (opened === null) {
          if (MUST_SURVIVE.includes(shell.name.toLowerCase())) everyShellSurvived = false
          continue
        }
        await sleep(1600)
        const alive = ctx.pterm.list().some((entry) => entry.id === opened.id)
        if (!alive && MUST_SURVIVE.includes(shell.name.toLowerCase())) everyShellSurvived = false
        launchedShells.push({
          name: shell.name,
          path: shell.path,
          args: shell.args,
          reported: opened.shell,
          stillRunningAfter1600ms: alive,
          required: MUST_SURVIVE.includes(shell.name.toLowerCase())
        })
        ctx.pterm.close(opened.id)
      }

      /**
       * The default shell, flipped twice through the pane's own picker with no
       * restart in between.
       *
       * Neither choice is the one auto-detection would make - `pwsh.exe` is
       * first in the list and is deliberately not used here - so "the shell it
       * opened under" cannot be satisfied by a resolver that ignored the
       * setting entirely. The row is put back to null first, so the first pick
       * is a change rather than a value an earlier group already left behind.
       */
      const auto = offered[0]?.path ?? null
      const cmd = swept['cmd.exe'] ?? null
      const winPs = swept['powershell.exe'] ?? null
      const dirs = ['default-auto', 'default-a', 'default-b'].map((name) => {
        const dir = join(fixtures.dir, name)
        mkdirSync(dir, { recursive: true })
        return dir
      })
      const openDefault = (dir: string): Promise<{ shell: string }> =>
        js<{ shell: string }>(
          win,
          `window.helm.invoke('pterm:open', { path: ${JSON.stringify(dir)}, cols: 80, rows: 24 })`
        )

      await sendWrite(win, { terminalShell: null })
      await sleep(500)
      const rowWhenAuto = rowValue(dbFile, 'terminalShell')
      const underAuto = await openDefault(dirs[0] ?? '')

      await openSettings(win)
      await sleep(500)
      const pickedCmd =
        cmd !== null
          ? await chooseOption(win, '[data-settings-terminal-shell]', cmd)
          : { found: false, offered: false, set: false }
      await sleep(800)
      const rowAfterCmd = rowValue(dbFile, 'terminalShell')
      const underCmd = await openDefault(dirs[1] ?? '')

      const pickedWinPs =
        winPs !== null
          ? await chooseOption(win, '[data-settings-terminal-shell]', winPs)
          : { found: false, offered: false, set: false }
      await sleep(800)
      const rowAfterWinPs = rowValue(dbFile, 'terminalShell')
      const underWinPs = await openDefault(dirs[2] ?? '')

      const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
        (a ?? '').toLowerCase() === (b ?? '').toLowerCase()
      const flippedWithoutRestart =
        rowWhenAuto === null &&
        same(underAuto.shell, auto) &&
        pickedCmd.offered &&
        pickedCmd.set &&
        rowAfterCmd === cmd &&
        same(underCmd.shell, cmd) &&
        pickedWinPs.offered &&
        pickedWinPs.set &&
        rowAfterWinPs === winPs &&
        same(underWinPs.shell, winPs)
      for (const entry of ctx.pterm.list()) {
        if (dirs.includes(entry.path)) ctx.pterm.close(entry.id)
      }

      // The per-pane override, driven through the picker in the project shell's
      // own header while the default sits on something else. What the other
      // pane is running is written down first, so "it was left alone" is a
      // comparison rather than an assumption about which shell it had.
      const otherBefore = ctx.pterm
        .list()
        .find((entry) => entry.path.toLowerCase() === projectTwo.toLowerCase())?.shell
      await clickProject(win, projectOne)
      await sleep(1500)
      const overrodeOne =
        cmd !== null
          ? await chooseOption(win, '[data-shell-picker]', cmd)
          : { found: false, offered: false, set: false }
      const overrideRan = await pollJs(
        win,
        `(document.querySelector('[data-shell-running]')?.dataset.shellRunning ?? '')
          .toLowerCase() === ${JSON.stringify((cmd ?? '').toLowerCase())}`,
        30_000
      )
      await sleep(1500)
      const runningNow = ctx.pterm.list()
      const overriddenPane = runningNow.find(
        (entry) => entry.path.toLowerCase() === projectOne.toLowerCase()
      )
      const untouchedPane = runningNow.find(
        (entry) => entry.path.toLowerCase() === projectTwo.toLowerCase()
      )
      // Discriminating only because the override is a shell the default is not:
      // the default is Windows PowerShell by now and the override is cmd.
      const overrideIsLocal =
        !same(cmd, winPs) &&
        same(overriddenPane?.shell, cmd) &&
        same(untouchedPane?.shell, otherBefore)

      // And the session is untouched by any of it. Asked of Windows rather than
      // of Helm: whatever the shell setting says, the process behind a session
      // pane has to be the CLI.
      const sessionPid = ctx.sessions.pid(sessionId)
      const sessionImage = sessionPid === null ? null : imageNameOf(sessionPid)
      const claudeStatus = await js<{ path: string | null }>(win, `window.helm.invoke('setup:status')`)
      const expectedImage = claudeStatus.path === null ? null : baseName(claudeStatus.path)
      const sessionUnaffected =
        sessionImage !== null &&
        expectedImage !== null &&
        sessionImage.toLowerCase() === expectedImage.toLowerCase()

      const shot12 = await screenshot(win, shotDir, 'settings-12-terminal-shell.png')

      checks.push({
        id: 'S-12',
        criterion:
          'The default shell governs new project shells without a restart, a pane can override it for itself, and Claude sessions are unaffected',
        title:
          'The detected list matches this driver’s own where.exe sweep, every shell launches and survives, a flipped default takes effect on the next open, and one pane overrides alone',
        ok:
          listMatches &&
          pathsMatch &&
          argsMatch &&
          channelAgrees &&
          offered.length > 0 &&
          everyShellSurvived &&
          flippedWithoutRestart &&
          overrodeOne.offered &&
          overrodeOne.set &&
          overrideRan &&
          overrideIsLocal &&
          sessionUnaffected,
        detail: {
          whereExeSweptByThisDriver: swept,
          offeredByHelm: offered,
          offeredThroughTheChannel: throughTheChannel,
          listMatches,
          pathsMatch,
          argsMatchThisDriversTable: argsMatch,
          expectedArgs: EXPECTED_SHELL_ARGS,
          channelAgrees,
          launchedShells,
          everyRequiredShellSurvived: everyShellSurvived,
          defaultShell: {
            autoDetectWouldPick: auto,
            unset: { databaseRow: rowWhenAuto, openedUnder: underAuto.shell },
            firstPick: { picked: pickedCmd, databaseRow: rowAfterCmd, openedUnder: underCmd.shell },
            secondPickNoRestart: {
              picked: pickedWinPs,
              databaseRow: rowAfterWinPs,
              openedUnder: underWinPs.shell
            },
            flippedWithoutRestart
          },
          perPaneOverride: {
            picked: overrodeOne,
            headerFollowed: overrideRan,
            defaultAtTheTime: winPs,
            otherPaneBefore: otherBefore,
            overriddenPane,
            untouchedPane,
            localOnly: overrideIsLocal
          },
          session: {
            pid: sessionPid,
            imageNameFromTasklist: sessionImage,
            expectedFromSetupStatus: expectedImage,
            unaffected: sessionUnaffected
          },
          screenshots: [shot10.file, shot12.file]
        },
        notes: [
          'The offered list is compared against this driver’s own `where.exe`',
          'sweep - paths and arguments both - rather than against anything Helm',
          'computed, and the arguments against a table written here.',
          'Every detected shell is then actually launched and checked to still',
          'be alive: `bash -NoLogo`, which the filename substring test this',
          'replaces would produce for a bash under any path containing "pwsh",',
          'prints a usage error and exits. `wsl.exe` is launched and reported',
          'but not required to survive - a machine can have it with no',
          'distribution installed, which is not a fact about Helm.',
          'The default is set to nothing, then flipped twice with no restart in',
          'between, which is what proves the resolver is no longer answering',
          'from a module-level variable it filled once. Neither chosen shell is',
          'the one auto-detection picks, so a resolver that ignored the setting',
          'could not pass by coincidence.',
          'The per-pane override is driven from the picker in the shell pane’s',
          'own header, and the other pane is checked to have kept the default -',
          'an override that changed both would be a global setting with extra',
          'steps.',
          'That the session is unaffected is asked of Windows: `tasklist` is',
          'given the pty’s pid and its answer compared with the executable',
          '`setup:status` names.'
        ]
      })

      // Put the pane back the way a person left it, so the run does not end
      // with a maximised workspace and two fixture shells running.
      await click(win, '[data-maximize="workspace"]')
      await sleep(300)
      for (const entry of ctx.pterm.list()) {
        if (entry.path.toLowerCase().startsWith(fixtures.dir.toLowerCase())) {
          ctx.pterm.close(entry.id)
        }
      }
      // Forced, because the confirmation is the renderer's and nobody is here
      // to answer it. The session was started by this driver and has no purpose
      // beyond having been a terminal.
      await js<unknown>(
        win,
        `window.helm.invoke('session:close', { id: ${String(sessionId)}, force: true })`
      )
      await js<unknown>(
        win,
        `window.helm.invoke('roots:remove', { path: ${JSON.stringify(fixtures.termRoot)} })`
      )
      await sleep(600)
    } finally {
      ctx.sessions.resize = realSessionResize
      ctx.pterm.resize = realShellResize
    }
  }

  // -------------------------------------------------------------------------
  // S-13: the GitHub group (M10)
  // -------------------------------------------------------------------------
  if (run('github')) {
    /** A fetch pass, forced through the real channel and waited on. */
    const refreshPulls = (): Promise<{ ghPath: string | null; problem: string | null }> =>
      js<{ ghPath: string | null; problem: string | null }>(
        win,
        `window.helm.invoke('pr:refresh', {}).then((s) => ({
           ghPath: s.gh.path, problem: s.gh.problem ? s.gh.problem.kind : null }))`
      )

    // Start from "no override", whatever an earlier run left: this runs against
    // the real profile, and the group is only meaningful from a known state.
    await sendWrite(win, { ghPath: null })
    await refreshPulls()
    await openSettings(win)
    await sleep(500)

    // What the pane says gh is, and what this driver finds by asking Windows
    // and then asking the program itself.
    const paintedPath = await text(win, '[data-settings-gh-path]')
    const paintedVersion = await text(win, '[data-settings-gh-version]')
    const onPath = whereIs('gh.exe').concat(whereIs('gh'))
    const directVersion =
      paintedPath === NOTHING ? null : (versionOf(paintedPath)?.split(/\r?\n/)[0]?.trim() ?? null)
    const agreesWithPath =
      onPath.length === 0 ||
      onPath.some((entry) => entry.toLowerCase() === paintedPath.toLowerCase())
    const clearDisabledBefore = await disabled(win, '[data-settings-clear-gh]')

    // Point it at a gh that is installed and not signed in. Everything after
    // this is the unauthenticated path, provoked on a machine whose real gh is
    // signed in - which is the only honest way to see that sentence here.
    answerPicker('file', fixtures.ghStub)
    await click(win, '[data-settings-gh-locate]')
    const overrideShown = await pollJs(
      win,
      `(document.querySelector('[data-settings-gh-path]')?.textContent ?? '')
        .includes(${JSON.stringify('gh.cmd')})`,
      30_000
    )
    await sleep(600)

    const overriddenPath = await text(win, '[data-settings-gh-path]')
    const overriddenVersion = await text(win, '[data-settings-gh-version]')
    const stubSays = versionOf(fixtures.ghStub)?.split(/\r?\n/)[0]?.trim() ?? null
    const ghRowAfterPick = rowValue(dbFile, 'ghPath')
    const clearDisabledAfter = await disabled(win, '[data-settings-clear-gh]')
    const afterPick = await refreshPulls()

    // The sentence, where a user would meet it: the Pulls pane and the sidebar
    // row that leads to it.
    await click(win, '[data-open-pulls]')
    const pulled = await pollJs(win, `document.querySelector('[data-pulls-caption]')`, 15_000)
    await sleep(500)
    const unauthSentence = await text(win, '[data-pulls-problem="unauthenticated"]')
    const sidebarLine = await text(win, '[data-open-pulls]')
    const caption = await text(win, '[data-pulls-caption]')
    const shotGh = await screenshot(win, shotDir, 'settings-13-github.png')

    await openSettings(win)
    await sleep(400)
    await click(win, '[data-settings-clear-gh]')
    const cleared = await pollJs(
      win,
      `!(document.querySelector('[data-settings-gh-path]')?.textContent ?? '')
        .includes(${JSON.stringify('gh.cmd')})`,
      30_000
    )
    await sleep(500)
    const ghRowAfterClear = rowValue(dbFile, 'ghPath')
    const afterClear = await refreshPulls()

    // The interval, through the pane's own picker. Off first, because off is
    // the state a select could most easily fail to represent.
    const offered = await js<string[]>(
      win,
      `[...(document.querySelector('[data-settings-pr-poll]')?.options ?? [])].map((o) => o.value)`
    )
    const pickedOff = await chooseOption(win, '[data-settings-pr-poll]', '0')
    await sleep(600)
    const rowWhenOff = rowValue(dbFile, 'prPollMinutes')
    const pickedFifteen = await chooseOption(win, '[data-settings-pr-poll]', '15')
    await sleep(600)
    const rowWhenFifteen = rowValue(dbFile, 'prPollMinutes')

    // The review launch's two settings (M12), through the pane's own controls.
    // The template is typed rather than written, because a text field that
    // commits on blur has two ways to fail that a row write does not.
    const template = 'Review {slug}#{number} on {branch}'
    const typedTemplate = await typeInto(win, '[data-settings-pr-prompt]', template)
    await sleep(600)
    const rowAfterTyping = rowValue(dbFile, 'prReviewPrompt')
    const resetDisabledWhenCustom = await disabled(win, '[data-settings-pr-prompt-reset]')
    await click(win, '[data-settings-pr-prompt-reset]')
    await sleep(600)
    const rowAfterReset = rowValue(dbFile, 'prReviewPrompt')
    const resetDisabledWhenDefault = await disabled(win, '[data-settings-pr-prompt-reset]')

    const pickedCheckout = await chooseOption(win, '[data-settings-pr-checkout]', 'checkout')
    await sleep(600)
    const rowWhenCheckout = rowValue(dbFile, 'prCheckout')
    const pickedNone = await chooseOption(win, '[data-settings-pr-checkout]', 'none')
    await sleep(600)
    const rowWhenNone = rowValue(dbFile, 'prCheckout')

    checks.push({
      id: 'S-13',
      criterion:
        'Every GitHub setting is settable from the pane’s GitHub group: the gh path, the interval, the review prompt and the checkout mode',
      title:
        'The pane names the gh this machine actually has, takes an override that reaches the fetch, and the interval, prompt and checkout mode all reach the database',
      ok:
        paintedPath !== '' &&
        paintedPath !== NOTHING &&
        directVersion !== null &&
        paintedVersion === directVersion &&
        agreesWithPath &&
        clearDisabledBefore === true &&
        overrideShown &&
        overriddenPath === fixtures.ghStub &&
        stubSays !== null &&
        overriddenVersion === stubSays &&
        ghRowAfterPick === fixtures.ghStub &&
        clearDisabledAfter === false &&
        afterPick.ghPath === fixtures.ghStub &&
        afterPick.problem === 'unauthenticated' &&
        pulled &&
        unauthSentence.includes('gh auth login') &&
        sidebarLine.includes('Run gh auth login') &&
        caption.includes('fetched') &&
        cleared &&
        ghRowAfterClear === null &&
        afterClear.ghPath === paintedPath &&
        afterClear.problem === null &&
        offered.includes('0') &&
        pickedOff.offered &&
        pickedOff.set &&
        rowWhenOff === 0 &&
        pickedFifteen.offered &&
        pickedFifteen.set &&
        rowWhenFifteen === 15 &&
        typedTemplate &&
        rowAfterTyping === template &&
        resetDisabledWhenCustom === false &&
        rowAfterReset === '/code-review {number}' &&
        // Disabled once it is back at the built-in prompt: a Reset that stays
        // live is a Reset that says the setting is still custom.
        resetDisabledWhenDefault === true &&
        pickedCheckout.offered &&
        pickedCheckout.set &&
        rowWhenCheckout === 'checkout' &&
        pickedNone.offered &&
        pickedNone.set &&
        rowWhenNone === 'none',
      detail: {
        discovered: { painted: { path: paintedPath, version: paintedVersion }, whereExeSays: onPath },
        askedTheExecutableDirectly: directVersion,
        paintedPathIsTheOneOnPath: agreesWithPath,
        clearDisabledWithNoOverride: clearDisabledBefore,
        afterPicking: {
          painted: { path: overriddenPath, version: overriddenVersion },
          stubSaysDirectly: stubSays,
          databaseRow: ghRowAfterPick,
          snapshot: afterPick,
          clearEnabled: clearDisabledAfter === false
        },
        degradation: {
          paneSentence: unauthSentence,
          sidebarSecondLine: sidebarLine,
          ageCaption: caption
        },
        afterClearing: { databaseRow: ghRowAfterClear, snapshot: afterClear },
        pollInterval: {
          offeredValues: offered,
          off: { picked: pickedOff, databaseRow: rowWhenOff },
          fifteen: { picked: pickedFifteen, databaseRow: rowWhenFifteen }
        },
        reviewPrompt: {
          typed: typedTemplate,
          templateTyped: template,
          databaseRowAfterTyping: rowAfterTyping,
          resetEnabledWhileCustom: resetDisabledWhenCustom === false,
          databaseRowAfterReset: rowAfterReset,
          resetDisabledAtTheDefault: resetDisabledWhenDefault === true
        },
        checkoutMode: {
          checkout: { picked: pickedCheckout, databaseRow: rowWhenCheckout },
          none: { picked: pickedNone, databaseRow: rowWhenNone }
        },
        screenshot: shotGh.file
      },
      notes: [
        'The version on screen is compared with what the executable prints when',
        'this driver runs it, and the path against `where.exe gh` - the same',
        'two independent reads the Claude CLI group gets.',
        'The override is a real program on disk that answers `--version` and',
        'fails `auth status`, which is the only honest way to see the',
        '"not signed in" sentence on a machine whose gh is signed in. It is',
        'picked through the pane’s own button and the real `path:chooseFile`',
        'handler, and read back out of the database file rather than the app.',
        'The sentence is then read where a user meets it: in the Pulls pane and',
        'on the sidebar row, in its short form. Detection is from gh’s exit code',
        'alone - nothing here or in the app opens a credential store.',
        'The interval is set through the select, including 0, which is the value',
        'that disarms the timer rather than a small number inside the range.',
        'The review prompt is typed into the field and committed the way a person',
        'commits it, then put back with Reset - and Reset is checked for being',
        'disabled at the built-in prompt, because a Reset that stays live is one',
        'saying the setting is still custom when it is not.',
        'What these two settings actually *do* is `pnpm pr-check`’s: this proves',
        'they are reachable and persist, and that driver proves the template',
        'reaches the argv and that checkout mode refuses a dirty tree.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // What the restart phase will look for
  // -------------------------------------------------------------------------
  const parked: Partial<AppSettings> = {
    // None of these is the default, so reading them back after a restart is
    // evidence rather than a coincidence: `system`, `percent` and `null` are
    // what a database with no row at all reports.
    theme: 'light',
    usageDisplay: 'off',
    ...(claudeForPark !== null ? { claudePath: claudeForPark } : {}),
    // Root A added through the pane and root B removed through it: one array
    // carrying both halves of the criterion across the restart. Root A appears
    // exactly once - `original` has had this driver's own paths scrubbed out.
    scanRoots: [...original.scanRoots, fixtures.rootA],
    // All six terminal settings, every one of them off its default for the same
    // reason. `terminalShell` is parked on a real program rather than a
    // fixture: a restore that somehow does not happen must leave the app able
    // to open a shell.
    terminalFontFamily: 'Consolas',
    terminalFontSize: 15,
    terminalCursorStyle: 'bar',
    terminalCursorBlink: false,
    terminalScrollback: 12345,
    terminalShell: whereIs('cmd.exe')[0] ?? original.terminalShell,
    // The real gh rather than the fixture, for the reason `claudePath` uses the
    // real claude: a restore that somehow does not happen must leave the app
    // pointed at a working program, not at a stub that refuses to sign in.
    ...(whereIs('gh.exe')[0] !== undefined ? { ghPath: whereIs('gh.exe')[0] } : {}),
    prPollMinutes: 30,
    // Both off their defaults, like everything else here. The template is one
    // no default could produce and the checkout mode is the non-default half of
    // a two-value enum, which is the strongest either can be parked on.
    prReviewPrompt: '/security-review {number} in {slug}',
    prCheckout: 'checkout'
  }

  const applied = await sendWrite(win, parked as Record<string, unknown>)
  await sleep(600)
  if (!applied.accepted) {
    checks.push({
      id: 'S-8',
      criterion: 'The pane writes settings that persist',
      title: 'The run could not park the settings the restart phase reads',
      ok: false,
      detail: { parked, error: applied.error },
      notes: ['Without a parked value there is nothing for the second phase to find.']
    })
  }

  writeFileSync(
    join(dataDir, 'settings-parked.json'),
    JSON.stringify({ parked, dbFile, at: new Date().toISOString() }, null, 2)
  )

  const finalRows = allRows(dbFile)
  checks.push({
    id: 'S-8',
    criterion: 'Every visible setting round-trips to the database',
    title: 'Every setting the restart phase reads is in the file before the app is closed',
    ok:
      applied.accepted &&
      Object.entries(parked).every(
        ([key, value]) => JSON.stringify(finalRows[key]) === JSON.stringify(value)
      ),
    detail: { parked, rowsInFile: finalRows, dbFile, originalSettings: original },
    notes: [
      'Read from the database file through a second connection, not from the',
      'app - a value in the app is not yet a value a restart will find.',
      'Whether it survives the restart is decided by phase two in',
      'scripts/run-settings.mjs, which starts the app again and reports what it',
      'read. This process cannot assert that about itself.',
      'The parked CLI path is the real one on this machine rather than the stub:',
      'the run script restores the originals afterwards, and a restore that',
      'somehow does not happen must not leave the app pointed at a fake.'
    ]
  })

  win.setTitleBarOverlay = realSetOverlay
  return { checks, parked }
}
