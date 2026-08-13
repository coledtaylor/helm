import { type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSessions, type Project, type SessionRecord } from '@helm/core'
import { screenshot, sendKey, sleep, squash, stripAnsi, typeText, waitFor } from './bridge'
import type { ConfigService } from './config'
import type { ContentService } from './content'
import type { Check } from './fidelity'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import type { PtermHost } from './pterm'
import type { PullsService } from './pulls'
import type { Confirm, ConfirmRequest, SessionHost, SessionObserver } from './sessions'
import type { Services } from './services'
import type { UsageService } from './usage'

/**
 * The session-lifecycle criteria, driven through the app the way a user
 * reaches them.
 *
 * Everything here goes through the real surface: sidebar rows are clicked, the
 * launch button is clicked, tabs are switched by clicking tabs. The alternative
 * - calling the session host directly - would prove the main process works and
 * say nothing about whether the thing on screen is wired to it.
 *
 * `pnpm sessions-check` -> helm-data/sessions-report.json
 */

export interface CheckContext {
  win: BrowserWindow
  services: Services
  sessions: SessionHost
  /**
   * The project shells. `settings-check`'s terminal group reads the grid each
   * shell's pty is actually at through this, which is the main-process half of
   * "the pane refit and the pty was told"; nothing else uses it.
   */
  pterm: PtermHost
  /** history-check reads and forces passes through this; sessions-check ignores it. */
  history: HistoryService
  /** transcript-check drives the archive's passes and its ceiling through this. */
  archive: ArchiveService
  /** config-check reads and writes config through this; nothing else uses it. */
  config: ConfigService
  /** content-check reads, renders and searches content through this. */
  content: ContentService
  /**
   * The usage reader. `usage-check` points it at fixtures through this: it is
   * the only way to prove a reshaped `cachedUsageUtilization` paints nothing,
   * and it is deliberately not reachable from the window.
   */
  usage: UsageService
  /**
   * The pull-request sweep. Aimed at a fake `gh` and a fixed set of remotes
   * through its own `point*` hooks, for the same reason `usage` is: which
   * binary the pull requests come from is not the window's to choose.
   */
  pulls: PullsService
}

// ---------------------------------------------------------------------------
// Talking to the renderer
// ---------------------------------------------------------------------------

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return win.webContents.executeJavaScript(expression, true) as Promise<T>
}

/**
 * Elements are found by their own properties rather than by CSS attribute
 * selectors, because every value being matched here is a Windows path or a tab
 * title - and a backslash inside a CSS attribute selector is an escape
 * sequence, not a character.
 */
async function clickByTitle(win: BrowserWindow, title: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('aside button[title]')]
        .find((b) => b.title === ${JSON.stringify(title)});
      if (!el) return false; el.click(); return true })()`
  )
}

async function clickButton(win: BrowserWindow, text: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent ?? '').includes(${JSON.stringify(text)}));
      if (!el) return false; el.click(); return true })()`
  )
}

/** What a session tab reads, both lines, straight off the DOM. */
async function tabText(
  win: BrowserWindow,
  id: number
): Promise<{ title: string; subtitle: string | null } | null> {
  return js<{ title: string; subtitle: string | null } | null>(
    win,
    `(() => {
       const tab = document.querySelector('[data-tab="session:${String(id)}"]');
       if (!tab) return null;
       const sub = tab.querySelector('[data-tab-subtitle]');
       const title = sub ? sub.previousElementSibling : tab.querySelector('span span');
       return { title: title ? title.textContent : '', subtitle: sub ? sub.textContent : null }
     })()`
  ).catch(() => null)
}

/** Double-click a tab's title, which is what opens the rename field. */
async function openRename(win: BrowserWindow, id: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-tab="session:${String(id)}"]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true })()`
  ).catch(() => false)
}

/** The open rename field's value and whether it actually holds the caret. */
async function renameState(
  win: BrowserWindow,
  id: number
): Promise<{ open: boolean; value: string; focused: boolean }> {
  return js<{ open: boolean; value: string; focused: boolean }>(
    win,
    `(() => { const el = document.querySelector('[data-tab-rename="session:${String(id)}"]');
      return el
        ? { open: true, value: el.value, focused: document.activeElement === el }
        : { open: false, value: '', focused: false } })()`
  ).catch(() => ({ open: false, value: '', focused: false }))
}

/** Tabs are addressed by `data-tab`, which carries the pane's identity, so a
 * project tab and its session's tab are never confused for each other. */
async function clickSessionTab(win: BrowserWindow, id: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-tab="session:${String(id)}"]');
      if (!el) return false; el.click(); return true })()`
  )
}

