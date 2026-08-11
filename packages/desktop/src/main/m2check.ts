import { type BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { readSessions, type Project, type SessionRecord } from '@helm/core'
import { screenshot, sleep, squash, stripAnsi, waitFor } from './bridge'
import type { ConfigService } from './config'
import type { ContentService } from './content'
import type { Check } from './fidelity'
import type { HistoryService } from './history'
import type { Confirm, ConfirmRequest, SessionHost, SessionObserver } from './sessions'
import type { Services } from './services'
import type { UsageService } from './usage'

/**
 * M2's acceptance criteria, driven through the app the way a user reaches them.
 *
 * Everything here goes through the real surface: sidebar rows are clicked, the
 * launch button is clicked, tabs are switched by clicking tabs. The alternative
 * - calling the session host directly - would prove the main process works and
 * say nothing about whether the thing on screen is wired to it.
 *
 * `pnpm m2-check` -> helm-data/m2-report.json
 */

export interface M2Context {
  win: BrowserWindow
  services: Services
  sessions: SessionHost
  /** M4's driver reads and forces passes through this; M2's ignores it. */
  history: HistoryService
  /** M5's driver reads and writes config through this; nothing else uses it. */
  config: ConfigService
  /** M6's driver reads, renders and searches content through this. */
  content: ContentService
  /**
   * The usage reader. `usage-check` points it at fixtures through this: it is
   * the only way to prove a reshaped `cachedUsageUtilization` paints nothing,
   * and it is deliberately not reachable from the window.
   */
  usage: UsageService
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

export async function runM2Checks(
  ctx: M2Context,
  collector: Collector,
  shotDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx

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
      id: 'M2-0',
      criterion: 'setup',
      title: 'Discovery found at least three projects to launch against',
      ok: false,
      detail: { scanned, painted, found: projects.length },
      notes: ['Nothing else can run without three projects, so the rest is skipped.']
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // M2-1: three concurrent sessions, three different repos
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
  const shot1 = await screenshot(win, shotDir, 'm2-three-sessions.png')

  checks.push({
    id: 'M2-1',
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
  // M2-2: a backgrounded pane keeps its grid
  // -------------------------------------------------------------------------
  const gridsBefore = started.map((s) => ctx.sessions.grid(s.id))
  for (const index of [0, 3, 5, 1]) {
    await clickTabAt(win, index)
    await sleep(250)
  }
  await clickSessionTab(win, started[0]?.id ?? -1)
  await sleep(700)
  const gridsAfter = started.map((s) => ctx.sessions.grid(s.id))
  const shot2 = await screenshot(win, shotDir, 'm2-after-tab-switching.png')

  checks.push({
    id: 'M2-2',
    criterion: 'Resize works per Spike C, in an app layout rather than a bare page',
    title: 'A backgrounded pane keeps its grid instead of fitting to a 1x1 box',
    ok: gridsAfter.every((grid) => grid !== null && grid.cols > 20 && grid.rows > 5),
    detail: { gridsBefore, gridsAfter, screenshot: shot2.file },
    notes: [
      'A hidden container measures 0x0, and FitAddon turns that into a 1x1 grid the pty acts on.'
    ]
  })

  // -------------------------------------------------------------------------
  // M2-3: reordering the tab strip
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
    id: 'M2-3',
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
  // M2-4 / M2-5: a session that ends on its own
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
    const shot3 = await screenshot(win, shotDir, 'm2-session-ended.png')
    const bannerText = await js<string>(
      win,
      `(() => { const el = document.querySelector('[role="status"]');
        return el ? (el.textContent ?? '').trim() : '' })()`
    )

    checks.push({
      id: 'M2-4',
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
      id: 'M2-5',
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
  // M2-6: closing a tab whose session is alive asks first
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
      id: 'M2-6',
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
  // M2-7: teardown leaves nothing behind
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
    id: 'M2-7',
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
    id: 'M2-8',
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
  // M2-9: hand a live session to the app's own quit path
  // -------------------------------------------------------------------------
  //
  // M2-7 proves the teardown function reaps a process tree. This proves the app
  // actually calls it when it quits, which is a different claim and the one the
  // acceptance criterion is about. It cannot be asserted from inside the
  // process that is about to end, so the pids are published and checked by
  // `scripts/verify-orphans.mjs` after this one exits.
  const handoff = projects[0]
  if (handoff) {
    const record = ctx.sessions.start({
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
      id: 'M2-9',
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
