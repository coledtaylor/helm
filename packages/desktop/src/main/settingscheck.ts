import { nativeTheme, type BrowserWindow } from 'electron'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, type AppSettings } from '@helm/core'
import { screenshot, sendKey, sleep } from './bridge'
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

const GROUPS = ['pane', 'claude', 'roots', 'appearance', 'accessors', 'validation'] as const
type Group = (typeof GROUPS)[number]

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

/** `where.exe claude`, which is what a person would type to find out. */
function whereClaude(): string[] {
  try {
    return execFileSync('where.exe', ['claude'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

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
 * CSS reads a backslash as an escape: `[data-settings-root="C:\Users\x"]`
 * matches an element whose attribute is `C:Usersx`, and `\a` would be a hex
 * escape rather than a letter at all. Comparing the attribute in JavaScript has
 * no such rules.
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
}

function buildFixtures(dataDir: string): Fixtures {
  const dir = join(dataDir, 'settings-fixtures')
  rmSync(dir, { recursive: true, force: true })

  const rootA = join(dir, 'root a')
  const rootB = join(dir, 'root-b')
  const aProjects = [join(rootA, 'alpha one')]
  const bProjects = [join(rootB, 'beta-one'), join(rootB, 'beta-two')]
  // A path with a space in it on purpose: Windows-first, and every path Helm
  // stores has to survive one.
  for (const path of [...aProjects, ...bProjects]) mkdirSync(join(path, '.claude'), { recursive: true })

  const stubDir = join(dir, 'stub')
  mkdirSync(stubDir, { recursive: true })
  const stubCli = join(stubDir, 'claude.cmd')
  writeFileSync(stubCli, '@echo off\r\nif "%1"=="--version" echo 9.9.9 (Claude Code)\r\n')

  return { dir, rootA, rootB, aProjects, bProjects, stubCli }
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
         usage: Boolean(document.querySelector('[data-settings-usage]'))
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
      title: 'The gear opens a Settings pane with all three groups, and Ctrl+Tab cycles to it',
      ok:
        gearThere &&
        !paneBefore &&
        opened &&
        tabSelected === 'true' &&
        groups.join(',') === 'claude,workspace,appearance' &&
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
    const directVersion = paintedPath === '—' ? null : versionOf(paintedPath)
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
        paintedPath !== '—' &&
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
        bad: ['repos/helm'],
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
      }
    ]

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
      title: 'Six hand-sent bad writes are refused and change nothing; six good ones land',
      ok:
        allControlsLanded &&
        allRejected &&
        !partial &&
        unknownKey.accepted &&
        themeAfterUnknown === 'light' &&
        unknownStored === undefined,
      detail: {
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
        'and before this it reached `nativeTheme.themeSource`.'
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
    scanRoots: [...original.scanRoots, fixtures.rootA]
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
    title: 'The four settings the restart phase reads are in the file before the app is closed',
    ok:
      applied.accepted &&
      finalRows['theme'] === 'light' &&
      finalRows['usageDisplay'] === 'off' &&
      JSON.stringify(finalRows['scanRoots']) === JSON.stringify(parked.scanRoots) &&
      (parked.claudePath === undefined || finalRows['claudePath'] === parked.claudePath),
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