/** The close button that lives beside a session's tab. */
async function clickCloseTab(win: BrowserWindow, id: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const tab = document.querySelector('[data-tab="session:${String(id)}"]');
      const el = tab?.parentElement?.querySelector('button[aria-label^="Close"]');
      if (!el) return false; el.click(); return true })()`
  )
}

async function clickTabAt(win: BrowserWindow, index: number): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelectorAll('[role="tab"]')[${String(index)}];
      if (!el) return false; el.click(); return true })()`
  )
}

/** Pane identities in strip order - the thing reordering has to permute. */
async function tabOrder(win: BrowserWindow): Promise<string[]> {
  return js<string[]>(
    win,
    `[...document.querySelectorAll('[role="tab"]')].map((t) => t.dataset.tab ?? '')`
  )
}

async function activeTab(win: BrowserWindow): Promise<string | null> {
  // Scoped to session tabs: the split view keeps a workspace strip and a
  // session strip, each with its own active tab, and the check that calls
  // this is asking which *session* is in front.
  return js<string | null>(
    win,
    `(() => { const el = document.querySelector('[role="tab"][data-tab^="session:"][aria-selected="true"]');
      return el ? (el.dataset.tab ?? '') : null })()`
  )
}

/** Polls a renderer-side expression until it is truthy. */
async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

// ---------------------------------------------------------------------------
// Watching sessions
// ---------------------------------------------------------------------------

export interface Collector extends SessionObserver {
  output: (id: number) => string
  notified: () => SessionRecord[]
  /** Stands in for the native confirmation dialog. */
  confirm: Confirm
  /** What the next confirmation will be answered with. */
  answerWith: (agreed: boolean) => void
  asked: () => ConfirmRequest[]
}

export function createCollector(): Collector {
  const output = new Map<number, string>()
  const notified: SessionRecord[] = []
  const asked: ConfirmRequest[] = []
  let answer = false

  return {
    onOutput: (id, chunk) => output.set(id, (output.get(id) ?? '') + chunk),
    onNotified: (record) => notified.push(record),
    output: (id) => output.get(id) ?? '',
    notified: () => [...notified],
    // A native message box has no automation surface, and one left open on
    // screen also blocks the app's own shutdown - which is the next thing this
    // driver has to test. So the question is answered here instead.
    confirm: (request) => {
      asked.push(request)
      return Promise.resolve(answer)
    },
    answerWith: (agreed) => {
      answer = agreed
    },
    asked: () => [...asked]
  }
}

/** Claude Code's startup gates - folder trust, MCP enablement - are arbitrary
 * dialogs a host must expect rather than a fixed sequence (Spike C, D0). */
export function answerStartupGates(
  ctx: { sessions: SessionHost },
  collector: Collector,
  ids: number[]
): () => void {
  const answered = new Set<string>()
  const timer = setInterval(() => {
    for (const id of ids) {
      // Squashed, not merely stripped: the TUI positions text by moving the
      // cursor instead of emitting the spaces between words, so the stream
      // reads `quicksafetycheck:isthisaproject...` and any pattern containing a
      // space matches nothing. `/MCP\s*servers/` worked here by accident - its
      // `\s*` allows the zero spaces that are actually in the stream.
      const text = squash(collector.output(id))
      // Wording moves between releases: 2.1.225 asks folder trust as "Quick
      // safety check: Is this a project you created or one you trust?" where an
      // earlier one asked "Do you trust the files in this folder?". This only
      // ever fired against already-trusted folders, so the drift went unseen.
      if (
        !answered.has(`trust:${String(id)}`) &&
        /doyoutrust|trustthisfolder|quicksafetycheck/.test(text)
      ) {
        answered.add(`trust:${String(id)}`)
        ctx.sessions.input(id, '\r')
      }
      if (!answered.has(`mcp:${String(id)}`) && /mcpservers/.test(text)) {
        answered.add(`mcp:${String(id)}`)
        ctx.sessions.input(id, '\x1b')
      }
    }
  }, 300)
  return () => clearInterval(timer)
}

/**
 * Whether a hosted session has reached its own input prompt.
 *
 * The signal is the composer's hint line, which the TUI paints only once it is
 * accepting input, and which has two forms: `? for shortcuts` when no
 * permission mode is on, and `(shift+tab to cycle)` when one is - the CLI now
 * starts in auto mode on this machine, so the second is the common case.
 *
 * Measured on 2.1.227, in both of the welcome layouts the CLI picks between:
 *
 *   Wide (a full window):   Claude Code v2.1.227
 *                           Fable 5 with high effort · Claude Max
 *
 *   Narrow (a docked pane): ┌ Claude Code ──────────┐
 *                           │  Welcome back Cole!   │
 *
 * The narrow one carries **no version at all**, which is why matching the
 * banner is no longer enough on its own: a session in the session split reached
 * its prompt and `Claude Code v\d` never appeared. That pattern stays as a
 * fallback for a CLI whose hint line reads differently again, and because it
 * costs nothing - but the hint line is the one that means what this is asked.
 */
export const atPrompt = (text: string): boolean =>
  /\?\s*for\s*shortcuts/.test(text) ||
  /shift\s*\+?\s*tab\s*to\s*cycle/i.test(text) ||
  /Claude\s*Code\s*v\d/.test(text)

export function processAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    // Signal 0 tests for existence without touching the process.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Every pid in a process's tree, so the orphan check covers the children a
 * hosted session spawned - MCP servers, ripgrep, whatever a Bash call started -
 * rather than only the session itself.
 *
 * Through CIM rather than `wmic`, which is deprecated and absent from recent
 * Windows 11 builds.
 */
function descendants(pid: number): number[] {
  if (process.platform !== 'win32') return [pid]
  try {
    const csv = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId)" }'
      ],
      { windowsHide: true, timeout: 20_000, encoding: 'utf8' }
    )
    const edges: Array<{ pid: number; parent: number }> = []
    for (const line of csv.split(/\r?\n/)) {
      const [child, parent] = line.split(',').map(Number)
      if (Number.isFinite(child) && Number.isFinite(parent)) {
        edges.push({ pid: child as number, parent: parent as number })
      }
    }
    const tree = [pid]
    for (let i = 0; i < tree.length; i++) {
      for (const edge of edges) {
        if (edge.parent === tree[i] && !tree.includes(edge.pid)) tree.push(edge.pid)
      }
    }
    return tree
  } catch {
    return [pid]
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The branch a directory is on, read by this driver rather than by the code
 * under test.
 *
 * Deliberately not `readGitBranch` from core: that is what wrote the value being
 * checked, and a parser agreeing with itself proves nothing. A different command
 * (`rev-parse`, not `symbolic-ref`) run synchronously here is an independent
 * second reader, and it disagrees on exactly the case worth catching - it prints
 * the literal `HEAD` for a detached head, where the column should be null.
 */
function branchOf(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return out === '' || out === 'HEAD' ? null : out
  } catch {
    return null
  }
}

/** Three projects to launch against, preferring repos so the cwds differ. */
function pick(services: Services): Project[] {
  const projects = services.lastScan?.projects ?? []
  const chosen = projects.filter((p) => p.kind === 'repo').slice(0, 3)
  for (const project of projects) {
    if (chosen.length >= 3) break
    if (!chosen.some((c) => c.path === project.path)) chosen.push(project)
  }
  return chosen
}

export async function runSessionsChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx

  /**
   * Every byte the window sends to a pty, counted.
   *
   * Wrapped on the host object, the way `settings-check` counts pty resizes, and
   * for the same reason: this is the only place a keystroke that left the
   * renderer can be observed arriving. SESS-11 needs the count to be **zero**
   * while the rename field has the caret, and "the terminal did not get it" has
   * no other witness - the pty would swallow an unwanted keystroke silently and
   * the check would pass on a reasonable-sounding argument about focus.
   */
  const pty = ((): { count: () => number } => {
    let writes = 0
    const real = ctx.sessions.input.bind(ctx.sessions)
    ctx.sessions.input = (id, data): void => {
      writes += 1
      real(id, data)
    }
    return { count: () => writes }
  })()

  // Both, and in this order: the tree paints from the cache before the first
  // scan finishes, so a DOM with rows in it is not yet a main process that
  // knows which projects those rows are.
  const scanned = await waitFor(() => pick(ctx.services).length >= 3, 120_000)
  const painted = await pollJs(
    win,
    `document.querySelectorAll('aside button[title]').length >= 3`,
    30_000
  )
  await sleep(500)
  const projects = pick(ctx.services)

  if (!scanned || !painted || projects.length < 3) {
    checks.push({
      id: 'SESS-0',
      criterion: 'setup',
      title: 'Discovery found at least three projects to launch against',
      ok: false,
      detail: { scanned, painted, found: projects.length },
      notes: ['Nothing else can run without three projects, so the rest is skipped.']
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // SESS-1: three concurrent sessions, three different repos
  // -------------------------------------------------------------------------
  const started: SessionRecord[] = []
  for (const project of projects) {
    await clickByTitle(win, project.path)
    await sleep(200)
    await clickButton(win, 'Start session here')
    await waitFor(() => ctx.sessions.list().length > started.length, 20_000)
    const latest = ctx.sessions.list().at(-1)
    if (latest) started.push(latest)
    await sleep(300)
  }

  const stopGates = answerStartupGates(
    ctx,
    collector,
    started.map((s) => s.id)
  )
  const ready = await waitFor(
    () => started.every((s) => atPrompt(stripAnsi(collector.output(s.id)))),
    90_000
  )
  stopGates()
  await sleep(2500)

  const pids = new Map(started.map((s) => [s.id, ctx.sessions.pid(s.id) ?? -1]))
  const shot1 = await screenshot(win, shotDir, 'sessions-three-sessions.png')

  checks.push({
    id: 'SESS-1',
    criterion: 'Can run 3+ concurrent claude sessions in tabs against different repos',
    title: 'Three sessions launched from the launcher, each in its own repo',
    ok:
      started.length === 3 &&
      ready &&
      new Set(started.map((s) => s.cwd)).size === 3 &&
      new Set(pids.values()).size === 3 &&
      [...pids.values()].every(processAlive),
    detail: {
      sessions: started.map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        argv: s.argv,
        pid: pids.get(s.id),
        alive: processAlive(pids.get(s.id) ?? -1),
        bytes: collector.output(s.id).length
      })),
      tabs: await tabOrder(win),
      screenshot: shot1.file
    },
    notes: ready ? [] : ['At least one session did not reach its prompt within 90s.']
  })

  // -------------------------------------------------------------------------
  // SESS-2: a backgrounded pane keeps its grid
  // -------------------------------------------------------------------------
  const gridsBefore = started.map((s) => ctx.sessions.grid(s.id))
  for (const index of [0, 3, 5, 1]) {
    await clickTabAt(win, index)
    await sleep(250)
  }
  await clickSessionTab(win, started[0]?.id ?? -1)
  await sleep(700)
  const gridsAfter = started.map((s) => ctx.sessions.grid(s.id))
  const shot2 = await screenshot(win, shotDir, 'sessions-after-tab-switching.png')

  checks.push({
    id: 'SESS-2',
    criterion: 'Resize works per Spike C, in an app layout rather than a bare page',
    title: 'A backgrounded pane keeps its grid instead of fitting to a 1x1 box',
    ok: gridsAfter.every((grid) => grid !== null && grid.cols > 20 && grid.rows > 5),
    detail: { gridsBefore, gridsAfter, screenshot: shot2.file },
    notes: [
      'A hidden container measures 0x0, and FitAddon turns that into a 1x1 grid the pty acts on.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-3: reordering the tab strip
  // -------------------------------------------------------------------------
  const orderBefore = await tabOrder(win)
  const moved = await js<boolean>(
    win,
    `(() => { const tabs = [...document.querySelectorAll('[role="tab"]')];
      const el = tabs.at(-1); if (!el) return false; el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowLeft', ctrlKey: true, shiftKey: true, bubbles: true }));
      return true })()`
  )
  await sleep(400)
  const orderAfter = await tabOrder(win)

  checks.push({
    id: 'SESS-3',
    criterion: 'Tab strip: open sessions across projects, reorder',
    title: 'A tab can be moved along the strip',
    ok:
      moved &&
      orderBefore.length === orderAfter.length &&
      orderBefore.join('|') !== orderAfter.join('|') &&
      [...orderBefore].sort().join('|') === [...orderAfter].sort().join('|'),
    detail: { orderBefore, orderAfter },
    notes: ['Driven through the keyboard path; the pointer drag calls the same handler.']
  })

  // -------------------------------------------------------------------------
  // SESS-4 / SESS-5: a session that ends on its own
  // -------------------------------------------------------------------------
  const background = started[1]
  const foreground = started[0]

  if (background && foreground) {
    // Look at another session's tab, so the one that ends is genuinely
    // unwatched while still leaving a terminal on screen.
    await clickSessionTab(win, foreground.id)
    await sleep(500)

    ctx.sessions.input(background.id, '/exit\r')
    const exited = await waitFor(
      () => ctx.sessions.list().find((s) => s.id === background.id)?.status === 'exited',
      45_000
    )
    await sleep(800)

    const row = readSessions(ctx.services.store, { limit: 50 }).find((s) => s.id === background.id)
    const notified = collector.notified().some((r) => r.id === background.id)
    const focusedWhenItEnded = await activeTab(win)

    // Now go and look at what the ended session's pane says.
    await clickSessionTab(win, background.id)
    await sleep(600)
    const shot3 = await screenshot(win, shotDir, 'sessions-session-ended.png')
    const bannerText = await js<string>(
      win,
      `(() => { const el = document.querySelector('[role="status"]');
        return el ? (el.textContent ?? '').trim() : '' })()`
    )

    checks.push({
      id: 'SESS-4',
      criterion: 'Exit code and duration of each session recorded in SQLite',
      title: 'A session ended with /exit records exit code 0 and a measured duration',
      ok:
        exited &&
        row !== undefined &&
        row.status === 'exited' &&
        row.exitCode === 0 &&
        row.durationMs !== null &&
        row.durationMs > 0 &&
        row.durationMs < 600_000 &&
        /Session ended/i.test(bannerText),
      detail: { row, bannerText, screenshot: shot3.file },
      notes: ['The tab and its scrollback stay; the pane says what happened and offers the close.']
    })

    checks.push({
      id: 'SESS-5',
      criterion: "Notification fires when a non-focused tab's session ends",
      title: 'The exit of a background session raises a notification',
      ok: notified && focusedWhenItEnded === `session:${String(foreground.id)}`,
      detail: {
        notifiedSessions: collector.notified().map((r) => ({ id: r.id, name: r.name })),
        focusedWhenItEnded,
        endedSession: `session:${String(background.id)}`,
        windowFocused: win.isFocused()
      },
      notes: ['A different session was in front, so this holds regardless of window focus.']
    })
  }

  // -------------------------------------------------------------------------
  // SESS-6: closing a tab whose session is alive asks first
  // -------------------------------------------------------------------------
  const live = started.find((s) => s.id !== background?.id)
  if (live) {
    await clickSessionTab(win, live.id)
    await sleep(400)
    const pid = ctx.sessions.pid(live.id) ?? -1

    // Both answers are driven from the tab's own close button, so what is being
    // tested is the whole path - renderer to main and back - rather than the
    // session host in isolation.

    // Declined: the tab and the process both have to survive.
    collector.answerWith(false)
    await clickCloseTab(win, live.id)
    await sleep(1200)
    const askedOnDecline = collector.asked().at(-1)
    const survivedDecline = processAlive(pid)
    const tabAfterDecline = (await tabOrder(win)).includes(`session:${String(live.id)}`)

    // Confirmed: both have to go.
    collector.answerWith(true)
    await clickCloseTab(win, live.id)
    const died = await waitFor(() => !processAlive(pid), 8000)
    const tabGone = await pollJs(
      win,
      `!document.querySelector('[data-tab="session:${String(live.id)}"]')`,
      5000
    )
    // The row is written when the exit is *observed*, and node-pty delivers
    // that on its own schedule - a dead process is not yet a recorded one.
    const findRow = (): SessionRecord | undefined =>
      readSessions(ctx.services.store, { limit: 50 }).find((s) => s.id === live.id)
    const recorded = await waitFor(() => findRow()?.status === 'exited', 15_000)
    const row = findRow()

    checks.push({
      id: 'SESS-6',
      criterion:
        'Closing a tab with a live session prompts; confirmed close terminates the process cleanly',
      title: 'The confirmation is asked, declining keeps the session, confirming ends it',
      ok:
        askedOnDecline?.kind === 'close-session' &&
        survivedDecline &&
        tabAfterDecline &&
        died &&
        tabGone &&
        recorded &&
        row?.status === 'exited' &&
        row.durationMs !== null,
      detail: {
        pid,
        asked: collector.asked().map((a) => ({ kind: a.kind, message: a.message })),
        survivedDecline,
        tabAfterDecline,
        died,
        tabGone,
        recorded,
        row
      },
      notes: [
        'The dialog itself is a native message box; the driver answers it through the same',
        'injection point, so both answers are exercised rather than one being left hanging.'
      ]
    })
  }

  // -------------------------------------------------------------------------
  // SESS-10: the branch is on the tab, and it is the branch git says
  // -------------------------------------------------------------------------
  //
  // The subtitle slot was empty in exactly the case that needs it: several
  // sessions on one project, where every tab reads the profile's name and a
  // counter. What fills it is the branch the session started on, and this
  // compares the second line of every session tab with this driver's own
  // `git rev-parse` against the same directory.
  const branchExpected = new Map(projects.map((p) => [p.path, branchOf(p.path)]))
  const branchRows = readSessions(ctx.services.store, { limit: 50 })
  const branchTabs: Array<{
    id: number
    cwd: string
    expected: string | null
    subtitle: string | null
    column: string | null
  }> = []
  for (const session of ctx.sessions.list()) {
    const text = await tabText(win, session.id)
    branchTabs.push({
      id: session.id,
      cwd: session.cwd,
      expected: branchExpected.get(session.cwd) ?? branchOf(session.cwd),
      subtitle: text?.subtitle ?? null,
      column: branchRows.find((r) => r.id === session.id)?.branch ?? null
    })
  }
  // The fixture rule: if none of the projects this run picked is a repository on
  // a named branch, every comparison below is `null === null` and the criterion
  // is satisfied by having measured nothing (CLAUDE.md, PROF-4).
  const discriminating = branchTabs.some((t) => t.expected !== null && t.expected !== '')

  checks.push({
    id: 'SESS-10',
    criterion: 'Sessions on one project are told apart in the strip without hovering',
    title: "A session tab's second line is the branch its cwd was on, as git reports it",
    ok:
      branchTabs.length > 0 &&
      discriminating &&
      branchTabs.every((t) => t.column === t.expected) &&
      branchTabs.every((t) => t.expected === null || t.subtitle === t.expected),
    detail: { tabs: branchTabs, discriminating },
    notes: discriminating
      ? [
          'Checked against `git rev-parse`, run by this driver - not against the',
          '`git symbolic-ref` in core that wrote the column.'
        ]
      : ['No project this run picked is on a named branch, so nothing here discriminates.']
  })

  // -------------------------------------------------------------------------
  // SESS-11: renaming a tab, and what a rename must not touch
  // -------------------------------------------------------------------------
  const renameTarget = ctx.sessions.list().find((s) => s.status === 'running')
  let renamed: { id: number; label: string; name: string } | null = null

  if (renameTarget) {
    await clickSessionTab(win, renameTarget.id)
    await sleep(400)

    // The gesture, not the channel: double-click the title, type, Enter.
    const opened = await openRename(win, renameTarget.id)
    await sleep(400)
    const beforeTyping = await renameState(win, renameTarget.id)

    // Real keystrokes through Chromium, which is also what makes the next
    // assertion mean something: they land wherever the focus is.
    const writesBefore = pty.count()
    await typeText(win, 'PR review')
    const typed = await renameState(win, renameTarget.id)
    const writesWhileEditing = pty.count() - writesBefore

    // The other half of the constraint: an open edit has to survive the pane
    // behind it repainting. Written straight to the pty from here, so the TUI
    // redraws without anything going near the window's focus - which is the
    // shape of the bug this guards against, a pane that grabs its terminal back
    // on every render rather than only when it becomes the visible one.
    const outputBefore = collector.output(renameTarget.id).length
    ctx.sessions.input(renameTarget.id, 'a session that is busy printing')
    // A low bar on purpose. The claim is that the pane repainted underneath the
    // edit, and a TUI echoing a typed line is tens of bytes, not hundreds -
    // measured at 77 for this string. What must not pass is a *silent* session,
    // where "the edit survived the output" would be satisfied by there having
    // been none.
    const outputGrew = await waitFor(
      () => collector.output(renameTarget.id).length > outputBefore + 16,
      15_000
    )
    await sleep(500)
    const duringOutput = await renameState(win, renameTarget.id)

    await sendKey(win, 'Enter')
    await sleep(600)

    const afterTab = await tabText(win, renameTarget.id)
    const afterRow = readSessions(ctx.services.store, { limit: 50 }).find(
      (r) => r.id === renameTarget.id
    )
    const afterHosted = ctx.sessions.list().find((s) => s.id === renameTarget.id)

    // The dialog that ends it has to call it what the tab calls it. Declined,
    // so the session is still here for the phases below.
    collector.answerWith(false)
    await clickCloseTab(win, renameTarget.id)
    await sleep(1200)
    const asked = collector.asked().at(-1)

    checks.push({
      id: 'SESS-11',
      criterion: 'Renaming is reachable from the tab, persists, and never rewrites the CLI name',
      title: 'Double-click renames the tab; the row keeps the name that went to `-n`',
      ok:
        opened &&
        beforeTyping.open &&
        beforeTyping.focused &&
        typed.value === 'PR review' &&
        // The caret was in the field, so nothing reached the pty. This is the
        // "does it swallow what the terminal wants" question, answered by
        // counting the writes rather than by reasoning about focus.
        writesWhileEditing === 0 &&
        // Required, not merely observed: without the pane having actually
        // repainted, "the edit survived it" is satisfied by nothing happening.
        outputGrew &&
        duringOutput.focused &&
        duringOutput.value === 'PR review' &&
        afterTab?.title === 'PR review' &&
        afterRow?.label === 'PR review' &&
        afterRow.name === renameTarget.name &&
        afterRow.name !== 'PR review' &&
        afterHosted?.label === 'PR review' &&
        (asked?.message.includes('PR review') ?? false),
      detail: {
        opened,
        beforeTyping,
        typed,
        writesWhileEditing,
        outputGrew,
        outputBytes: collector.output(renameTarget.id).length - outputBefore,
        duringOutput,
        tab: afterTab,
        row: afterRow && { name: afterRow.name, label: afterRow.label, argv: afterRow.argv },
        spawnedAs: renameTarget.name,
        confirmMessage: asked?.message ?? null
      },
      notes: [
        '`-n <name>` is in the argv of a process that is already running; the label is',
        'Helm’s own and is what the tab, the tree and this dialog all read.'
      ]
    })

    // And the field gives the CLI name back when it is emptied, which is the
    // only way out of a rename someone regrets.
    await openRename(win, renameTarget.id)
    await sleep(400)
    // The field selects itself on focus, so one Backspace empties it.
    await sendKey(win, 'Backspace')
    await sendKey(win, 'Enter')
    await sleep(600)
    const cleared = await tabText(win, renameTarget.id)
    const clearedRow = readSessions(ctx.services.store, { limit: 50 }).find(
      (r) => r.id === renameTarget.id
    )

    checks.push({
      id: 'SESS-12',
      criterion: 'Renaming is reachable from the tab, persists, and never rewrites the CLI name',
      title: 'Clearing the field puts the CLI name back rather than leaving a tab with no title',
      ok: cleared?.title === renameTarget.name && clearedRow?.label === null,
      detail: { tab: cleared, label: clearedRow?.label ?? null, name: renameTarget.name },
      notes: ['An empty label is stored as null, not as an empty string.']
    })

    // Put it back, so the restart phase has a label to find.
    ctx.sessions.rename({ id: renameTarget.id, label: 'PR review' })
    await sleep(300)
    renamed = { id: renameTarget.id, label: 'PR review', name: renameTarget.name }
  }

  // -------------------------------------------------------------------------
  // SESS-13: the counter is not recycled onto a dead tab's label
  // -------------------------------------------------------------------------
  //
  // `background` ended with /exit and its tab is still open, which is the whole
  // point - the scrollback is the record of what happened. Launching against the
  // same project again used to hand the new session the dead one's name, because
  // uniqueness was computed against the *running* rows. Two tabs then read the
  // same thing and pointed at different work.
  if (background) {
    const project = projects.find((p) => p.path === background.cwd)
    const deadTabStillOpen = (await tabOrder(win)).includes(`session:${String(background.id)}`)
    const deadRow = readSessions(ctx.services.store, { limit: 50 }).find(
      (r) => r.id === background.id
    )

    if (project) {
      const before = ctx.sessions.list().length
      await clickByTitle(win, project.path)
      await sleep(300)
      await clickButton(win, 'Start session here')
      await waitFor(() => ctx.sessions.list().length > before, 20_000)
      const replacement = ctx.sessions.list().at(-1) ?? null
      await sleep(600)

      const stripLabels = await js<string[]>(
        win,
        `[...document.querySelectorAll('[role="tab"][data-tab^="session:"]')].map((t) => {
           const sub = t.querySelector('[data-tab-subtitle]');
           const title = sub ? sub.previousElementSibling : t.querySelector('span span');
           return title ? title.textContent : ''
         })`
      )

      checks.push({
        id: 'SESS-13',
        criterion: 'No recycled label points at different work',
        title: 'A session started beside an ended one does not inherit its name',
        ok:
          deadTabStillOpen &&
          deadRow?.status === 'exited' &&
          replacement !== null &&
          replacement.id !== background.id &&
          replacement.name !== background.name &&
          // And nothing in the strip is wearing the same label as anything else.
          new Set(stripLabels).size === stripLabels.length,
        detail: {
          ended: { id: background.id, name: background.name, status: deadRow?.status },
          deadTabStillOpen,
          started: replacement && { id: replacement.id, name: replacement.name },
          stripLabels
        },
        notes: [
          'The set of names a launch must avoid is the set of tabs, not the set of live',
          'processes: a tab outlives its process on purpose.'
        ]
      })
    }
  }

  // What the restart phase has to find. Written before the teardown below,
  // because "the label survived a restart" is not a claim this process can make.
  writeFileSync(
    join(dataDir, 'sessions-phase1.json'),
    JSON.stringify({ renamed, branches: branchTabs }, null, 2),
    'utf8'
  )

  // -------------------------------------------------------------------------
  // SESS-7: teardown leaves nothing behind
  // -------------------------------------------------------------------------
  const trees = new Map<number, number[]>()
  for (const session of ctx.sessions.list()) {
    const pid = ctx.sessions.pid(session.id)
    if (pid !== null && processAlive(pid)) trees.set(session.id, descendants(pid))
  }
  const watched = [...trees.values()].flat()

  ctx.sessions.shutdown()
  await sleep(3000)
  const survivors = watched.filter(processAlive)

  checks.push({
    id: 'SESS-7',
    criterion: 'Killing the app does not leave orphaned claude/conpty processes',
    title: 'Shutdown terminates every session process and its children',
    ok: watched.length > 0 && survivors.length === 0,
    detail: {
      trees: [...trees.entries()].map(([id, pids]) => ({ id, pids })),
      watched: watched.length,
      survivors
    },
    notes: [
      'Trees, not pids: node-pty falls back to killing the shell alone on Windows (Spike C #8).'
    ]
  })

  const rows = readSessions(ctx.services.store, { limit: 50 })
  checks.push({
    id: 'SESS-8',
    criterion: 'Exit code and duration of each session recorded in SQLite',
    title: 'Every session from this run left a completed row',
    ok:
      started.length > 0 &&
      started.every((s) => {
        const row = rows.find((r) => r.id === s.id)
        return row !== undefined && row.status === 'exited' && row.durationMs !== null
      }),
    detail: {
      rows: rows
        .filter((r) => started.some((s) => s.id === r.id))
        .map((r) => ({
          id: r.id,
          name: r.name,
          status: r.status,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          argv: r.argv
        }))
    },
    notes: ['`-n <name>` in argv is what makes a session findable in /resume later.']
  })

  // -------------------------------------------------------------------------
  // SESS-9: hand a live session to the app's own quit path
  // -------------------------------------------------------------------------
  //
  // SESS-7 proves the teardown function reaps a process tree. This proves the app
  // actually calls it when it quits, which is a different claim and the one the
  // acceptance criterion is about. It cannot be asserted from inside the
  // process that is about to end, so the pids are published and checked by
  // `scripts/verify-orphans.mjs` after this one exits.
  const handoff = projects[0]
  if (handoff) {
    const record = await ctx.sessions.start({
      cwd: handoff.path,
      projectPath: handoff.path,
      name: 'quit path',
      cols: 100,
      rows: 30
    })
    // Long enough for the CLI to be a tree rather than a single process.
    await sleep(10_000)
    const pid = ctx.sessions.pid(record.id)
    const tree = pid !== null && processAlive(pid) ? descendants(pid) : []

    checks.push({
      id: 'SESS-9',
      criterion: 'Killing the app does not leave orphaned claude/conpty processes',
      title: 'A live session is left for the app quit path to reap',
      ok: tree.length > 0,
      detail: { session: record.id, name: record.name, pid, pids: tree },
      notes: [
        'This check only sets the trap. Whether it caught anything is decided by',
        'scripts/verify-orphans.mjs, which runs once this process has exited.'
      ]
    })
  }

  return checks
}

/**
 * The second app start: does a tab's name outlive the app that gave it one.
 *
 * A phase of its own for the reason `transcript-check`'s T-7 and
 * `settings-check`'s second half have one - the process that wrote the label
 * cannot say whether it survived, because everything it would read the answer
 * out of is the state it is holding. So phase one writes down what it renamed,
 * `run-sessions.mjs` starts the app again, and this reads the row back from the
 * database on disk.
 *
 * There is no tab to look at here, and that is the honest shape: sessions do not
 * outlive the app - `before-quit` ends them. What has to survive is the *label*,
 * so that reopening the same conversation, or reading the log, still finds the
 * name a person gave it. And the row still has to carry the name the CLI was
 * given, because that one is a fact about a process that already ran.
 */
export async function runSessionsRestartChecks(
  ctx: CheckContext,
  dataDir: string
): Promise<Check[]> {
  interface PhaseOne {
    renamed: { id: number; label: string; name: string } | null
    branches: Array<{ id: number; expected: string | null; column: string | null }>
  }

  const phaseOnePath = join(dataDir, 'sessions-phase1.json')
  const phaseOne = ((): PhaseOne | null => {
    try {
      return JSON.parse(readFileSync(phaseOnePath, 'utf8')) as PhaseOne
    } catch {
      return null
    }
  })()

  if (phaseOne?.renamed == null) {
    return [
      {
        id: 'SESS-14',
        criterion: 'What tells sessions apart survives a restart of the app',
        title: 'Phase one recorded no rename for this phase to look for',
        ok: false,
        detail: { expected: phaseOnePath, phaseOne },
        notes: ['Without it there is nothing to read back, which is a failure, not a skip.']
      }
    ]
  }

  const { id, label, name } = phaseOne.renamed
  const rows = readSessions(ctx.services.store, { limit: 500 })
  const row = rows.find((r) => r.id === id)

  // Nothing this process started may be wearing it either: a label belongs to
  // one row, and a restart is the other way a counter could hand it on.
  const elsewhere = rows.filter((r) => r.id !== id && r.label === label).map((r) => r.id)

  const branchesKept = (phaseOne.branches ?? []).every(
    (b) => rows.find((r) => r.id === b.id)?.branch === b.column
  )

  return [
    {
      id: 'SESS-14',
      criterion: 'What tells sessions apart survives a restart of the app',
      title: 'A renamed session is still renamed after the app has been started again',
      ok:
        row !== undefined &&
        row.label === label &&
        row.name === name &&
        row.name !== label &&
        elsewhere.length === 0 &&
        branchesKept,
      detail: {
        id,
        expected: { label, name },
        found: row && { label: row.label, name: row.name, branch: row.branch, status: row.status },
        alsoWearingTheLabel: elsewhere,
        branchesKept
      },
      notes: [
        'Read in a second process from the file the first one wrote. The session itself',
        'is gone - `before-quit` ended it - and the label is what had to survive.'
      ]
    }
  ]
}
