import { type BrowserWindow } from 'electron'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  describeSessionDetail,
  heldBy,
  noProcessSnapshot,
  prepareLaunch,
  readSessionRegistry,
  readSessions,
  sessionResources,
  SESSION_SPLIT_PCT,
  type Project,
  type ProcessSnapshot,
  type SessionRecord
} from '@helm/core'
import {
  drag,
  readPointerTrace,
  screenshot,
  sendKey,
  sleep,
  squash,
  stripAnsi,
  tracePointer,
  typeText,
  waitFor,
  type PointerTrace
} from './bridge'
import type { BrowserHost } from './browser'
import { createBrowserMcp, MCP_SERVER_NAME, type BrowserMcpHost } from './browser-mcp'
import { SESSION_TOOLS_PATH, SESSION_TOOLS_SERVER_NAME } from './session-tools'
import { mcpConfigDir } from './paths'
import type { ConfigService } from './config'
import type { ContentService } from './content'
import type { Check } from './fidelity'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import type { PtermHost } from './pterm'
import type { PullsService } from './pulls'
import { createActivityService, type ActivityService } from './activity'
import { createResourcesService, type ResourcesService } from './resources'
import { readProcessSnapshot } from './processes'
import { resolveClaudeCommand, setClaudeOverride } from './claude-cli'
import { spawnSession } from './pty'
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
   * What each hosted session says it is doing, out of Claude Code's own
   * registry. The `state` group reads the raw records through this - the
   * window has no route to them, and asserting only on the dot would leave
   * "the tab is wrong" and "the registry said that" as one red line.
   */
  activity: ActivityService
  /**
   * What each hosted session is holding: its process tree and its ports.
   *
   * The `resources` group drives the pass through this rather than through the
   * pane, because the pass is main's and because arranging a machine - a tree
   * that could not be read, a socket query that failed - means handing over a
   * snapshot the window has no way to produce.
   */
  resources: ResourcesService
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
  /**
   * The browser pane's views. `browser-check` reads the bounds Electron
   * actually holds, captures a hidden view and drives it with synthesised
   * input through this - none of which the window has any route to, because a
   * `WebContentsView` is not in the DOM at all.
   */
  browsers: BrowserHost
  /**
   * Helm's browser endpoint. `browser-check` registers with it as though it
   * were a session and then speaks MCP to it over the wire, which is the only
   * way to exercise the tools independently of `claude`. Null where the app
   * started with `browserMcp` off - which is itself one of the things the check
   * asserts.
   */
  browserMcp: BrowserMcpHost | null
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

/**
 * The two halves of this driver, as `--only=` names them.
 *
 * `lifecycle` is everything this check has always been - launching, tabs,
 * renaming, teardown - and it is one group rather than several because its
 * probes share three sessions and a strip they build up in order; splitting it
 * would be inventing seams that are not there.
 *
 * `state` is the session-activity indicator, and it launches a session of its
 * own precisely so that it does not depend on that arrangement. It is the one
 * worth narrowing to: `--only=state` is one session and about a minute.
 *
 * `resources` is the sessions pane and the launch warning - what each session
 * is *holding*, and every live session on the machine. Three sessions, one of
 * them on a pty of this driver's own outside Helm, and **no model turns at
 * all**: nothing in it submits a prompt.
 *
 * `tools` is the other side of the same data: what a session Helm hosts may be
 * *told* about the other sessions, over the MCP endpoint. Two sessions, both on
 * haiku, one model turn each - one of them is a real `claude` asked to report
 * on the other, which is the only way to exercise the whole chain from
 * `--mcp-config` to an answer. About four minutes, most of it waiting on that
 * one turn; everything else goes over the wire as those sessions.
 */
export const GROUPS = ['lifecycle', 'state', 'resources', 'tools'] as const
export type SessionsGroup = (typeof GROUPS)[number]

export async function runSessionsChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string,
  dataDir: string,
  only?: string[]
): Promise<Check[]> {
  const wants = (group: SessionsGroup): boolean =>
    only === undefined || only.length === 0 || only.includes(group)

  const checks: Check[] = []
  // In this order, and `state` last: `lifecycle` ends by leaving a live session
  // for the app's own quit path to reap (SESS-9), and anything running after
  // that would be running beside a trap that has already been set.
  if (wants('lifecycle')) {
    checks.push(...(await runLifecycleChecks(ctx, collector, shotDir, dataDir)))
  }
  if (wants('state')) checks.push(...(await runStateChecks(ctx, collector, shotDir)))
  /*
   * `tools` before `resources`, and the order is load-bearing rather than
   * arbitrary.
   *
   * `runResourcesChecks` ends by calling `ctx.resources.stop()`, which is a
   * **permanent** teardown of the service the whole app shares - it sets a flag
   * no `watch` clears. The session-detail tool takes a watch on that same
   * service to measure a session's tree, so a `tools` group running after it
   * would get "unknown - Helm has not looked" for every session and would be
   * measuring a stopped service rather than the tool.
   *
   * It fails loudly rather than quietly if this is ever reordered: SESS-29
   * requires the pass to have actually run, and reports `passRan: false` when it
   * has not. If that is what a red line says, look here first.
   */
  if (wants('tools')) checks.push(...(await runToolsChecks(ctx, collector, shotDir)))
  // After `state`, which kills a session out from under the app to prove a
  // stale record is never believed - a group that shares the machine with that
  // would be reading a registry mid-provocation.
  if (wants('resources')) checks.push(...(await runResourcesChecks(ctx, collector, shotDir)))
  return checks
}

async function runLifecycleChecks(
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
      // audit: optional - only reached when the tree never painted three
      // projects, so a healthy run has no SESS-0.
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

  // -------------------------------------------------------------------------
  // SESS-15: the workspace divider is dragged, for the first time ever
  // -------------------------------------------------------------------------
  //
  // This divider is older than every other draggable thing in Helm and until
  // now nothing had ever exercised it. The one driver that touched it -
  // `design-shot`'s `dragSplit` - sent its moves with no button held, which
  // Chromium delivers as `buttons: 0`, a hover; the divider's handler read
  // `clientX` off whatever arrived and never asked, so it moved, and the whole
  // arrangement looked correct from both ends.
  //
  // Three things are asserted, and the third is the one that is easy to leave
  // out. The gesture *arrived* (from `tracePointer`, so "the app ignored it"
  // and "it was never delivered" cannot be the same red line). The pane ended
  // where the pointer left it. And **the pane tracked the pointer while the
  // button was still down** - measured between moves, not after the release.
  //
  // That last one is not pedantry. A fix for this divider's stutter was written
  // and reverted on 2026-08-13; its end state was correct and only its
  // *middle* was broken - the pane lagged, and shrank from the wrong edge,
  // and snapped into place on release. Every assertion that looked at the
  // finished state passed it.
  {
    const DIVIDER = '[role="separator"][aria-orientation="vertical"]'
    const sessionsColumnWidth = `(() => {
      const sep = document.querySelector(${JSON.stringify(DIVIDER)})
      const col = sep?.nextElementSibling
      return col ? col.getBoundingClientRect().width : null
    })()`

    // The session history in the workspace half, which is the state the stutter
    // was reported in and the only one that discriminates: 900-odd rows is
    // enough that reconciling them per frame is felt, where a project pane is
    // not. Its own list is what the observer below watches.
    await js<boolean>(
      win,
      `(() => { const el = document.querySelector('[data-open-history]')
        if (!el) return false; el.click(); return true })()`
    )
    await pollJs(win, `document.querySelector('[data-history-search]')`, 15_000)
    await sleep(1200)
    const historyRows = await js<number>(
      win,
      `document.querySelectorAll('button[data-session]').length`
    )

    // The split is put back to its default before the divider is measured.
    //
    // The seeded database carries the developer's own `sessionSplitPct`, and
    // the drag below is a fixed 15% of the row - so on a machine where somebody
    // has parked the split at 75 the pane has 5 points of headroom, hits
    // `SESSION_SPLIT_PCT.max` a third of the way through, and the probe reports
    // a divider that stopped following the pointer. Measured here at exactly
    // that: 726px to 774.4px against 146px of travel, with the app behaving
    // perfectly. The starting position is not what this probe is about, so it
    // is chosen rather than inherited.
    await js<unknown>(
      win,
      `window.helm.invoke('settings:write', { sessionSplitPct: ${String(SESSION_SPLIT_PCT.default)} })`
    ).catch(() => null)
    await sleep(400)

    const grip = await js<{ x: number; y: number; width: number; left: number } | null>(
      win,
      `(() => {
         const el = document.querySelector(${JSON.stringify(DIVIDER)})
         if (!el) return null
         const b = el.getBoundingClientRect()
         const row = el.parentElement.getBoundingClientRect()
         return { x: b.left + b.width / 2, y: b.top + b.height / 2, width: row.width, left: row.left }
       })()`
    ).catch(() => null)

    let dragResult: {
      before: number | null
      during: Array<{ width: number | null; pointerX: number }>
      mutations: string[]
      nearby: number
      after: number | null
      pointer: PointerTrace
    } | null = null

    if (grip !== null) {
      const before = await js<number | null>(win, sessionsColumnWidth)
      // Left, which makes the sessions column - the one on the right of the
      // divider - wider. Far enough to be past any rounding and short of the
      // 20% bound so the pane is free to follow the whole way.
      const to = { x: grip.x - Math.round(grip.width * 0.15), y: grip.y }
      const during: Array<{ width: number | null; pointerX: number }> = []

      /**
       * Watch the two columns' **own attributes** while the boundary moves.
       *
       * This is the mechanism assertion, and it is the one that would have
       * caught both previous attempts at this. The fraction lives in a
       * `--split` custom property on the row; nothing in the render tree reads
       * it; so a drag changes the columns' computed width without writing
       * anything to either element. The first implementation set React state
       * per `mousemove` and rewrote both columns' inline `style` every frame.
       * The second wrote `column.style.flex` from a ref while React went on
       * writing the same property from its render - two writers for one value,
       * which is why the pane fought the pointer and lost.
       *
       * **The columns themselves, not their subtrees.** The first version of
       * this probe watched the whole workspace subtree and failed on five
       * mutations that had nothing to do with the drag: `name` and `type` on
       * the history pane's search field and scope checkboxes, which is that
       * pane still settling a second after being opened. A probe that goes red
       * for something happening nearby is the shape this suite has just spent
       * a task removing, so what is asserted is the narrow claim that
       * discriminates - the drag did not write to either column - and the
       * subtree is *counted* and reported beside it rather than asserted.
       */
      await js<void>(
        win,
        `(() => {
           const sep = document.querySelector(${JSON.stringify(DIVIDER)})
           const columns = [sep?.previousElementSibling, sep?.nextElementSibling]
           window.__splitMutations = []
           window.__splitNearby = 0
           window.__splitObservers = []
           for (const el of columns) {
             if (!el) continue
             const own = new MutationObserver((records) => {
               for (const r of records) {
                 window.__splitMutations.push(
                   (r.attributeName ?? r.type) + ' on ' + r.target.nodeName +
                   '.' + ((r.target.className ?? '') + '').slice(0, 32)
                 )
               }
             })
             own.observe(el, { attributes: true })
             window.__splitObservers.push(own)

             const near = new MutationObserver((records) => {
               window.__splitNearby += records.length
             })
             near.observe(el, {
               attributes: true, childList: true, characterData: true, subtree: true
             })
             window.__splitObservers.push(near)
           }
           return undefined
         })()`
      )

      await tracePointer(win, DIVIDER)
      await drag(win, { x: grip.x, y: grip.y }, to, {
        steps: 6,
        onStep: async (i) => {
          // A frame has to be allowed to happen between the move and the read,
          // or this measures the event queue rather than the pane. The reverted
          // fix's own probe fired thirty moves in one synchronous loop for
          // exactly this reason and learned nothing about the drag.
          await sleep(90)
          during.push({
            width: await js<number | null>(win, sessionsColumnWidth),
            pointerX: grip.x + ((to.x - grip.x) * i) / 6
          })
        }
      })
      await sleep(400)
      // Read before the release settles, so a mutation caused by the settings
      // write coming back is not counted against the gesture - that one is a
      // render, and one render after a drag is the point of writing once.
      const watched = await js<{ mutations: string[]; nearby: number }>(
        win,
        `(() => {
           const seen = window.__splitMutations ?? []
           const nearby = window.__splitNearby ?? 0
           for (const o of window.__splitObservers ?? []) o.disconnect()
           delete window.__splitObservers
           delete window.__splitMutations
           delete window.__splitNearby
           return { mutations: seen, nearby }
         })()`
      )
      dragResult = {
        before,
        during,
        mutations: watched.mutations,
        nearby: watched.nearby,
        after: await js<number | null>(win, sessionsColumnWidth),
        pointer: await readPointerTrace(win)
      }
    }

    const r = dragResult
    // Delivered: a press, the six moves, a release - and the last move carried
    // the button. `buttons: 0` here is the bug this whole probe exists for.
    const arrived =
      r !== null && r.pointer.down === 1 && r.pointer.move >= 6 && r.pointer.up === 1 && r.pointer.buttons === 1
    // Landed: the column grew by about what the pointer travelled.
    const travelled = grip === null ? 0 : Math.round(grip.width * 0.15)
    const landed =
      r !== null &&
      r.before !== null &&
      r.after !== null &&
      Math.abs(r.after - r.before - travelled) <= 8
    // Tracked: every mid-gesture reading is already most of the way to where
    // that step's pointer was, rather than all of them sitting at the start and
    // jumping at the end. 12px of slack per step for rounding and the bound.
    const midGesture = r?.during.filter((d) => d.width !== null) ?? []
    const tracked =
      r !== null &&
      r.before !== null &&
      midGesture.length >= 5 &&
      midGesture.every(
        (d) => Math.abs((d.width ?? 0) - (r.before ?? 0) - (grip === null ? 0 : grip.x - d.pointerX)) <= 12
      )

    // Neither column was written to in order to move the boundary between
    // them. The floor on the row count is what makes it worth saying: on a
    // machine with six sessions, a reconcile of six rows also writes nothing
    // anybody would notice.
    const wroteToNeitherColumn = r !== null && r.mutations.length === 0
    const listDiscriminates = historyRows >= 50

    checks.push({
      id: 'SESS-15',
      criterion: 'The split between the workspace and the sessions is draggable',
      title: `A real drag on the workspace divider moves the pane, keeps up with the pointer, and rebuilds none of the ${String(historyRows)} rows beside it`,
      ok: arrived && landed && tracked && wroteToNeitherColumn && listDiscriminates,
      detail: {
        grip,
        travelledPx: travelled,
        historyRowsInTheWorkspaceHalf: historyRows,
        ...(r ?? { note: 'no divider on screen - a workspace pane and a session must both be open' })
      },
      notes: [
        'Driven with `drag()`, which holds the button for the moves in the middle.',
        'Written out as bare `sendMouse` calls this sends hovers, and this',
        'divider answered those for as long as it has existed.',
        '`tracked` is the claim about the middle of the gesture and the reason',
        'there is a sleep inside the drag: a frame has to render between the',
        'move and the measurement. A probe that only reads the finished state',
        'passes a drag that lags the pointer and snaps on release.',
        '`pointer.buttons` is the positive control - 0 means the driver sent a',
        'hover and nothing below this line is evidence of anything.',
        'The mutation count is the mechanism, and the session history is open',
        'behind it so that it means something: the boundary is a `--split`',
        'custom property nothing in the render tree reads, so moving it must',
        'leave the pane beside it completely untouched. Setting React state per',
        'move instead rewrote the column`s inline style every frame and',
        'reconciled every row in that list to produce the rows already there.'
      ]
    })
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

// ---------------------------------------------------------------------------
// The state group: what a live session says it is doing, and what the tab paints
// ---------------------------------------------------------------------------

/** `~/.claude`, resolved by this driver rather than asked of the app. */
function claudeHomeHere(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override !== undefined && override.trim() !== '' ? override : join(homedir(), '.claude')
}

/**
 * A digest of the registry directory - names, sizes and bytes.
 *
 * `transcript-check`'s T-5 shape: the claim "Helm only reads this tree" is
 * settled by hashing it either side of a full pass, and the hash is this
 * driver's own so it is not the code under test agreeing with itself.
 */
function hashRegistryDir(dir: string): {
  digest: string
  files: string[]
  bytes: Map<string, string>
} {
  const hash = createHash('sha256')
  const bytes = new Map<string, string>()
  let names: string[] = []
  try {
    names = readdirSync(dir).sort()
  } catch {
    // No directory is a real state, and a stable one: it hashes to the empty
    // digest either side, which is exactly the claim being made about it.
  }
  for (const name of names) {
    hash.update(name)
    try {
      const body = readFileSync(join(dir, name))
      hash.update(body)
      bytes.set(name, createHash('sha256').update(body).digest('hex'))
    } catch {
      hash.update('<unreadable>')
      bytes.set(name, 'unreadable')
    }
  }
  return { digest: hash.digest('hex'), files: names, bytes }
}

/** What the tab is actually painting, measured rather than asked of React. */
interface PaintedDot {
  label: string | null
  background: string
  borderWidth: string
  borderColor: string
  tokens: Record<string, string>
}

async function paintedDot(win: BrowserWindow, id: number): Promise<PaintedDot | null> {
  return js<PaintedDot | null>(
    win,
    `(() => {
       const tab = document.querySelector('[data-tab="session:${String(id)}"]');
       const dot = tab && tab.querySelector('span[aria-hidden]');
       if (!dot) return null;
       const cs = getComputedStyle(dot);
       const root = getComputedStyle(document.documentElement);
       const token = (n) => root.getPropertyValue(n).trim();
       return {
         label: tab.getAttribute('aria-label'),
         background: cs.backgroundColor,
         borderWidth: cs.borderTopWidth,
         borderColor: cs.borderTopColor,
         tokens: {
           accent: token('--helm-accent'),
           warn: token('--helm-warn'),
           success: token('--helm-success'),
           danger: token('--helm-danger'),
           subtle: token('--helm-fg-subtle')
         }
       }
     })()`
  ).catch(() => null)
}

/** `#9184d9` as `rgb(145, 132, 217)`, so a token can be compared to a paint. */
function hexToRgb(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1]!, 16)
  return `rgb(${String((n >> 16) & 255)}, ${String((n >> 8) & 255)}, ${String(n & 255)})`
}

/**
 * Which token the dot is painted in, or null for a dot painted in none of them.
 *
 * Compared against the tokens as **CSS resolved them in the live window**, not
 * against hex written down here: a component and a check that both hard-coded
 * `#d9b36c` would agree with each other while the theme said something else.
 */
function toneOf(dot: PaintedDot): string | null {
  const filled = dot.background !== 'rgba(0, 0, 0, 0)' && dot.background !== 'transparent'
  const paint = filled ? dot.background : dot.borderColor
  for (const [name, hex] of Object.entries(dot.tokens)) {
    if (hexToRgb(hex) === paint) return filled ? name : `${name}-ring`
  }
  return null
}

/**
 * Poll until the app's own reading of a session's activity is `want`.
 *
 * Through `ctx.activity`, which is main's, because the state has to *be* that
 * before there is any point asking what the tab did with it - and a probe that
 * only watched the DOM could not tell "the session never got there" from "the
 * dot is wrong", which are two different bugs and one red line.
 */
async function waitForActivity(
  ctx: CheckContext,
  id: number,
  want: readonly string[],
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = ctx.activity.states().find((s) => s.id === id)
    if (state?.activity != null && want.includes(state.activity)) return state.activity
    await sleep(120)
  }
  return ctx.activity.states().find((s) => s.id === id)?.activity ?? null
}

/**
 * The session-activity indicator, end to end.
 *
 * One real session on one project, driven into three of the four states Claude
 * Code publishes and then killed out from under the app. Roughly a minute, and
 * one short model turn - the `busy` probe is the only thing here that costs
 * tokens, and it asks for a single word.
 *
 * `waiting` is provoked with a slash command that renders a UI, which costs
 * nothing and works whatever the machine's permission mode is. The *other* way
 * into `waiting` - a tool call awaiting approval, `waitingFor: "permission
 * prompt"` - is deliberately not driven here: it needs a session whose
 * permission mode is neither `auto` nor `bypassPermissions`, and `session:start`
 * has no way to ask for one. It was measured by hand instead, and the two
 * strings are pinned in `core/registry/registry.test.ts` against records the CLI
 * actually wrote.
 */
async function runStateChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx
  const registryDir = join(claudeHomeHere(), 'sessions')

  // Both, and in this order, for the reason the lifecycle group waits on both:
  // the tree paints from the cache before the first scan finishes, so a DOM
  // with rows in it is not yet a main process that knows what those rows are.
  // This group launches through the host rather than the button, so what it
  // actually needs is the scan - but it reads the tab out of the DOM, so it
  // needs the window up too.
  const scanned = await waitFor(() => pick(ctx.services).length >= 1, 120_000)
  await pollJs(win, `document.querySelectorAll('aside button[title]').length >= 1`, 30_000)
  const projects = pick(ctx.services)
  const project = projects[0]
  if (!scanned || !project) {
    checks.push({
      // audit: optional - only reached when discovery found nothing to launch.
      id: 'SESS-16-SKIP',
      criterion: 'setup',
      title: 'No project to launch a state-group session against',
      ok: false,
      detail: { scanned, projects: projects.length },
      notes: ['Discovery found nothing, so nothing in this group can run.']
    })
    return checks
  }

  // The names that were in the real registry before this group ran, so SESS-19
  // can say whether anything Helm-shaped appeared in it. Nothing here writes to
  // that directory, and the byte-for-byte half of the read-only claim is made
  // against a fixture registry instead - see SESS-19 for why.
  const baseline = hashRegistryDir(registryDir)

  // -------------------------------------------------------------------------
  // The session this group drives
  // -------------------------------------------------------------------------
  // Through the window, not through the host. A session started by calling
  // `ctx.sessions.start` exists as a process and a row and has **no tab**: the
  // strip is the renderer's, and it learns about a session from the answer to
  // its own `session:start`. That is not a detail - this whole group is about
  // what a tab paints, so a launch with no tab would measure nothing and the
  // dot would read as absent rather than wrong.
  const before = ctx.sessions.list().length
  await clickByTitle(win, project.path)
  await sleep(250)
  await clickButton(win, 'Start session here')
  await waitFor(() => ctx.sessions.list().length > before, 30_000)
  const record = ctx.sessions.list().at(-1)
  if (!record) {
    checks.push({
      // audit: optional - only reached when the launch button did not launch.
      id: 'SESS-16-SKIP',
      criterion: 'setup',
      title: 'The launch button started no session for the state group',
      ok: false,
      detail: { project: project.path },
      notes: ['Nothing in this group can run without a session in a tab.']
    })
    return checks
  }
  const stopGates = answerStartupGates(ctx, collector, [record.id])
  const ready = await waitFor(() => atPrompt(stripAnsi(collector.output(record.id))), 90_000)
  stopGates()
  await sleep(2000)
  const pid = ctx.sessions.pid(record.id)

  // -------------------------------------------------------------------------
  // SESS-16: the launch assigned a conversation id, and the registry agrees
  // -------------------------------------------------------------------------
  const assigned = record.claudeSessionId
  const flagIndex = record.argv.indexOf('--session-id')
  // This driver's own read of the directory, by hand, so the join is checked
  // against the file rather than against the reader that produced it.
  const ownRead = ((): { file: string; sessionId: unknown; pid: unknown } | null => {
    try {
      for (const name of readdirSync(registryDir)) {
        if (!name.toLowerCase().endsWith('.json')) continue
        const row: unknown = JSON.parse(readFileSync(join(registryDir, name), 'utf8'))
        if (typeof row !== 'object' || row === null) continue
        const bag = row as Record<string, unknown>
        if (assigned !== null && bag['sessionId'] === assigned) {
          return { file: name, sessionId: bag['sessionId'], pid: bag['pid'] }
        }
      }
    } catch {
      return null
    }
    return null
  })()

  const supported = assigned !== null
  checks.push({
    id: 'SESS-16',
    criterion: 'A session Helm launches can be joined to its record in Claude Code’s registry',
    title: 'The launch assigned a conversation id and the CLI registered under it',
    ok:
      ready &&
      supported &&
      flagIndex >= 0 &&
      record.argv[flagIndex + 1] === assigned &&
      ownRead !== null &&
      ownRead.pid === pid,
    detail: {
      session: record.id,
      assigned,
      argvCarriesFlag: flagIndex >= 0,
      argvValue: flagIndex >= 0 ? record.argv[flagIndex + 1] : null,
      registryFileFoundByOwnRead: ownRead?.file ?? null,
      registryPid: ownRead?.pid ?? null,
      ptyPid: pid
    },
    notes: supported
      ? [
          'Found by this driver reading ~/.claude/sessions itself and matching on',
          'the uuid Helm put in argv - not by asking the reader under test.'
        ]
      : [
          'The row carries no conversation id, which means this claude has no',
          '--session-id flag. That is a supported state (the join falls back to',
          'the pty pid), but it is not the state this probe is about.'
        ]
  })

  // -------------------------------------------------------------------------
  // SESS-17: the tab paints what the session says it is doing
  // -------------------------------------------------------------------------
  const painted: Record<string, { activity: string | null; tone: string | null; label: string | null }> = {}

  // Settled. A session at its prompt with nothing running is `idle`.
  const idleActivity = await waitForActivity(ctx, record.id, ['idle'], 60_000)
  await sleep(400)
  const idleDot = await paintedDot(win, record.id)
  painted['idle'] = {
    activity: idleActivity,
    tone: idleDot ? toneOf(idleDot) : null,
    label: idleDot?.label ?? null
  }

  // Waiting. A slash command that renders a UI, which costs no tokens.
  ctx.sessions.input(record.id, '/help\r')
  const waitingActivity = await waitForActivity(ctx, record.id, ['waiting'], 30_000)
  await sleep(400)
  const waitingDot = await paintedDot(win, record.id)
  const waitingFor = ctx.activity.states().find((s) => s.id === record.id)?.waitingFor ?? null
  painted['waiting'] = {
    activity: waitingActivity,
    tone: waitingDot ? toneOf(waitingDot) : null,
    label: waitingDot?.label ?? null
  }
  const waitingShot = await screenshot(win, shotDir, 'sessions-state-waiting.png')
  ctx.sessions.input(record.id, '\x1b')
  await waitForActivity(ctx, record.id, ['idle'], 30_000)

  // Busy. The one turn in this group that reaches the model.
  ctx.sessions.input(record.id, 'Reply with the single word: heron.')
  await sleep(1200)
  ctx.sessions.input(record.id, '\r')
  const busyActivity = await waitForActivity(ctx, record.id, ['busy'], 60_000)
  await sleep(400)
  const busyDot = await paintedDot(win, record.id)
  painted['busy'] = {
    activity: busyActivity,
    tone: busyDot ? toneOf(busyDot) : null,
    label: busyDot?.label ?? null
  }
  const busyShot = await screenshot(win, shotDir, 'sessions-state-busy.png')

  checks.push({
    id: 'SESS-17',
    criterion: 'A tab says whether its session is working, waiting on you, or done',
    title: 'The dot follows the session through idle, waiting and busy',
    ok:
      painted['idle']?.activity === 'idle' &&
      painted['idle']?.tone === 'success' &&
      painted['waiting']?.activity === 'waiting' &&
      painted['waiting']?.tone === 'warn' &&
      painted['busy']?.activity === 'busy' &&
      painted['busy']?.tone === 'accent' &&
      // The three tones are different objects, so a stylesheet that resolved
      // every one of them to the same colour cannot pass the three above.
      new Set([painted['idle']?.tone, painted['waiting']?.tone, painted['busy']?.tone]).size === 3,
    detail: {
      painted,
      waitingFor,
      screenshots: [waitingShot.file, busyShot.file],
      tokens: idleDot?.tokens ?? null
    },
    notes: [
      'The tone is the dot’s computed colour compared with the theme token as',
      'CSS resolved it in the live window - not against hex written down here.',
      `waitingFor was ${JSON.stringify(waitingFor)}; it is carried verbatim and never matched against.`
    ]
  })

  // Let the turn finish, so the kill below is not landing mid-request.
  await waitForActivity(ctx, record.id, ['idle', 'shell'], 120_000)

  // -------------------------------------------------------------------------
  // SESS-19: Helm wrote nothing into a tree it does not own
  // -------------------------------------------------------------------------
  // Over a registry of this driver's own, and that is T-5's shape rather than a
  // dodge. `~/.claude/sessions` is **shared with every `claude` on the
  // machine** - the session hosting this checkout writes to it, so does the
  // CLI's own sweep - and a digest over it either side of a pass is a claim
  // about the machine, not about Helm. Pointed at a directory nothing else
  // touches, the same claim becomes exact: identical to the byte, or Helm
  // wrote.
  //
  // The live directory is not let off entirely. The weaker claim that *is*
  // sound over a shared tree is asserted beside it: Helm creating anything
  // would create a name of its own choosing, and nothing but `<pid>.json` may
  // appear.
  const fixtureHome = join(shotDir, '..', 'registry-fixture')
  const fixtureDir = join(fixtureHome, 'sessions')
  rmSync(fixtureHome, { recursive: true, force: true })
  mkdirSync(fixtureDir, { recursive: true })

  // A pid that is provably gone, established rather than guessed: a process
  // spawned and waited on, so `probeProcess` answers ESRCH rather than picking
  // up a stranger.
  const deadPid = ((): number => {
    const child = spawnSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/c', 'exit'], {
      windowsHide: true
    })
    return child.pid ?? 999_999
  })()

  const livePid = pid ?? process.pid
  writeFileSync(
    join(fixtureDir, `${String(livePid)}.json`),
    JSON.stringify({
      pid: livePid,
      sessionId: assigned ?? 'fixture-live',
      cwd: project.path,
      startedAt: Date.now(),
      procStart: '134317439745798131',
      version: '2.1.238',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'fixture live',
      status: 'busy',
      statusUpdatedAt: Date.now()
    })
  )
  // Stale, malformed and not-a-record: the three shapes the reader has to walk
  // past without touching. A read-only claim over a directory of well-formed
  // live records would be the easy half of the question.
  writeFileSync(
    join(fixtureDir, `${String(deadPid)}.json`),
    JSON.stringify({ pid: deadPid, status: 'busy', startedAt: Date.now(), sessionId: 'stale' })
  )
  writeFileSync(join(fixtureDir, '77771.json'), '{"pid":77771,"status":"bu')
  writeFileSync(join(fixtureDir, 'not-a-record.txt'), 'left alone')

  const fixtureBefore = hashRegistryDir(fixtureDir)
  const fixtureCanary = join(fixtureDir, '.canary')
  writeFileSync(fixtureCanary, 'x')
  const fixtureCanaryMoved = hashRegistryDir(fixtureDir).digest !== fixtureBefore.digest
  rmSync(fixtureCanary, { force: true })

  // A full pass through the code the app actually runs - the service, not just
  // the reader - so the join, the liveness filter and the poll are all
  // exercised over these files.
  const fixtureService = createActivityService({
    sessions: ctx.sessions,
    window: () => win,
    claudeHome: fixtureHome
  })
  for (let i = 0; i < 8; i++) {
    fixtureService.refresh()
    await sleep(120)
  }
  const fixtureEntries = fixtureService.entries()
  fixtureService.stop()

  const fixtureAfter = hashRegistryDir(fixtureDir)
  const liveDirNow = hashRegistryDir(registryDir)
  // Reported, never gated on, and the reason is a measurement: the CLI writes
  // more than records into this directory. Beside every `<pid>.json` it puts a
  // `<pid>.<sha256>.key` holding a `peerToken` for its own session-to-session
  // messaging - so "a name Helm did not expect appeared" is routinely true and
  // says nothing about Helm. What that finding did change is the reader: the
  // `.json` filter there is now a credential boundary with a comment saying so.
  const appeared = liveDirNow.files.filter((f) => !baseline.files.includes(f))

  checks.push({
    id: 'SESS-19',
    criterion: 'Helm never writes to or deletes from ~/.claude/sessions',
    title: 'A full pass over a registry left it identical to the byte',
    ok:
      fixtureCanaryMoved &&
      fixtureBefore.digest === fixtureAfter.digest &&
      fixtureAfter.files.length === 4 &&
      // And the pass was a real one: it read the live record and refused the
      // other three. A reader that had walked past the whole directory would
      // also leave it unchanged.
      fixtureEntries.length === 1 &&
      fixtureEntries[0]?.pid === livePid,
    detail: {
      fixtureDir,
      canaryMoved: fixtureCanaryMoved,
      before: fixtureBefore.digest,
      after: fixtureAfter.digest,
      files: fixtureAfter.files,
      entriesReturned: fixtureEntries.map((e) => ({ pid: e.pid, activity: e.activity })),
      deadPid,
      livePid,
      realDir: registryDir,
      appearedInRealDirDuringTheRun: appeared
    },
    notes: [
      'The canary is hashed in and out of the fixture first: a digest that',
      'cannot move would report "unchanged" over any amount of writing.',
      'The fixture holds a live record, a stale one, a truncated one and a file',
      'that is not a record - so "unchanged" is a claim about a pass that had',
      'something to walk past.',
      'What appeared in the real ~/.claude/sessions during the run is reported',
      'and not gated on. That directory is shared with every claude on the',
      'machine, and the CLI itself writes peer-token .key files into it, so',
      'attribution there is not available - which is why the exact claim is',
      'made against a registry nothing else can touch.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-18: a record left behind by a hard kill never paints a live status
  // -------------------------------------------------------------------------
  const seenBeforeKill =
    pid === null ? false : readSessionRegistry(registryDir).some((e) => e.pid === pid)

  if (pid !== null) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      // Already gone; the assertions below still decide.
    }
  }
  await sleep(4000)
  ctx.activity.refresh()
  await sleep(500)

  // This driver's own read: is the stale file still there, and does it still
  // claim a live status? Without that, "the reader returned nothing" would pass
  // over a directory the CLI had already swept - the PROF-4 shape exactly.
  const staleOnDisk = ((): { file: string; status: unknown } | null => {
    try {
      const text = readFileSync(join(registryDir, `${String(pid)}.json`), 'utf8')
      const bag = JSON.parse(text) as Record<string, unknown>
      return { file: `${String(pid)}.json`, status: bag['status'] }
    } catch {
      return null
    }
  })()

  const readerDropsIt = pid === null ? false : !readSessionRegistry(registryDir).some((e) => e.pid === pid)
  const afterKillState = ctx.activity.states().find((s) => s.id === record.id)
  const killedDot = await paintedDot(win, record.id)
  const killedTone = killedDot ? toneOf(killedDot) : null
  const killShot = await screenshot(win, shotDir, 'sessions-state-killed.png')

  const staleClaimsLive =
    staleOnDisk !== null &&
    typeof staleOnDisk.status === 'string' &&
    ['busy', 'idle', 'shell', 'waiting'].includes(staleOnDisk.status)

  checks.push({
    id: 'SESS-18',
    criterion: 'A stale registry record is never painted as a live status',
    title: 'A session killed out from under the app leaves a record nothing believes',
    ok:
      seenBeforeKill &&
      staleClaimsLive &&
      readerDropsIt &&
      (afterKillState === undefined || afterKillState.activity === null) &&
      killedTone !== 'accent' &&
      killedTone !== 'warn',
    detail: {
      pid,
      seenBeforeKill,
      staleOnDisk,
      readerDropsIt,
      afterKillState: afterKillState ?? null,
      paintedTone: killedTone,
      paintedLabel: killedDot?.label ?? null,
      screenshot: killShot.file
    },
    notes: [
      'Three claims, and the first two are what make the third worth anything:',
      'the reader found this pid before the kill, the file is still on disk',
      'afterwards still claiming a live status, and the reader now refuses it.',
      'Helm does not remove it - that is Claude Code’s own sweep’s job.'
    ]
  })

  await ctx.sessions.close({ id: record.id, force: true })

  // -------------------------------------------------------------------------
  // SESS-20: the join survives a `.cmd` shim, where the pty is not the CLI
  // -------------------------------------------------------------------------
  /*
   * An npm-installed `claude` on Windows is a `.cmd`, and `resolveClaudeCommand`
   * then spawns `cmd.exe /c <shim>`. The pty's pid is the wrapper's and
   * `claude.exe` registers under its own - measured at pty 23496 against
   * registry 4068 - so a join on the pty pid finds nothing at all on the
   * installation shape half the world has.
   *
   * Exercised through the host rather than the launch button, and the contrast
   * with SESS-17 above is deliberate: that one is about what a *tab* paints and
   * so must go through the window, and this one is about the join, which the
   * window has no part in. One session, and it is ended immediately.
   */
  // `resolve`d rather than joined: this is going into a `cmd.exe /c` command
  // line, and a path carrying `..` and a space is two chances for the wrapper
  // to disagree with `CreateProcess` about where it ends.
  const shimDir = resolve(shotDir, '..', 'cmd shim')
  rmSync(shimDir, { recursive: true, force: true })
  mkdirSync(shimDir, { recursive: true })
  const realClaude = resolveClaudeCommand()?.resolved ?? null
  const shim = join(shimDir, 'claude.cmd')
  if (realClaude !== null) writeFileSync(shim, `@echo off\r\n"${realClaude}" %*\r\n`)

  let shimJoin: {
    ptyPid: number | null
    registryPid: number | null
    activity: string | null
    assigned: string | null
    reachedPrompt: boolean
    argv: string[]
    output: string
    registryFiles: string[]
  } | null = null

  if (realClaude !== null) {
    setClaudeOverride(shim)
    try {
      const shimmed = await ctx.sessions.start({
        cwd: project.path,
        projectPath: project.path,
        name: 'shim join',
        cols: 100,
        rows: 30
      })
      const stopShimGates = answerStartupGates(ctx, collector, [shimmed.id])
      const reachedPrompt = await waitFor(
        () => atPrompt(stripAnsi(collector.output(shimmed.id))),
        90_000
      )
      stopShimGates()
      const activity = await waitForActivity(ctx, shimmed.id, ['idle', 'busy', 'waiting', 'shell'], 60_000)
      shimJoin = {
        ptyPid: ctx.sessions.pid(shimmed.id),
        // Read back out of this driver's own walk of the directory, matched on
        // the uuid - the same independent route SESS-16 uses.
        registryPid: ((): number | null => {
          try {
            for (const name of readdirSync(registryDir)) {
              if (!name.toLowerCase().endsWith('.json')) continue
              const bag = JSON.parse(readFileSync(join(registryDir, name), 'utf8')) as Record<
                string,
                unknown
              >
              if (bag['sessionId'] === shimmed.claudeSessionId && typeof bag['pid'] === 'number') {
                return bag['pid']
              }
            }
          } catch {
            return null
          }
          return null
        })(),
        activity,
        assigned: shimmed.claudeSessionId,
        reachedPrompt,
        argv: shimmed.argv,
        // The last of what the wrapper printed. A shim that could not be run at
        // all says so on this stream, and "no record appeared" would otherwise
        // look identical to a session that started and did not register.
        output: squash(stripAnsi(collector.output(shimmed.id))).slice(-400),
        registryFiles: ((): string[] => {
          try {
            return readdirSync(registryDir)
          } catch {
            return []
          }
        })()
      }
      await ctx.sessions.close({ id: shimmed.id, force: true })
    } finally {
      setClaudeOverride(null)
    }
  }

  checks.push({
    id: 'SESS-20',
    criterion: 'A session Helm launches can be joined to its record in Claude Code’s registry',
    title: 'Through a .cmd shim the pty is cmd.exe, and the join still finds the session',
    ok:
      shimJoin !== null &&
      shimJoin.assigned !== null &&
      shimJoin.registryPid !== null &&
      // The whole point: the two pids differ, so a join on the pty pid could not
      // have produced this answer.
      shimJoin.registryPid !== shimJoin.ptyPid &&
      shimJoin.activity !== null,
    detail: { shim, realClaude, ...(shimJoin ?? {}) },
    notes:
      realClaude === null
        ? ['No claude on this machine, so there was nothing to put a shim in front of.']
        : [
            'The pids differing is part of the assertion, not colour: if they were',
            'equal this probe would be measuring the direct-spawn case again.'
          ]
  })

  return checks
}


/** Click whatever a plain selector finds. Nothing here needs a Windows path. */
async function clickSelector(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  ).catch(() => false)
}

/**
 * Put the sessions pane's list back on screen, if a row has replaced it.
 *
 * Docked beside a session split the pane is **compact**: list *or* detail,
 * never both (DESIGN.md "narrow panes"), and a row that has been opened has
 * taken the list's place. Every session this group starts opens a tab, so the
 * pane is always compact here - which means "click the next row" is two clicks,
 * and a driver that assumed one would read the first row's detail twice and
 * report that the pane cannot tell two sessions apart.
 *
 * A no-op when the list is already showing, so it is safe to call before
 * anything that reads rows.
 */
async function backToSessionList(win: BrowserWindow): Promise<void> {
  await clickSelector(win, '[data-sessions-pane] [data-pane-back]')
  await sleep(300)
}

/** Open a sessions-pane row by the pid on it, from wherever the pane is. */
async function clickPid(win: BrowserWindow, pid: number): Promise<boolean> {
  await backToSessionList(win)
  return clickSelector(win, `[data-session-pid="${String(pid)}"]`)
}

/**
 * A process table this driver read for itself, so a tree can be checked
 * against something other than the reader that produced it.
 *
 * Deliberately not `readProcessSnapshot` - that is the code under test, and a
 * parser agreeing with itself proves nothing. This is a different query shape
 * (two fields, CSV, no ports) parsed differently here, which is the same second
 * reader `descendants` above is built on.
 */
function ownProcessTable(): Map<number, number> {
  const table = new Map<number, number>()
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
    for (const line of csv.split(/\r?\n/)) {
      const [child, parent] = line.split(',').map(Number)
      if (Number.isFinite(child) && Number.isFinite(parent)) {
        table.set(child as number, parent as number)
      }
    }
  } catch {
    // An empty table is caught by the "is this discriminating" assertion in
    // SESS-21 rather than by silence here.
  }
  return table
}

/** Whether `root` is an ancestor of `pid` in a table this driver read. */
function hasAncestor(table: ReadonlyMap<number, number>, pid: number, root: number): boolean {
  let at = pid
  for (let hops = 0; hops < 64; hops++) {
    if (at === root) return true
    const parent = table.get(at)
    if (parent === undefined || parent <= 0 || parent === at) return false
    at = parent
  }
  return false
}

interface PaneRow {
  pid: number
  hosted: boolean
  state: string | null
  cwd: string
  name: string
}

/**
 * The rows the sessions pane is currently painting, straight off the DOM.
 *
 * The list is put back first: compact, an open row has replaced it, and an
 * empty answer would then read as "the pane lists nothing" rather than as "the
 * list is not the half on screen".
 */
async function paneRows(win: BrowserWindow): Promise<PaneRow[]> {
  await backToSessionList(win)
  return js<PaneRow[]>(
    win,
    `[...document.querySelectorAll('[data-session-pid]')].map((row) => {
       const name = row.querySelector('span > span:not([data-session-dot])');
       const cwd = row.querySelector('span.font-mono');
       return {
         pid: Number(row.getAttribute('data-session-pid')),
         hosted: row.getAttribute('data-session-hosted') === 'true',
         state: row.getAttribute('data-session-state'),
         name: name ? name.textContent : '',
         cwd: cwd ? cwd.textContent : ''
       }
     })`
  ).catch(() => [])
}

interface PaneDetail {
  treeUnknown: boolean
  portsUnknown: boolean
  treePids: number[]
  treeNames: string[]
  ports: number[]
  text: string
}

/** What the detail half is saying about whatever row is open. */
async function paneDetail(win: BrowserWindow): Promise<PaneDetail | null> {
  return js<PaneDetail | null>(
    win,
    `(() => {
       const pane = document.querySelector('[data-sessions-pane]');
       if (!pane) return null;
       const rows = [...pane.querySelectorAll('[data-tree-pid]')];
       return {
         treeUnknown: pane.querySelector('[data-tree-unknown]') !== null,
         portsUnknown: pane.querySelector('[data-ports-unknown]') !== null,
         treePids: rows.map((r) => Number(r.getAttribute('data-tree-pid'))),
         treeNames: rows.map((r) => { const s = r.querySelector('span'); return s ? s.textContent : '' }),
         ports: [...pane.querySelectorAll('[data-session-port]')].map((p) =>
           Number(p.getAttribute('data-session-port'))
         ),
         text: (pane.textContent || '').replace(/\\s+/g, ' ')
       }
     })()`
  ).catch(() => null)
}

/**
 * What each session is holding, and every live session on the machine.
 *
 * Six probes. Two are about the enumeration itself and are checked against
 * ground truth this driver established - a process table it read with a
 * different query, and a listener it started on a port it chose. Two are about
 * what the pane does with the answer, including the pair that must never be
 * confused: a tree that could not be read, and a session that genuinely has no
 * children. The last two are the machine-wide half - a session Helm did not
 * start, and the warning that names it on somebody else's launch row.
 *
 * **Cost**: three real `claude` sessions - two hosted, one on its own pty
 * outside Helm - and **no model turns at all**, because nothing here submits a
 * prompt. About three minutes.
 *
 * The outside session is not colour. Machine-wide listing is the half of this
 * surface that cannot be argued into existence, only demonstrated: a `claude`
 * in a terminal collides with a working tree exactly as hard as a tab does, and
 * SESS-25 and SESS-26 are what say Helm sees it.
 */
async function runResourcesChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const { win } = ctx

  await waitFor(() => pick(ctx.services).length >= 2, 120_000)
  await pollJs(win, `document.querySelectorAll('aside button[title]').length >= 1`, 30_000)
  const projects = pick(ctx.services)
  const [first, second, third] = projects
  if (!first || !second) {
    checks.push({
      // audit: optional - only reached when discovery found fewer than two projects.
      id: 'SESS-21-SKIP',
      criterion: 'setup',
      title: 'Fewer than two projects to put sessions in',
      ok: false,
      detail: { projects: projects.map((p) => p.path) },
      notes: ['This group is about two sessions in two different working trees.']
    })
    return checks
  }

  // -------------------------------------------------------------------------
  // Two sessions, two working trees. Through the window, because SESS-23 reads
  // the pane, and a session started through the host has a row and no tab.
  // -------------------------------------------------------------------------
  const started: Array<{ id: number; path: string; pid: number | null }> = []
  for (const project of [first, second]) {
    const before = ctx.sessions.list().length
    await clickByTitle(win, project.path)
    await sleep(250)
    await clickButton(win, 'Start session here')
    await waitFor(() => ctx.sessions.list().length > before, 30_000)
    const record = ctx.sessions.list().at(-1)
    if (record) started.push({ id: record.id, path: project.path, pid: null })
  }
  const stopGates = answerStartupGates(
    ctx,
    collector,
    started.map((session) => session.id)
  )
  for (const session of started) {
    await waitFor(() => atPrompt(stripAnsi(collector.output(session.id))), 90_000)
  }
  stopGates()
  await sleep(2500)
  for (const session of started) session.pid = ctx.sessions.pid(session.id)

  // -------------------------------------------------------------------------
  // SESS-21: the tree is the pty's own children, checked against a table this
  //          driver read for itself
  // -------------------------------------------------------------------------
  ctx.resources.watch(true)
  await ctx.resources.refresh()
  await sleep(400)
  const realPass = ctx.resources.lastPass()
  const snapshots = ctx.resources.snapshots()
  const table = ownProcessTable()

  // The second reader has to be worth something before its agreement is. An
  // empty table would make every "is an ancestor" question answer false, and a
  // table that does not contain the pty pids was read at the wrong moment -
  // either way the comparison below would be measuring nothing.
  const tableDiscriminates =
    table.size > 50 && started.every((s) => s.pid !== null && table.has(s.pid))

  const rooted = snapshots.map((snapshot) => {
    const still = (snapshot.processes ?? []).filter((p) => table.has(p.pid))
    return {
      id: snapshot.id,
      rootPid: snapshot.rootPid,
      rootSeen: snapshot.rootSeen,
      size: snapshot.processes?.length ?? -1,
      checkedAgainstOwnTable: still.length,
      // Every process the app put in this tree that this driver can still see
      // has to have the pty as an ancestor, by this driver's own parent
      // pointers. A tree rooted anywhere else fails on the first row.
      allDescendFromPty: still.every((p) => hasAncestor(table, p.pid, snapshot.rootPid)),
      opaque: snapshot.opaque
    }
  })

  /*
   * This group's own sessions, told apart from whatever else the app is
   * hosting - and that distinction is the whole of a fix rather than a detail.
   *
   * This was `snapshots.length === started.length`, which is a claim about the
   * **environment** and not about the mechanism, and it failed the first full
   * `pnpm sessions-check` for exactly that reason: `lifecycle` ends by leaving
   * a live session behind for the app's own quit path to reap (SESS-9), so a
   * full run has a third hosted session that `--only=resources` does not. Every
   * substantive clause passed and the count did not. A probe that is green
   * narrowed and red in the run that matters is worse than no probe, because
   * the red line says nothing about the thing it is named for.
   *
   * The claim that clause was standing in for is worth keeping, and it has two
   * halves. Both survive another session being live once they are asked of the
   * **host** rather than of this group's own two:
   *
   *   - **Nothing is missing or doubled.** Each session this group started
   *     appears exactly once, rooted at the pty pid Helm holds for it. `exactly
   *     once` rather than `at least once`, because a service that emitted a
   *     session twice would pass a `some`.
   *   - **Nothing is invented.** Every snapshot names a session `ctx.sessions`
   *     reports as running, at the pid the host itself would hand out. A
   *     snapshot for a session that does not exist, or rooted at a pid nothing
   *     hosts, fails here whoever started the sessions around it.
   *
   * `rooted.every(...)` is scoped to this group's own for the same reason one
   * level down. A leftover session that exits between the pass being scheduled
   * and it running is `rootSeen: false` - correct behaviour, asserted by
   * SESS-23 - and it must not turn into a red line on a session this driver
   * neither started nor controls. The others are reported rather than judged.
   */
  const hostedNow = new Map(
    ctx.sessions
      .list()
      .filter((record) => record.status === 'running')
      .map((record) => [record.id, ctx.sessions.pid(record.id)])
  )
  const mine = new Set(started.map((s) => s.id))
  const startedOnce = started.map((s) => ({
    id: s.id,
    ptyPid: s.pid,
    seen: snapshots.filter((snap) => snap.id === s.id && snap.rootPid === s.pid).length
  }))
  const invented = snapshots
    .filter((snap) => hostedNow.get(snap.id) !== snap.rootPid)
    .map((snap) => ({
      id: snap.id,
      rootPid: snap.rootPid,
      hostSaysPid: hostedNow.get(snap.id) ?? null
    }))
  const rootedMine = rooted.filter((r) => mine.has(r.id))
  const rootedOthers = rooted.filter((r) => !mine.has(r.id))

  /*
   * The walk itself, over a real tree that has real depth in it.
   *
   * A `claude` sitting at its prompt has started nothing, so on this machine
   * the clause above is asserted over a set of **one** - the root, which is
   * trivially its own ancestor - and would pass a walk that returned nothing
   * but the root it was handed. That is the PROF-4 shape: a comparison whose
   * inputs cannot make it fail.
   *
   * A root that genuinely has descendants is available and needs no session to
   * be driven into starting anything: **this process**, which spawned the two
   * ptys a moment ago. So the same `sessionResources` the app calls is run over
   * a real snapshot rooted here, and the set it produces is compared with the
   * descendants of the same pid in the driver's own parent pointers - in
   * **both** directions, because a walk that stopped early fails one and a walk
   * that returned the machine fails the other.
   *
   * Only pids both readings saw are compared. They are two reads of a table
   * that moves, and a process that started or exited between them is not a
   * disagreement about anything.
   */
  const deepSnapshot = await readProcessSnapshot()
  const deepRoot = process.pid
  const deepTree = sessionResources(-1, deepRoot, deepSnapshot)
  const snapPids = new Set((deepSnapshot.processes ?? []).map((row) => row.pid))
  const ownDescendants = new Set(
    [...table.keys()].filter((pid) => pid !== deepRoot && hasAncestor(table, pid, deepRoot))
  )
  const appTree = new Set(
    (deepTree.processes ?? []).map((row) => row.pid).filter((pid) => pid !== deepRoot)
  )
  const missedByApp = [...ownDescendants].filter((pid) => snapPids.has(pid) && !appTree.has(pid))
  const surplusInApp = [...appTree].filter((pid) => table.has(pid) && !ownDescendants.has(pid))
  const deepest = Math.max(0, ...(deepTree.processes ?? []).map((row) => row.depth))

  checks.push({
    id: 'SESS-21',
    criterion: 'A hosted session’s process tree is derived from the pty Helm spawned',
    title: 'Every process in a session’s tree descends from that session’s pty pid',
    ok:
      tableDiscriminates &&
      // Two sessions in two working trees is what this group is about, so an
      // empty `started` must not make the two clauses under it vacuous.
      started.length === 2 &&
      startedOnce.every((s) => s.seen === 1) &&
      invented.length === 0 &&
      rootedMine.every((r) => r.rootSeen && r.allDescendFromPty && r.checkedAgainstOwnTable >= 1) &&
      // The mechanism, over a tree that could have failed. Two or more
      // descendants and at least two levels, or the set equality below is
      // agreeing about nothing.
      ownDescendants.size >= 2 &&
      deepest >= 1 &&
      deepTree.rootSeen &&
      missedByApp.length === 0 &&
      surplusInApp.length === 0,
    detail: {
      sessions: started,
      pass: realPass,
      rooted,
      startedOnce,
      invented,
      // Hosted sessions this group did not start - `lifecycle`'s handoff
      // session in a full run, nothing in a narrowed one. Reported so a reader
      // can see what else was live, never judged.
      othersHosted: rootedOthers,
      hostSays: [...hostedNow].map(([id, pid]) => ({ id, pid })),
      ownTableSize: table.size,
      tableDiscriminates,
      deep: {
        root: deepRoot,
        deepest,
        inAppTree: appTree.size,
        inOwnTable: ownDescendants.size,
        missedByApp,
        surplusInApp
      }
    },
    notes: [
      'The second reader is this driver’s own CIM query - two fields, CSV, no',
      'ports - parsed here, so the app’s tree is checked against parent pointers',
      'it did not produce.',
      'Its size and the presence of both pty pids are asserted first: an empty',
      'table would answer "not an ancestor" for everything, and a table of three',
      'rows would agree with whatever it happened to contain.',
      'The root is the *pty* pid, not the registry record’s - through a .cmd shim',
      'those differ, and the pty is the one that roots what a session started.',
      'A claude at its prompt has started nothing, so "everything descends from',
      'the pty" is a set of one and cannot fail. The walk is therefore also run',
      'over this process, which has the two ptys beneath it, and the set is',
      'required to match the driver’s own descendants in both directions.',
      'Nothing here counts hosted sessions. A full run has lifecycle’s handoff',
      'session (SESS-9) live beside these two, and "these are the only sessions"',
      'is a claim about the machine rather than about the mechanism. What is',
      'asserted instead is that each session this group started appears exactly',
      'once, and that every snapshot names a session ctx.sessions is running at',
      'the pid the host itself hands out - so nothing is missing, doubled, or',
      'invented, whoever else is running.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-22: the port half is real, checked against a listener this driver
  //          started on a port this driver chose
  // -------------------------------------------------------------------------
  // `process.execPath` in main is **electron.exe**, not node, and it treats
  // `-e` as an app path rather than as a script - the listener then never
  // starts, never prints a port, and this probe fails with `listenerPort: null`
  // while saying nothing about the socket query it is meant to be measuring.
  // `ELECTRON_RUN_AS_NODE` is how the rest of this repository runs node out of
  // Electron (`isolate.mjs`, `profilescheck.ts`, `prcheck.ts`), and it is the
  // same binary either way, so no second runtime is depended on.
  const listener = spawn(
    process.execPath,
    [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port)+'\\n')});setInterval(()=>{},1e9)"
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
  let listenerOut = ''
  listener.stdout?.on('data', (chunk: Buffer) => {
    listenerOut += chunk.toString()
  })
  const listenerPort = (await waitFor(() => /\d+\n/.test(listenerOut), 15_000))
    ? Number(listenerOut.trim())
    : null
  const listenerPid = listener.pid ?? null

  const withListener = await readProcessSnapshot()
  const holds = (snapshot: ProcessSnapshot): boolean =>
    listenerPid !== null &&
    listenerPort !== null &&
    (snapshot.ports ?? []).some((p) => p.pid === listenerPid && p.port === listenerPort)
  const sawListener = holds(withListener)

  listener.kill()
  await sleep(1500)
  const withoutListener = await readProcessSnapshot()
  const stillSeesListener = holds(withoutListener)

  checks.push({
    id: 'SESS-22',
    criterion: 'Listening ports are mapped to the process holding them, unprivileged',
    title: 'A listener this driver started is found on the port it chose, and stops being found',
    ok:
      listenerPort !== null &&
      listenerPid !== null &&
      withListener.ports !== null &&
      withListener.processes !== null &&
      sawListener &&
      !stillSeesListener,
    detail: {
      listenerPid,
      listenerPort,
      sawListener,
      stillSeesListener,
      portsRead: withListener.ports?.length ?? null,
      processesRead: withListener.processes?.length ?? null,
      // The size of what an unelevated query could not see, reported rather
      // than gated on: a withheld command line is the documented answer, not a
      // failure, and no elevation is ever assumed to change it.
      commandLinesWithheld: (withListener.processes ?? []).filter((p) => p.commandLine === null)
        .length,
      passMs: Math.round(withListener.durationMs)
    },
    notes: [
      'The pid and the port are this driver’s: it spawned the process and read',
      'the port the OS handed it off that process’s own stdout.',
      'The second half is what makes the first worth anything - the listener is',
      'killed and the same comparison has to stop matching, so a matcher that',
      'said yes to everything cannot pass this.',
      'Unprivileged throughout. Nothing here elevates and nothing retries.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-23: the pane, two sessions, two working trees
  // -------------------------------------------------------------------------
  /*
   * From here the app's own pass is stopped and this driver drives one of its
   * own, with the machine injected.
   *
   * That is allowed for one reason: the two states the pane must never confuse
   * - a tree that could not be read, and a session that genuinely has nothing
   * running - cannot both be arranged on a real machine on demand, and the
   * second is the one it is easy to fake by accident. Arranging them means the
   * two are told apart by what the machine answered and by nothing else.
   *
   * The service is the app's own and so is the core beneath it; what is
   * injected is the enumeration, exactly as `RegistryWorld.probe` injects a
   * liveness probe. Whether the *real* enumeration works is SESS-21 and
   * SESS-22's question, and they are asked first, on this same session.
   */
  ctx.resources.stop()
  await sleep(900)

  const [alpha, beta] = started
  const alphaPid = alpha?.pid ?? 0
  const betaPid = beta?.pid ?? 0
  const FAKE_PORT = 51_733
  const STRANGER = 909_004

  // A machine: alpha holds a container and a dev server, beta holds nothing.
  const arranged: ProcessSnapshot = {
    atMs: Date.now(),
    durationMs: 1,
    processes: [
      { pid: alphaPid, parentPid: 1, name: 'claude.exe', commandLine: 'claude --model haiku' },
      { pid: 909_001, parentPid: alphaPid, name: 'docker.exe', commandLine: 'docker compose up' },
      {
        pid: 909_002,
        parentPid: 909_001,
        name: 'node.exe',
        commandLine: 'node "C:\\Program Files\\x\\vite"'
      },
      // Withheld, the way 159 of 277 command lines were withheld on this
      // machine to an unelevated query.
      { pid: 909_003, parentPid: alphaPid, name: 'svchost.exe', commandLine: null },
      { pid: betaPid, parentPid: 1, name: 'claude.exe', commandLine: 'claude --model haiku' },
      // Somebody else's, one pid outside both trees, holding the same port.
      { pid: STRANGER, parentPid: 1, name: 'stranger.exe', commandLine: 'not mine' }
    ],
    ports: [
      { pid: 909_002, port: FAKE_PORT, address: '127.0.0.1' },
      { pid: STRANGER, port: FAKE_PORT, address: '0.0.0.0' }
    ]
  }

  let answer: () => ProcessSnapshot = () => arranged
  const driven = createResourcesService({
    sessions: ctx.sessions,
    window: () => win,
    read: () => Promise.resolve(answer())
  })
  driven.watch(true)
  await sleep(600)

  await clickSelector(win, '[data-open-sessions]')
  await pollJs(win, `document.querySelector('[data-sessions-pane]') !== null`, 15_000)
  await sleep(600)

  const rows = await paneRows(win)
  const alphaRow = rows.find((r) => r.pid === alphaPid) ?? null
  const betaRow = rows.find((r) => r.pid === betaPid) ?? null

  await clickPid(win, alphaPid)
  await sleep(500)
  const alphaDetail = await paneDetail(win)
  // The tree and the ports as the pane actually draws them - depth, the mono
  // pid column, a withheld command line, a port on the process holding it.
  // `design-shot` cannot reach this state: its sessions sit on the trust prompt
  // and start nothing, so this run is the only place those rows are
  // photographed. Scrolled to first, because docked beside a session split the
  // tree is below the fold and a picture of the facts above it is not the
  // picture this is for.
  await js<void>(
    win,
    `(() => { const el = document.querySelector('[data-session-tree]');
      if (el) el.scrollIntoView({ block: 'end' }) })()`
  ).catch(() => undefined)
  await sleep(400)
  const treeShot = await screenshot(win, shotDir, 'sessions-resources-tree.png')
  await clickPid(win, betaPid)
  await sleep(500)
  const betaDetail = await paneDetail(win)
  const twoShot = await screenshot(win, shotDir, 'sessions-resources-two.png')

  checks.push({
    id: 'SESS-23',
    criterion: 'The pane says what each session is working in and what it is holding',
    title: 'Two sessions in two working trees, each row saying its own tree and its own children',
    ok:
      alphaRow !== null &&
      betaRow !== null &&
      alphaRow.hosted &&
      betaRow.hosted &&
      // The cwds are this driver's - it picked the projects and clicked the
      // rows - so the pane agreeing with them is agreement with the world.
      alphaRow.cwd === alpha?.path &&
      betaRow.cwd === beta?.path &&
      alphaRow.cwd !== betaRow.cwd &&
      alphaDetail !== null &&
      alphaDetail.treeNames.includes('docker.exe') &&
      alphaDetail.treeNames.includes('node.exe') &&
      alphaDetail.ports.includes(FAKE_PORT) &&
      // The stranger holds the same port and is not in this tree, so a pane
      // listing every port on the machine fails here.
      !alphaDetail.treePids.includes(STRANGER) &&
      betaDetail !== null &&
      // Beta has no children, and the pane says so **in words** rather than
      // drawing a one-row tree of the session's own process - which is why the
      // row count here is zero rather than one. The sentence is what carries
      // the claim, and it is the sentence SESS-24 must *not* produce: that is
      // where the discrimination lives, not in a row count the blind state
      // shares.
      betaDetail.treePids.length === 0 &&
      /Nothing but the session itself/.test(betaDetail.text) &&
      // And alpha's children are not under beta's heading. Without this the
      // clause above would pass over a detail pane that had simply stopped
      // rendering trees.
      !betaDetail.treeNames.includes('docker.exe') &&
      betaDetail.ports.length === 0 &&
      !betaDetail.treeUnknown,
    detail: {
      rows,
      alphaRow,
      betaRow,
      alphaDetail,
      betaDetail,
      expectedPort: FAKE_PORT,
      screenshot: twoShot.file,
      treeScreenshot: treeShot.file
    },
    notes: [
      'The trees are arranged, the pty pids under them are real, and the service',
      'and the core beneath it are the app’s own - only the enumeration is',
      'injected, the way RegistryWorld.probe injects a liveness probe.',
      'A process holding the same port outside both trees is in the fixture, so a',
      'pane listing the machine’s ports rather than the session’s fails.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-24: a pass that could not look says unknown, never "nothing"
  // -------------------------------------------------------------------------
  answer = () => noProcessSnapshot(Date.now())
  await driven.refresh()
  await sleep(700)
  const blindDetail = await paneDetail(win)
  const blindShot = await screenshot(win, shotDir, 'sessions-resources-unknown.png')

  checks.push({
    id: 'SESS-24',
    criterion: '“Could not look” and “nothing there” are never the same claim',
    title: 'A pass that could not enumerate says unknown rather than showing an empty tree',
    ok:
      blindDetail !== null &&
      blindDetail.treeUnknown &&
      blindDetail.portsUnknown &&
      blindDetail.treePids.length === 0 &&
      // The exact sentence the *previous* state produced for this same session,
      // which must now be gone. Without it this probe would pass over a pane
      // that had simply stopped rendering anything at all.
      !/Nothing but the session itself/.test(blindDetail.text) &&
      /Unknown/.test(blindDetail.text),
    detail: { blindDetail, screenshot: blindShot.file },
    notes: [
      'Run against the same session that said "nothing but the session itself" a',
      'moment earlier, so the two answers are told apart by what the machine',
      'answered and by nothing else.',
      'Both halves are asserted: the process query and the socket query fail',
      'independently, and the pane has a separate "unknown" for each.'
    ]
  })

  driven.stop()

  // -------------------------------------------------------------------------
  // SESS-25: a session started outside Helm, listed
  // -------------------------------------------------------------------------
  /*
   * The half of this surface that cannot be argued, only demonstrated.
   *
   * A `claude` on its own pty, in a directory Helm is hosting nothing in. It
   * has no tab, no row and no session id in Helm - and it holds a working tree
   * exactly as hard as a tab does, which is the whole reason the listing is
   * machine-wide.
   */
  const outsideProject = third ?? first
  const cli = resolveClaudeCommand()
  let outsideOutput = ''
  const outside = spawnSession({
    id: 'resources-outside',
    file: cli?.file ?? 'claude',
    args: [...(cli?.prefixArgs ?? []), '--model', 'haiku', '-n', 'outside helm'],
    cols: 100,
    rows: 30,
    cwd: outsideProject.path,
    onData: (chunk) => {
      outsideOutput += chunk
    },
    onExit: () => undefined
  })

  const outsideReady = await waitFor(() => {
    const text = squash(outsideOutput)
    if (/doyoutrust|trustthisfolder|quicksafetycheck/.test(text)) outside.write('\r')
    if (/mcpservers/.test(text)) outside.write('\x1b')
    return atPrompt(stripAnsi(outsideOutput))
  }, 90_000)

  // This driver's own read of the registry, so "Helm listed it" is checked
  // against the file rather than against the reader that produced the listing.
  const outsideRecord = await (async (): Promise<{ pid: number; cwd: unknown } | null> => {
    const dir = join(claudeHomeHere(), 'sessions')
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        for (const name of readdirSync(dir)) {
          if (!name.toLowerCase().endsWith('.json')) continue
          const bag = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
          if (bag['pid'] === outside.pid) return { pid: outside.pid, cwd: bag['cwd'] }
        }
      } catch {
        // Mid-write, or not there yet. The deadline decides.
      }
      await sleep(300)
    }
    return null
  })()

  const listedOutside = await waitFor(
    () =>
      ctx.activity.overview().sessions.some((s) => s.pid === outside.pid && s.helmSessionId === null),
    20_000
  )
  const outsideEntry = ctx.activity.overview().sessions.find((s) => s.pid === outside.pid) ?? null

  await clickSelector(win, '[data-open-sessions]')
  await sleep(900)
  const rowsWithOutside = await paneRows(win)
  const outsideRow = rowsWithOutside.find((r) => r.pid === outside.pid) ?? null
  const outsideShot = await screenshot(win, shotDir, 'sessions-outside-helm.png')

  checks.push({
    id: 'SESS-25',
    criterion: 'A Claude Code session Helm did not start is listed, and marked as not Helm’s',
    title: 'A session on its own pty appears in the pane under “Elsewhere on this machine”',
    ok:
      outsideReady &&
      outsideRecord !== null &&
      listedOutside &&
      outsideEntry !== null &&
      outsideEntry.helmSessionId === null &&
      outsideEntry.cwd?.toLowerCase() === outsideProject.path.toLowerCase() &&
      outsideRow !== null &&
      !outsideRow.hosted &&
      // Helm's own sessions are still there beside it, so this is a listing
      // rather than a pane that has lost track of what it hosts.
      rowsWithOutside.some((r) => r.hosted),
    detail: {
      outsidePid: outside.pid,
      outsideCwd: outsideProject.path,
      outsideReady,
      ownReadOfRegistry: outsideRecord,
      overviewEntry: outsideEntry,
      outsideRow,
      hostedRowsBeside: rowsWithOutside.filter((r) => r.hosted).length,
      screenshot: outsideShot.file
    },
    notes: [
      'The session is spawned on a pty this driver owns. Helm has no row for it,',
      'no session id and no tab - it knows about it only because Claude Code',
      'writes a record for every session on the machine.',
      'This driver reads that record itself and matches on the pid it spawned, so',
      '"Helm listed it" is checked against the file and not against the reader',
      'that produced the listing.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-26: the launch-time warning, for a session Helm did not start
  // -------------------------------------------------------------------------
  /*
   * The single highest-value output of this whole surface, and it is smaller
   * than the pane: one sentence, on the launch row, before the button is
   * pressed. It is what stops two agents editing one checkout.
   *
   * Exercised against the *outside* session deliberately. Helm's own sessions
   * are the easy half - it holds their rows - and the case somebody actually
   * gets hurt by is the terminal left running in another window.
   */
  await clickByTitle(win, outsideProject.path)
  await sleep(900)
  const warned = await js<{ count: number; text: string } | null>(
    win,
    `(() => {
       const el = document.querySelector('[data-already-running]');
       if (!el) return null;
       return {
         count: Number(el.getAttribute('data-already-running')),
         text: (el.textContent || '').replace(/\\s+/g, ' ')
       }
     })()`
  ).catch(() => null)
  const warnShot = await screenshot(win, shotDir, 'sessions-launch-warning.png')

  /*
   * And the converse. A project with nothing running in it must not carry the
   * warning - without this, a pane that printed it unconditionally would pass.
   *
   * Taken from everything the sidebar is showing rather than from `pick()`:
   * those three are precisely the projects this group put sessions in, so on a
   * machine where discovery finds three the converse could never be asked at
   * all - which is how this first ran, reporting a red line that meant "no
   * quiet project exists" while reading as "the warning appeared where it
   * should not have".
   *
   * Off the sidebar rather than off the scan, because a project inside a
   * collapsed group has no row to click, and "no warning appeared" would then
   * be a statement about a pane that was never opened.
   */
  const busyDirs = new Set(
    ctx.activity
      .overview()
      .sessions.flatMap((session) => (session.cwd === null ? [] : [session.cwd.toLowerCase()]))
  )
  const clickable: string[] = await js<string[]>(
    win,
    `[...document.querySelectorAll('aside button[title]')].map((b) => b.title)`
  ).catch((): string[] => [])
  const quiet =
    (ctx.services.lastScan?.projects ?? []).find(
      (project) =>
        !busyDirs.has(project.path.toLowerCase()) && clickable.includes(project.path)
    ) ?? null
  let quietWarned: boolean | null = null
  if (quiet !== null) {
    await clickByTitle(win, quiet.path)
    await sleep(800)
    quietWarned = await js<boolean>(
      win,
      `document.querySelector('[data-already-running]') !== null`
    ).catch(() => true)
  }

  checks.push({
    id: 'SESS-26',
    criterion: 'Starting a session where one is already running says so first',
    title: 'The launch row names the session already in this folder, including one outside Helm',
    ok:
      warned !== null &&
      warned.count >= 1 &&
      // Named, not counted. "A session is running here" is not something
      // anybody can act on.
      /outside helm/i.test(warned.text) &&
      // And it says the thing in the way is not a tab. Matched on the two
      // stable halves rather than on one phrasing: the sentence has four forms
      // - one/several sessions, some/all of them foreign - and this ran against
      // "None of them was started by Helm", which a regex written for "was not
      // started by Helm" misses while the warning is entirely correct.
      /started by Helm/i.test(warned.text) &&
      /no tabs? here/i.test(warned.text) &&
      quiet !== null &&
      quietWarned === false,
    detail: {
      project: outsideProject.path,
      warned,
      quietProject: quiet?.path ?? null,
      quietWarned,
      quietCandidates: clickable.length,
      busyDirs: [...busyDirs],
      screenshot: warnShot.file
    },
    notes: [
      'The name asserted is the `-n` name this driver gave the outside session,',
      'so the sentence is carrying a fact rather than a template.',
      'The converse is asserted on a project with nothing running in it: a',
      'warning printed unconditionally would pass the first half on its own.',
      'That project is found among the rows the sidebar is actually showing, not',
      'among the three this group put sessions in - all three are crowded by the',
      'time it is asked.',
      'It is on screen before the button is pressed rather than in a dialog after',
      'it - DESIGN.md 5, and a confirmation shown every time is one people learn',
      'to dismiss without reading.'
    ]
  })

  outside.kill()
  for (const session of started) await ctx.sessions.close({ id: session.id, force: true })

  return checks
}

// ---------------------------------------------------------------------------
// tools - what a session may be told about the other sessions
// ---------------------------------------------------------------------------

/**
 * The two tools, written out **here**.
 *
 * `browser-check`'s rule, for the same reason: a list read from the server and
 * compared against itself agrees with itself. This is typed in by hand, and the
 * wire's answer has to equal it exactly - so a tool added, renamed or quietly
 * dropped fails rather than passing with a new list.
 */
const EXPECTED_SESSION_TOOLS = ['sessions_list', 'session_detail']

interface Rpc {
  status: number
  body: Record<string, unknown> | null
  text: string
}

/** One JSON-RPC request over the wire, exactly as `claude` would make it. */
function rpc(url: string, token: string | null, payload: unknown): Promise<Rpc> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload)
    const target = new URL(url)
    const req = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...(token === null ? {} : { authorization: `Bearer ${token}` })
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (text += chunk))
        res.on('end', () => {
          let parsed: Record<string, unknown> | null
          try {
            parsed = JSON.parse(text) as Record<string, unknown>
          } catch {
            parsed = null
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text })
        })
      }
    )
    req.on('error', (err) => resolve({ status: 0, body: null, text: String(err) }))
    req.setTimeout(60_000, () => {
      req.destroy()
      resolve({ status: 0, body: null, text: 'timed out' })
    })
    req.write(body)
    req.end()
  })
}

let nextRpcId = 1

/**
 * A token that differs from the real one by a single character.
 *
 * Written out rather than `slice(0, -1) + '0'`, which is the obvious form and is
 * wrong one time in sixteen: a hex token already ending in `0` is unchanged by
 * it, so the "wrong token" request carries the right token and gets a 200. That
 * happened on the second run of this group. A gate that merely looked for the
 * word Bearer still fails this - the point of the probe is intact - but it must
 * fail for that reason rather than by chance.
 */
function oneCharacterOff(token: string): string {
  if (token === '') return 'x'
  const last = token.slice(-1)
  return `${token.slice(0, -1)}${last === '0' ? '1' : '0'}`
}

interface ToolAnswer {
  status: number
  /** Whether the tool answered at all, and without `isError`. */
  ok: boolean
  text: string
}

async function callTool(
  url: string,
  token: string | null,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolAnswer> {
  const answer = await rpc(url, token, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  const result = (answer.body?.['result'] ?? null) as {
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  } | null
  return {
    status: answer.status,
    ok: answer.status === 200 && result !== null && result.isError !== true,
    text: (result?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
  }
}

/**
 * What a launched session was actually handed, read out of its own argv.
 *
 * The driver reads the ephemeral `--mcp-config` file the same way the CLI does,
 * which is what lets it speak MCP **as that session** - and attribution is
 * which token arrived, so there is no other way to exercise it. It is also the
 * fixture for the withholding claim: the token this returns is the one no tool
 * answer may ever contain.
 */
function toolsHandedTo(argv: readonly string[]): {
  file: string
  servers: Record<string, { url?: string; headers?: Record<string, string> }>
  token: string | null
} | null {
  const at = argv.indexOf('--mcp-config')
  const file = at === -1 ? null : (argv[at + 1] ?? null)
  if (file === null) return null
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>
    }
    const servers = body.mcpServers ?? {}
    const header = servers[SESSION_TOOLS_SERVER_NAME]?.headers?.['Authorization'] ?? null
    return {
      file,
      servers,
      token: header === null ? null : header.replace(/^Bearer\s+/i, '')
    }
  } catch {
    return null
  }
}

/** Startup gates, answering the MCP one with agreement rather than escape. */
function answerGatesApprovingMcp(
  ctx: { sessions: SessionHost },
  collector: Collector,
  ids: number[]
): () => void {
  const seen = new Map<string, number>()
  const gates: Array<[string, RegExp]> = [
    ['trust', /doyoutrust|trustthisfolder|quicksafetycheck/g],
    ['mcp', /mcpserver/g],
    ['consent', /doyouwanttoproceed/g]
  ]
  const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length
  for (const id of ids) {
    for (const [kind, re] of gates) seen.set(`${kind}:${String(id)}`, count(squash(collector.output(id)), re))
  }
  const timer = setInterval(() => {
    for (const id of ids) {
      const text = squash(collector.output(id))
      for (const [kind, re] of gates) {
        const key = `${kind}:${String(id)}`
        const now = count(text, re)
        if (now > (seen.get(key) ?? 0)) {
          seen.set(key, now)
          // Enter every time, the MCP gate included: the caret sits on the
          // agreeing option, and this group is about the servers it just
          // registered. `answerStartupGates` escapes that one instead, which is
          // right for a group that does not want them.
          ctx.sessions.input(id, '\r')
        }
      }
    }
  }, 350)
  return () => clearInterval(timer)
}

/**
 * One session's block out of a listing, by pid.
 *
 * Split rather than matched with a regex reaching across lines, because a
 * session's *name* can contain anything a person or a launch put in it - these
 * two are named `PR #900000 review - subject-…`, so a pattern using `#` as a
 * block boundary stops inside the name and finds nothing.
 */
function blockFor(listing: string, pid: number): string | null {
  const blocks = listing.split(/\n(?=#\d)/)
  return blocks.find((block) => block.startsWith(`#${String(pid)} `)) ?? null
}

/** Every `<pid>.json` in the registry, parsed by this driver rather than by core. */
function ownRegistryRead(dir: string): Array<{
  pid: number
  sessionId: unknown
  cwd: unknown
  name: unknown
  status: unknown
  waitingFor: unknown
}> {
  const out: Array<{
    pid: number
    sessionId: unknown
    cwd: unknown
    name: unknown
    status: unknown
    waitingFor: unknown
  }> = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    // `.json` only. The `.key` files beside them carry a peerToken, and this
    // driver is held to the same rule the reader is.
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const bag = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      const pid = typeof bag['pid'] === 'number' ? bag['pid'] : null
      if (pid === null) continue
      out.push({
        pid,
        sessionId: bag['sessionId'],
        cwd: bag['cwd'],
        name: bag['name'],
        status: bag['status'],
        waitingFor: bag['waitingFor']
      })
    } catch {
      // Mid-write. The caller polls.
    }
  }
  return out
}

/**
 * A session Helm hosts, asking what the other sessions are doing.
 *
 * **Two sessions, both launched through `SessionHost.review`** - not because
 * this is about pull requests but because it is Helm's one launch path that
 * puts a prompt into argv, and "a tool must never hand over another session's
 * argv" is one of the things being asserted. It also pins both to haiku, which
 * `session:start` has no way to do.
 *
 * One model turn each. `subject` is given a marker string as its opening
 * prompt, which puts that string in its argv, on its screen and in its
 * conversation - the fixture for "no tool returns any part of another session's
 * conversation". `reporter` is asked to find `subject` through the tools and
 * report two facts back, which is the only way to exercise the whole chain: the
 * config file Helm wrote, the CLI reading it, the connection, the tool list and
 * an answer.
 *
 * Everything else is driven **over the wire, as those sessions**, using the
 * bearer tokens out of their own config files - because attribution is which
 * token arrived, and a driver registering an agent of its own would have no
 * session to be attributed to.
 */
async function runToolsChecks(
  ctx: CheckContext,
  collector: Collector,
  shotDir: string
): Promise<Check[]> {
  const checks: Check[] = []
  const host = ctx.browserMcp
  const bound = host?.address() ?? null

  if (host === null || bound === null) {
    checks.push({
      id: 'SESS-27',
      criterion: 'A session Helm hosts can ask what the other sessions are doing',
      title: 'Helm’s endpoint was not running, so nothing in this group could be measured',
      ok: false,
      detail: { endpoint: host === null ? null : 'not bound', settings: { sessionMcp: ctx.services.settings.sessionMcp } },
      notes: [
        'A failure rather than a skip on purpose: a group that quietly produced no',
        'checks would report green in every runner.'
      ]
    })
    return checks
  }

  // The first scan is kicked off by main and lands after the window paints, so
  // a group that reads projects has to wait for it - this one runs first under
  // `--only=tools` and had nothing to launch into without this.
  await waitFor(() => pick(ctx.services).length >= 2, 120_000)
  const projects = pick(ctx.services)
  const [first, second] = projects
  if (!first || !second) {
    checks.push({
      // audit: optional - only reached when discovery found fewer than two projects.
      id: 'SESS-27-SKIP',
      criterion: 'setup',
      title: 'Fewer than two projects to put sessions in',
      ok: false,
      detail: { projects: projects.map((p) => p.path) },
      notes: ['This group is about one session reporting on another, in another tree.']
    })
    return checks
  }

  // The marker, and the two facts the reporter has to come back with. Random
  // per run so nothing can answer from memory, and short enough to survive
  // `sanitizeSessionName`.
  const marker = randomBytes(3).toString('hex')
  const nonce = `helm-marker-${randomBytes(6).toString('hex')}`
  const registryDir = join(claudeHomeHere(), 'sessions')

  const subject = await ctx.sessions.review(
    {
      repoPath: second.path,
      slug: `helm-check/subject-${marker}`,
      number: 900_000,
      // The whole opening prompt, and the thing that must never come back out
      // of a tool: it is this session's first user message and it is in its
      // argv.
      prompt: `Reply with the single word OK and nothing else. Marker ${nonce}`,
      model: 'haiku',
      effort: null,
      checkedOut: null,
      warnings: []
    },
    { cols: 100, rows: 30 }
  )

  const stopSubjectGates = answerGatesApprovingMcp(ctx, collector, [subject.id])

  /*
   * A session's own record, found by this driver by the conversation id Helm
   * minted - so "that row is that record" is a join this driver made itself
   * rather than one it took from the reader under test.
   */
  const findRecord = (claudeSessionId: string | null): { pid: number } | null => {
    if (claudeSessionId === null) return null
    return ownRegistryRead(registryDir).find((row) => row.sessionId === claudeSessionId) ?? null
  }

  // The subject has to be *registered* before the reporter is asked to find it:
  // registration happens after the CLI's startup gates, and a reporter that
  // listed a second too early would truthfully answer that there is nothing
  // there. That would be a flaky probe about the wrong thing.
  const subjectRegistered = await waitFor(() => findRecord(subject.claudeSessionId) !== null, 180_000)

  /*
   * No angle brackets, no pipe, no ampersand in this prompt.
   *
   * It goes into argv as a positional, and through a `.cmd` shim cmd.exe
   * re-parses the line - where `|` is a pipe and `<` is a redirect. The `claude`
   * on this machine is an `.exe`, so it would not bite here; a machine with an
   * npm-installed CLI is the ordinary case and this check should not be the
   * thing that discovers that.
   */
  const reporterPrompt =
    `Use only the ${SESSION_TOOLS_SERVER_NAME} MCP tools for this. Do not read any files and do not run any commands. ` +
    `Call sessions_list. Find the session whose working directory is ${second.path} and which is not you. ` +
    `Call session_detail with that session pid. ` +
    `Then reply with one line and nothing else: the word FOUND, then an equals sign, ` +
    `then that session Helm tab number, then a space, then that session name.`

  const reporter = await ctx.sessions.review(
    {
      repoPath: first.path,
      slug: `helm-check/reporter-${marker}`,
      number: 900_001,
      prompt: reporterPrompt,
      model: 'haiku',
      effort: null,
      checkedOut: null,
      warnings: []
    },
    { cols: 100, rows: 30 }
  )

  const stopReporterGates = answerGatesApprovingMcp(ctx, collector, [reporter.id])

  const subjectTools = toolsHandedTo(subject.argv)
  const reporterTools = toolsHandedTo(reporter.argv)
  const url = `http://127.0.0.1:${String(bound.port)}${SESSION_TOOLS_PATH}`
  const browserUrl = `http://127.0.0.1:${String(bound.port)}/mcp`
  const reporterToken = reporterTools?.token ?? null
  const subjectToken = subjectTools?.token ?? null

  const registered =
    subjectRegistered && (await waitFor(() => findRecord(reporter.claudeSessionId) !== null, 180_000))
  const subjectRecord = findRecord(subject.claudeSessionId)
  const reporterRecord = findRecord(reporter.claudeSessionId)
  const subjectPid = subjectRecord?.pid ?? ctx.sessions.pid(subject.id) ?? 0
  const reporterPid = reporterRecord?.pid ?? ctx.sessions.pid(reporter.id) ?? 0

  // -------------------------------------------------------------------------
  // SESS-27: a second named server on the one listener, token-gated
  // -------------------------------------------------------------------------
  const list = { jsonrpc: '2.0', id: nextRpcId++, method: 'tools/list' }
  const tokenless = await rpc(url, null, list)
  const wrongToken = await rpc(url, oneCharacterOff(reporterToken ?? ''), list)
  const listed = await rpc(url, reporterToken, list)
  const servedTools = ((listed.body?.['result'] ?? null) as {
    tools?: Array<{ name?: string; description?: string }>
  } | null)?.tools ?? []
  const served = servedTools.map((tool) => tool.name ?? '')
  // Every description has to say what this is, in the words a model reads
  // before deciding what a tool is for. "Read-only" is the whole of the
  // difference between awareness and an attempt at coordination.
  const describedReadOnly = servedTools.filter((tool) => /read-only/i.test(tool.description ?? ''))
  const hello = await rpc(url, reporterToken, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sessions-check', version: '1' } }
  })
  const helloResult = (hello.body?.['result'] ?? null) as
    | { serverInfo?: { name?: string }; instructions?: string }
    | null
  // And the browser family, on the same port, still answering under its own
  // name: one listener, two servers.
  const browserHello = await rpc(browserUrl, reporterToken, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'sessions-check', version: '1' } }
  })
  const browserName = (
    (browserHello.body?.['result'] ?? null) as { serverInfo?: { name?: string } } | null
  )?.serverInfo?.name

  checks.push({
    id: 'SESS-27',
    criterion:
      'The session tools are a second named MCP server on the one listener, behind the same token',
    title:
      'Both families are registered in one --mcp-config document with one token, on one port, and the session route serves exactly the two tools to a token and nothing to none',
    ok:
      subjectTools !== null &&
      reporterTools !== null &&
      reporterToken !== null &&
      // One document, two names, one token, two routes.
      Object.keys(reporterTools.servers).sort().join(',') ===
        [MCP_SERVER_NAME, SESSION_TOOLS_SERVER_NAME].sort().join(',') &&
      reporterTools.servers[SESSION_TOOLS_SERVER_NAME]?.url === url &&
      reporterTools.servers[MCP_SERVER_NAME]?.url === browserUrl &&
      reporterTools.servers[MCP_SERVER_NAME]?.headers?.['Authorization'] ===
        reporterTools.servers[SESSION_TOOLS_SERVER_NAME]?.headers?.['Authorization'] &&
      // Two sessions, two tokens: the identity is per session, not per server.
      subjectTools.token !== reporterTools.token &&
      tokenless.status === 401 &&
      wrongToken.status === 401 &&
      listed.status === 200 &&
      served.join(',') === EXPECTED_SESSION_TOOLS.join(',') &&
      // Said in both places a model reads: the server's instructions and every
      // tool's own description.
      describedReadOnly.length === servedTools.length &&
      helloResult?.serverInfo?.name === SESSION_TOOLS_SERVER_NAME &&
      /read-only/i.test(helloResult.instructions ?? '') &&
      browserName === MCP_SERVER_NAME,
    detail: {
      port: bound,
      documentServers: Object.keys(reporterTools?.servers ?? {}),
      sessionRoute: url,
      browserRoute: browserUrl,
      sameTokenInBoth:
        reporterTools?.servers[MCP_SERVER_NAME]?.headers?.['Authorization'] ===
        reporterTools?.servers[SESSION_TOOLS_SERVER_NAME]?.headers?.['Authorization'],
      twoSessionsTwoTokens: subjectTools?.token !== reporterTools?.token,
      tokenless: { status: tokenless.status },
      wrongToken: { status: wrongToken.status },
      served,
      expected: EXPECTED_SESSION_TOOLS,
      toolsSayingReadOnly: describedReadOnly.map((tool) => tool.name ?? ''),
      serverInfo: helloResult?.serverInfo ?? null,
      instructions: (helloResult?.instructions ?? '').slice(0, 200),
      browserServerName: browserName ?? null
    },
    notes: [
      'The token is read out of the file the session itself was handed, which is',
      'what the CLI reads - so everything below speaks MCP *as* that session.',
      'The wrong-token request differs from the good one by one character.',
      'The expected tool list is typed out in this driver: a list read from the',
      'server and compared with itself agrees with itself.',
      'Every tool’s description has to say "read-only", and so do the server’s',
      'instructions: those two strings are the only thing standing between a model',
      'and an attempt to coordinate through a surface that cannot.',
      'The browser family answers on the same port under its own name, which is',
      'what makes this a second server rather than a second listener.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-28: the listing is machine-wide, and agrees with this driver's own
  //          read of the registry
  // -------------------------------------------------------------------------
  const beforeRead = ownRegistryRead(registryDir)
  const listing = await callTool(url, reporterToken, 'sessions_list')
  const afterRead = ownRegistryRead(registryDir)

  // Only the records this driver saw on both sides of the call. Two reads of a
  // directory that moves, and a session that started or ended between them is
  // not a disagreement about anything.
  const stable = beforeRead.filter((row) => afterRead.some((other) => other.pid === row.pid))
  const missing = stable.filter((row) => blockFor(listing.text, row.pid) === null)

  /*
   * Every block has a status line, and that is asserted rather than a count.
   *
   * The listing is machine-wide and this driver's read is one moment of the
   * same directory, so "the listing has exactly as many sessions as I found" is
   * a claim about the **machine**: a session Helm hosts that has not registered
   * yet is in the listing and in no file, and `lifecycle` leaves one running in
   * a full run. That is the shape SESS-21 failed on twice. What is asserted
   * instead is that nothing is *listed without a status*, which is the rule
   * ("unknown, never omitted") and is true whoever else is running.
   */
  const blocks = listing.text.split(/\n(?=#\d)/).filter((block) => /^#\d+\s/.test(block))
  const withStatus = blocks.filter((block) => /\n {4}status {7}\S/.test(block))
  const subjectBlock = blockFor(listing.text, subjectPid)
  const reporterBlock = blockFor(listing.text, reporterPid)

  checks.push({
    id: 'SESS-28',
    criterion: 'A hosted session can list every Claude Code session on the machine',
    title:
      'Every record this driver read for itself is in the listing, with a status, and the two hosted sessions are marked as Helm’s',
    ok:
      listing.ok &&
      registered &&
      // The fixture: a listing that named nothing could not fail the clause
      // below, so the driver's own read has to have found something first, and
      // it has to include the two sessions this group started.
      stable.length >= 2 &&
      stable.some((row) => row.pid === subjectPid) &&
      stable.some((row) => row.pid === reporterPid) &&
      missing.length === 0 &&
      // Hosted, in words, for both - and the caller marked exactly once.
      subjectBlock !== null &&
      reporterBlock !== null &&
      /\n {4}hosted {7}yes/.test(subjectBlock) &&
      /\n {4}hosted {7}yes/.test(reporterBlock) &&
      (listing.text.match(/\(this session\)/g) ?? []).length === 1 &&
      reporterBlock.split('\n')[0]?.includes('(this session)') === true &&
      // A status for every session listed, never an omission.
      blocks.length >= stable.length &&
      withStatus.length === blocks.length,
    detail: {
      subjectPid,
      reporterPid,
      registered,
      ownReadPids: stable.map((row) => row.pid),
      notInTheListing: missing.map((row) => row.pid),
      blocksListed: blocks.length,
      blocksWithAStatus: withStatus.length,
      statusLines: (listing.text.match(/status {7}.*/g) ?? []).slice(0, 12),
      answer: listing.text.slice(0, 2000)
    },
    notes: [
      'The second reader is this driver’s own parse of `~/.claude/sessions`, .json',
      'files only - the same credential filter the reader is held to.',
      'Read either side of the call and compared only over the records that were',
      'there both times, because the directory moves while this runs.',
      'The listing is machine-wide by design, so this asserts *containment* of the',
      'driver’s own read rather than equality with it: a session that started',
      'between the two reads is not a fault, and neither is the session in another',
      'Helm on this machine - which every run of this group lists.',
      'What is asserted about the whole listing is that every block in it carries a',
      'status, which is the "unknown, never omitted" rule and is a claim about the',
      'answer rather than about the machine.',
      'Exactly one "(this session)" mark, on the caller’s own pid: two would mean',
      'the mark came from something other than the token.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-29: one session's detail, checked against what the driver knows
  // -------------------------------------------------------------------------
  const passBefore = ctx.resources.lastPass()
  const subjectDetail = await callTool(url, reporterToken, 'session_detail', { pid: subjectPid })
  const passAfter = ctx.resources.lastPass()
  const subjectBranch = branchOf(second.path)
  /*
   * "The reporter's own directory is absent" only means something if the two
   * directories are tellable apart by a substring test. A project nested inside
   * another - which a harness root and a repository under it would be - would
   * make that clause fail on a correct answer, so it is asserted as a
   * precondition rather than left to make the probe lie either way.
   */
  const distinctTrees =
    !second.path.toLowerCase().startsWith(first.path.toLowerCase()) &&
    !first.path.toLowerCase().startsWith(second.path.toLowerCase())

  checks.push({
    id: 'SESS-29',
    criterion: 'A session Helm hosts can get detail for the ones Helm hosts',
    title:
      'The reporter’s answer about the other session names the working tree and branch this driver chose, and reports what it is holding from a pass the call itself caused',
    ok:
      subjectDetail.ok &&
      // The cwd is this driver's: it picked the project and launched into it.
      subjectDetail.text.includes(second.path) &&
      // And it is not the reporter's own, which is what a tool answering about
      // the caller whatever it was asked would produce.
      distinctTrees &&
      !subjectDetail.text.includes(first.path) &&
      subjectDetail.text.includes(`Helm tab     ${String(subject.id)}`) &&
      // The branch, read here with a different git command than the one that
      // wrote the column.
      (subjectBranch === null || subjectDetail.text.includes(subjectBranch)) &&
      // The tree came from a pass this call caused. Without the watch the tool
      // takes, this says "unknown - Helm has not looked" and the clause fails.
      passAfter !== null &&
      (passBefore === null || passAfter.atMs > passBefore.atMs) &&
      /^Holding /m.test(subjectDetail.text) &&
      !/Holding {6}unknown - Helm has not looked/.test(subjectDetail.text),
    detail: {
      askedAbout: subjectPid,
      expectedCwd: second.path,
      reporterCwd: first.path,
      expectedBranch: subjectBranch,
      expectedTab: subject.id,
      distinctTrees,
      passBefore,
      passAfter,
      passRan: passAfter !== null && (passBefore === null || passAfter.atMs > passBefore.atMs),
      holdingLine: (subjectDetail.text.match(/^Holding .*/m) ?? [])[0] ?? null,
      answer: subjectDetail.text.slice(0, 2000)
    },
    notes: [
      'Every value asserted is one this driver established itself: it chose the',
      'directory, it launched the session into it, and it read the branch back with',
      'a different git command than the one that wrote the column.',
      'The reporter’s own directory must be absent, so a tool that answered about',
      'the caller regardless of the pid fails.',
      'The process pass is watch-gated and runs for nobody by default. This asserts',
      'it moved *because of the call* - if `passRan` is false the tool did not take',
      'its watch, or something earlier in the run stopped the shared service.',
      'What the tree contains is deliberately not asserted: a claude at its prompt',
      'has no children, and through a .cmd shim it has exactly one. Both are',
      'honest answers and neither is a claim worth making here - SESS-21 to SESS-24',
      'are where the tree itself is measured.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-30: no tool returns any part of another session's conversation
  // -------------------------------------------------------------------------
  /*
   * The rule this whole surface is bounded by, asserted rather than inspected.
   *
   * The marker is in three places by construction: the subject's argv, its
   * screen, and its conversation - it was submitted as its first message. So a
   * tool that returned argv, terminal output or anything read out of a
   * transcript would put it in an answer. The fixture is proven discriminating
   * before any absence is believed: the driver checks the marker really is in
   * the argv and really is in the bytes the subject's pty produced.
   *
   * The token half is the other reason argv may never be returned, and it is
   * the sharper one: argv names the `--mcp-config` file, and that file holds
   * this session's bearer token for this endpoint.
   */
  const markerLanded = await waitFor(
    () => collector.output(subject.id).includes(nonce),
    180_000
  )
  const markerInArgv = subject.argv.some((word) => word.includes(nonce))
  const answers = [
    { call: 'sessions_list', answer: await callTool(url, reporterToken, 'sessions_list') },
    { call: 'session_detail (own)', answer: await callTool(url, reporterToken, 'session_detail') },
    {
      call: 'session_detail (the other)',
      answer: await callTool(url, reporterToken, 'session_detail', { pid: subjectPid })
    },
    {
      // Undeclared arguments, including the other session's own ids. The schema
      // refuses them and the server ignores them; either way the answer must be
      // the same one.
      call: 'session_detail (with forged identity arguments)',
      answer: await callTool(url, reporterToken, 'session_detail', {
        pid: subjectPid,
        sessionId: subject.claudeSessionId ?? '',
        helmSessionId: subject.id,
        token: subjectToken ?? ''
      })
    }
  ]
  // By name rather than by index: SESS-31 reads this same answer back, and an
  // index into a list somebody later reorders is a probe that quietly starts
  // asserting about a different call.
  const forged = answers.find(({ call }) => call.includes('forged'))?.answer ?? null

  /*
   * Each forbidden string named, so a red line says which rule broke.
   *
   * One probe covers several routes into the same rule - the opening prompt,
   * the argv, the ephemeral config path, the bearer tokens, the conversation id
   * - and "something leaked" would leave whoever reads the report to work out
   * which. The reason is carried instead.
   */
  const forbidden: Array<{ reason: string; needle: string }> = [
    { reason: 'the other session’s first message', needle: nonce },
    { reason: 'the argv flag', needle: '--mcp-config' },
    ...(subjectTools === null
      ? []
      : [{ reason: 'the other session’s token file', needle: subjectTools.file }]),
    ...(subjectToken === null
      ? []
      : [{ reason: 'the other session’s bearer token', needle: subjectToken }]),
    ...(reporterToken === null
      ? []
      : [{ reason: 'the caller’s own bearer token', needle: reporterToken }]),
    ...(subject.claudeSessionId === null
      ? []
      : [{ reason: 'the conversation id', needle: subject.claudeSessionId }])
  ]
  const leaked = answers.flatMap(({ call, answer }) =>
    forbidden
      .filter((entry) => answer.text.includes(entry.needle))
      .map((entry) => ({ call, reason: entry.reason }))
  )

  /*
   * And the same rule one level down: a **child process's command line**.
   *
   * This cannot be asserted against the sessions themselves, and the reason is
   * the one SESS-21 was defective over: a `claude` at its prompt has no
   * children, so an answer about one has no command line in it whatever the
   * code does. A tree that genuinely has depth and readable command lines is
   * available and needs no session driven into anything - **this process**,
   * which spawned the ptys. So the app's own shaping is run over a real pass
   * rooted here, and what it prints is required to carry the names and the
   * pids and none of the command lines the driver can read for itself.
   */
  const ownSnapshot = await readProcessSnapshot()
  const ownTree = sessionResources(-1, process.pid, ownSnapshot)
  const readableCommands = (ownTree.processes ?? []).filter(
    (row) => row.pid !== process.pid && row.commandLine !== null && row.commandLine.length > 12
  )
  const rendered = describeSessionDetail({
    // The session half is irrelevant to this clause and is filled with the
    // reporter's own facts rather than invented ones; what is under test is
    // what the *holding* half prints.
    session: {
      helmSessionId: reporter.id,
      pid: reporterPid,
      registered: true,
      cwd: first.path,
      name: reporter.name,
      activity: null,
      waitingFor: null,
      statusSinceMs: null,
      version: null,
      entrypoint: null,
      startedAtMs: null,
      claudeSessionId: null
    },
    hosted: {
      helmSessionId: reporter.id,
      branch: null,
      profile: null,
      overlays: [],
      startedAtMs: Date.now()
    },
    holding: heldBy(ownTree),
    readAtMs: Date.now(),
    isCaller: false
  })
  const commandsPrinted = readableCommands.filter((row) =>
    rendered.includes(row.commandLine ?? ' ')
  )
  const namesPrinted = readableCommands.filter((row) =>
    rendered.includes(`${row.name} #${String(row.pid)}`)
  )

  checks.push({
    id: 'SESS-30',
    criterion: 'No tool returns any part of another session’s conversation',
    title:
      'A marker submitted as the other session’s first message, and present in its argv and on its screen, appears in no tool answer - nor does its argv, its config file, its bearer token, its conversation id or any child process command line',
    ok:
      // The fixture first. Without both of these the absences below are
      // absences of something that was never there.
      markerInArgv &&
      markerLanded &&
      subjectTools !== null &&
      subjectToken !== null &&
      subject.claudeSessionId !== null &&
      answers.every(({ answer }) => answer.status === 200) &&
      leaked.length === 0 &&
      // And the command lines, over a tree that has some. The fixture is the
      // first clause: without readable command lines in a real tree of real
      // depth, "none of them was printed" is a claim about nothing.
      readableCommands.length >= 2 &&
      commandsPrinted.length === 0 &&
      // ...while the processes themselves *are* named, so this is a field
      // withheld rather than a tree that failed to render.
      namesPrinted.length === readableCommands.length,
    detail: {
      marker: nonce,
      markerInSubjectArgv: markerInArgv,
      markerOnSubjectScreen: markerLanded,
      subjectConfigFile: subjectTools?.file ?? null,
      subjectHasToken: subjectToken !== null,
      subjectConversationId: subject.claudeSessionId,
      calls: answers.map(({ call, answer }) => ({
        call,
        status: answer.status,
        ok: answer.ok,
        length: answer.text.length
      })),
      leaked,
      commandLines: {
        treeRootedAt: process.pid,
        processesInTree: ownTree.processes?.length ?? -1,
        withAReadableCommandLine: readableCommands.length,
        printedAnyway: commandsPrinted.map((row) => row.name),
        namedWithoutTheirCommandLine: namesPrinted.length,
        sample: readableCommands[0]?.commandLine?.slice(0, 60) ?? null
      }
    },
    notes: [
      'The marker is in the subject’s argv because Helm’s review launch puts an',
      'opening prompt there as a positional - which is exactly why a tool may',
      'never return argv, and why the shaping type in core has no field for it.',
      'The second reason is the token: argv names the --mcp-config file and that',
      'file holds the session’s bearer token for this endpoint, so returning argv',
      'would hand one session another’s credential.',
      'The conversation id is withheld too: it is the transcript’s filename under',
      '~/.claude/projects, so answering with it hands over the map to the thing',
      'this rule forbids.',
      'Both halves of the fixture are asserted before the absences are believed.',
      'The command-line half is measured over **this driver’s own process tree**',
      'rather than over a session’s, because a claude at its prompt has no',
      'children and an answer about one could not contain a command line however',
      'the code was written - the PROF-4 shape. This tree has depth and readable',
      'command lines, the shaping run over it is the app’s own, and the processes',
      'are required to be named while their command lines are not.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-35: waiting on the user, and the CLI's own sentence for why
  // -------------------------------------------------------------------------
  /*
   * The state the whole feature exists to surface, provoked rather than waited
   * for.
   *
   * "Busy" and "idle" turn up on their own; `waiting` is the one that decides
   * whether an agent should leave a tree alone, and it is the one a run can
   * finish without ever seeing. `/help` is the cheapest way in - any slash
   * command that renders a UI publishes `waiting` with `waitingFor: "dialog
   * open"`, and it costs no tokens.
   *
   * The subject's gate answerer is stopped first, deliberately: it presses
   * Enter at anything matching `mcpserver`, and the help listing names the
   * `/mcp` command - so it would dismiss the dialog this probe is provoking.
   */
  stopSubjectGates()
  const statusOf = (pid: number): { status: unknown; waitingFor: unknown } | null =>
    ownRegistryRead(registryDir).find((row) => row.pid === pid) ?? null
  /*
   * Wait for the subject to be *idle* before typing, and that is not caution.
   *
   * The marker landing on its screen means the prompt was **submitted**, not
   * answered - the turn is still running. Typed into a busy session, `/help`
   * goes into the composer and Enter queues it as the next *message*, which is
   * another model turn and no dialog at all. The probe would then sit for a
   * minute and report that `waiting` never happened, which is true of the
   * session and says nothing about the tools.
   */
  const subjectIdle = await waitFor(() => statusOf(subjectPid)?.status === 'idle', 180_000)
  ctx.sessions.input(subject.id, '/help\r')
  const reachedWaiting =
    subjectIdle && (await waitFor(() => statusOf(subjectPid)?.status === 'waiting', 60_000))
  const ownWaitingRecord = statusOf(subjectPid)
  const publishedReason =
    typeof ownWaitingRecord?.waitingFor === 'string' ? ownWaitingRecord.waitingFor : null
  const waitingListing = await callTool(url, reporterToken, 'sessions_list')
  const waitingBlock = blockFor(waitingListing.text, subjectPid)
  const waitingDetail = await callTool(url, reporterToken, 'session_detail', { pid: subjectPid })
  // Put it back, so the rest of the group is not talking to a session with a
  // dialog on top of it.
  ctx.sessions.input(subject.id, '\x1b')

  checks.push({
    id: 'SESS-35',
    criterion: 'The listing carries the status and the CLI’s own waitingFor',
    title:
      'A session driven into waiting is reported as waiting on the user, carrying the reason the CLI published, verbatim',
    ok:
      // The fixture: the CLI really did publish `waiting`, and it really did
      // publish a reason. Without both, the absence of a wrong answer below
      // would be the absence of any answer.
      reachedWaiting &&
      publishedReason !== null &&
      publishedReason !== '' &&
      waitingBlock !== null &&
      /status {7}waiting on the user \(/.test(waitingBlock) &&
      waitingBlock.includes(publishedReason) &&
      // Not the state it was in a moment ago, and not the one it will be in
      // next: a listing that had gone stale would say idle here.
      !/status {7}idle/.test(waitingBlock) &&
      waitingDetail.ok &&
      waitingDetail.text.includes(publishedReason),
    detail: {
      subjectPid,
      subjectIdleFirst: subjectIdle,
      reachedWaiting,
      ownReadOfTheRecord: ownWaitingRecord,
      publishedReason,
      listedAs: waitingBlock?.split('\n').find((line) => line.includes('status')) ?? null,
      detailSaid: (waitingDetail.text.match(/^status .*/m) ?? [])[0] ?? null
    },
    notes: [
      'The reason is read out of the record by this driver and required to appear',
      'in the answer **verbatim**. It is never matched against a list, because it',
      'comes from whatever dialog is on top - measured values on 2.1.238 are',
      '"dialog open" and "permission prompt".',
      'A permission prompt is the one that matters to a person and it cannot be',
      'provoked on a machine whose default permission mode is auto, which this one',
      'is. `/help` reaches the same field through a different dialog and costs no',
      'tokens.',
      'Asserted on both tools: a listing and a detail read the same field, and a',
      'surface that carried it in one and dropped it in the other would be half',
      'right in the way that is hardest to notice.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-31: attribution is the bearer token and nothing else
  // -------------------------------------------------------------------------
  const asReporter = await callTool(url, reporterToken, 'sessions_list')
  const asSubject = await callTool(url, subjectToken, 'sessions_list')
  const reporterOwn = await callTool(url, reporterToken, 'session_detail')
  const subjectOwn = await callTool(url, subjectToken, 'session_detail')
  // A token that is real but belongs to no session: what the endpoint hands a
  // registration that never became a launch.
  const strangerRegistration = host.register('sessions-check stranger')
  const strangerToken = strangerRegistration?.token ?? null
  const strangerList = await callTool(url, strangerToken, 'sessions_list')
  const strangerOwn = await callTool(url, strangerToken, 'session_detail')
  if (strangerToken !== null) host.release(strangerToken)

  const marks = (text: string): number => (text.match(/\(this session\)/g) ?? []).length
  /**
   * Which pid the mark actually landed on, so a red line names the fault.
   *
   * Counting the marks says the answer had one; it does not say it was the
   * right one, and a handler that took its identity from the app rather than
   * from the token still produces exactly one. Measured: under that fault the
   * mark moved to the *other* session's pid, and without this field the report
   * would have said only that a regex failed.
   */
  const markedPid = (text: string): number | null => {
    const line = text.split('\n').find((row) => row.includes('(this session)')) ?? ''
    return Number(/^#(\d+)/.exec(line)?.[1] ?? '') || null
  }

  checks.push({
    id: 'SESS-31',
    criterion: 'Attribution is the bearer token, never a session id the caller supplies',
    title:
      'The same call on the same server answers "this session" differently for two tokens, ignores a caller that names another session, and marks nothing at all for a token no session holds',
    ok:
      asReporter.ok &&
      asSubject.ok &&
      // One call, two tokens, two different answers about who is asking.
      marks(asReporter.text) === 1 &&
      marks(asSubject.text) === 1 &&
      new RegExp(`#${String(reporterPid)}[^\\n]*\\(this session\\)`).test(asReporter.text) &&
      new RegExp(`#${String(subjectPid)}[^\\n]*\\(this session\\)`).test(asSubject.text) &&
      // No pid: the token decides, and it decides differently for each.
      reporterOwn.ok &&
      subjectOwn.ok &&
      reporterOwn.text.includes(`Helm tab     ${String(reporter.id)}`) &&
      subjectOwn.text.includes(`Helm tab     ${String(subject.id)}`) &&
      // Naming the other session gets that session's detail - which is the
      // point of the tool - but never its identity: the earlier forged call is
      // still answered as the reporter.
      forged !== null &&
      !forged.text.includes('(this session)') &&
      // And a token with no session behind it is nobody: it may list, because
      // listing is not driving, and it has no "own" session to be told about.
      strangerList.ok &&
      marks(strangerList.text) === 0 &&
      !strangerOwn.ok,
    detail: {
      reporterPid,
      subjectPid,
      asReporterMarks: marks(asReporter.text),
      asSubjectMarks: marks(asSubject.text),
      // The whole of the attribution claim, in two numbers: the same call, two
      // tokens, and the mark has to move.
      markedForTheReporterToken: markedPid(asReporter.text),
      markedForTheSubjectToken: markedPid(asSubject.text),
      reporterOwnTab: reporter.id,
      subjectOwnTab: subject.id,
      forgedCallMarkedAsCaller: forged === null ? null : forged.text.includes('(this session)'),
      strangerMarks: marks(strangerList.text),
      strangerOwnRefused: !strangerOwn.ok,
      strangerSaid: strangerOwn.text.slice(0, 200)
    },
    notes: [
      'The discriminating pair is one call made twice with two tokens: a server',
      'that had a notion of "the current session" would answer both the same way.',
      'The forged call passed the other session’s conversation id, its Helm row id',
      'and its bearer token as undeclared arguments. It was answered for the',
      'caller regardless, because the answer never consults them.',
      'A registration that never became a session is a real token with no row',
      'behind it. It lists, because listing is not driving, and it is nobody.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-32: off is off, three ways, and independent of the browser tools
  // -------------------------------------------------------------------------
  const offHost = createBrowserMcp({
    browsers: ctx.browsers,
    settings: () => ({ ...ctx.services.settings, browserMcp: true, sessionMcp: false }),
    dir: join(mcpConfigDir, 'sessions-off-probe'),
    sessions: () => null
  })
  const offStarted = await offHost.start()
  const offRegistration = offHost.register('would-be session')
  const offPlan = prepareLaunch({
    root: homedir(),
    name: 'sessions-check argv with the session tools off',
    shimRoot: join(mcpConfigDir, 'sessions-off-shims'),
    mcp: offRegistration?.launch ?? null
  })
  const offDocument =
    offPlan.mcpConfigFile === null ? '' : readFileSync(offPlan.mcpConfigFile, 'utf8')
  await offHost.stop()
  // The probe's own file carries a token for an endpoint that is now shut, but
  // it is still a token file and this driver made it.
  if (offPlan.mcpConfigFile !== null) rmSync(offPlan.mcpConfigFile, { force: true })

  // And the live endpoint, with the setting taken away underneath it: the route
  // has to stop existing while the browser family goes on answering.
  const settingsBefore = ctx.services.settings
  ctx.services.settings = { ...settingsBefore, sessionMcp: false }
  const routeWhileOff = await rpc(url, reporterToken, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/list'
  })
  const browserWhileOff = await rpc(browserUrl, reporterToken, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/list'
  })
  const namesWhileOff = host.servedNames()
  ctx.services.settings = settingsBefore
  const routeRestored = await rpc(url, reporterToken, {
    jsonrpc: '2.0',
    id: nextRpcId++,
    method: 'tools/list'
  })

  checks.push({
    id: 'SESS-32',
    criterion: 'sessionMcp off means no registration, no tool in the list and nothing in any argv',
    title:
      'With the tick off the name is absent from the --mcp-config document, the route answers 404 to a valid token, and the browser tools are untouched',
    ok:
      // The argv half, through the real `prepareLaunch`.
      offStarted.started &&
      offRegistration !== null &&
      offRegistration.launch.servers.map((server) => server.name).join(',') === MCP_SERVER_NAME &&
      offPlan.mcpConfigFile !== null &&
      offDocument.includes(MCP_SERVER_NAME) &&
      !offDocument.includes(SESSION_TOOLS_SERVER_NAME) &&
      // The route half, on the live endpoint, to a token that worked a moment
      // ago and works again a moment later.
      routeWhileOff.status === 404 &&
      routeRestored.status === 200 &&
      // The independence half: this is why it is a second setting.
      browserWhileOff.status === 200 &&
      !namesWhileOff.includes(SESSION_TOOLS_SERVER_NAME) &&
      namesWhileOff.includes(MCP_SERVER_NAME),
    detail: {
      offEndpointStarted: offStarted,
      registeredNames: offRegistration?.launch.servers.map((server) => server.name) ?? null,
      argv: offPlan.argv,
      document: offDocument.replace(/Bearer [0-9a-f]+/g, 'Bearer <redacted>'),
      liveRoute: { whileOff: routeWhileOff.status, restored: routeRestored.status },
      browserRouteWhileOff: browserWhileOff.status,
      servedNamesWhileOff: namesWhileOff
    },
    notes: [
      'Three independent facts rather than one: what a launch is handed, what the',
      'listener answers, and what the endpoint says it is serving.',
      'The document is written by the real `prepareLaunch`, so this is the same code',
      'path a launch takes rather than a claim about it.',
      'The same token is used before, during and after, so "404" is about the',
      'setting rather than about authentication.',
      'The browser family answering 200 throughout is the argument for two',
      'settings rather than one, measured instead of asserted.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-33: a real session reports on another, through the CLI's own client
  // -------------------------------------------------------------------------
  /*
   * What the reporter came back with, read off the two facts rather than off a
   * format.
   *
   * The first run of this asked for `FOUND=TAB-NAME` and got
   * `FOUND=386:PR #900000 review - subject-6c1d65` - the right tab, the right
   * name, a colon where the prompt's placeholder had a dash. The model had done
   * exactly what it was asked; the assertion had been written about punctuation.
   * So what is required now is the **tab number immediately after `FOUND=`** and
   * the marker somewhere after it, and any separator at all is allowed. Both of
   * those are facts about the session it was reporting on, which is what the
   * probe is for.
   */
  const claimAfterFound = (): string => {
    const squashed = squash(collector.output(reporter.id))
    // `squash` lower-cases as well as stripping whitespace and ANSI, so the
    // needle has to go through it too. Looking for the literal `FOUND=` in a
    // lower-cased haystack finds nothing, forever - which is what the second
    // run of this reported, over an answer that was on screen and correct.
    const needle = squash('FOUND=')
    const at = squashed.lastIndexOf(needle)
    return at === -1 ? '' : squashed.slice(at + needle.length, at + needle.length + 160)
  }
  const reported = await waitFor(() => /^\d/.test(claimAfterFound()), 300_000)
  const claim = claimAfterFound()
  const claimedTab = /^(\d+)/.exec(claim)?.[1] ?? null
  const reporterSaid = stripAnsi(collector.output(reporter.id)).replace(/\s+/g, ' ').trim()
  const shot = await screenshot(ctx.win, shotDir, 'sessions-tools-report.png')

  checks.push({
    id: 'SESS-33',
    criterion:
      'A real session, launched through the app, reports on another session it was told nothing about',
    title:
      'A claude given only the tools finds the other session by its directory and answers with the Helm tab number and name this driver gave it',
    ok:
      reported &&
      claimedTab === String(subject.id) &&
      // The name too, not only the tab: the marker is random per run, so it
      // cannot have come from anywhere but an answer about that session.
      claim.includes(squash(marker)),
    detail: {
      expected: `FOUND=${String(subject.id)} ${subject.name}`,
      claimed: claim.slice(0, 80),
      claimedTab,
      marker,
      subjectTab: subject.id,
      subjectName: subject.name,
      subjectCwd: second.path,
      found: reported,
      said: reporterSaid.slice(-1200)
    },
    notes: [
      'The whole chain, and the only probe here that exercises it: Helm wrote the',
      'config file, the CLI read it, connected over loopback with the token, listed',
      'the tools and called them.',
      'The Helm tab number is the load-bearing half. A session’s name is in the',
      'registry file and a model with a shell could have read it there, but the tab',
      'number is Helm’s own row id and appears in no file on this machine - the',
      'only route to it is one of these two tools.',
      'Which of the two is deliberately not pinned, and that was measured rather',
      'than assumed: a mutation that made *session_detail* report the wrong tab',
      'left this green, because sessions_list carries the tab as well and the model',
      'took it from there. A mutation that made **both** report the wrong tab turns',
      'it red. So what this asserts is that a real session reached the tools and',
      'answered with something only they know - not which tool answered, which is',
      'SESS-29’s question and is asked there over the wire.',
      'The prompt says to use the tools and nothing else. That is an instruction',
      'rather than a guarantee, which is why the assertion rests on the number.',
      'The separator between the two facts is deliberately not asserted. The first',
      'run answered `FOUND=386:PR #900000 review - subject-6c1d65` where the prompt',
      'had shown a dash, which was the probe being about punctuation rather than',
      'about the tools.'
    ]
  })

  // -------------------------------------------------------------------------
  // SESS-34: a session that ended between the listing and the detail
  // -------------------------------------------------------------------------
  const beforeEnd = await callTool(url, reporterToken, 'session_detail', { pid: subjectPid })
  await ctx.sessions.close({ id: subject.id, force: true })
  const gone = await waitFor(() => !processAlive(subjectPid), 60_000)
  // The registry pass is 750ms and the tool re-reads on every call, so this is
  // about a record the reader must refuse rather than about a poll interval.
  await sleep(1500)
  const afterEnd = await callTool(url, reporterToken, 'session_detail', { pid: subjectPid })
  const listingAfterEnd = await callTool(url, reporterToken, 'sessions_list')

  checks.push({
    id: 'SESS-34',
    criterion: 'A session that has exited between the listing and the detail gets an honest answer',
    title:
      'The same call that answered a moment ago with the session’s detail now says there is no session with that pid, and the listing has dropped it',
    ok:
      // The discriminating half: the identical call worked immediately before.
      beforeEnd.ok &&
      beforeEnd.text.includes(second.path) &&
      gone &&
      // And now it is an honest refusal rather than the answer from before.
      !afterEnd.ok &&
      afterEnd.text.includes(`No Claude Code session with pid ${String(subjectPid)}`) &&
      !afterEnd.text.includes(second.path) &&
      !/Holding/.test(afterEnd.text) &&
      listingAfterEnd.ok &&
      !listingAfterEnd.text.includes(`#${String(subjectPid)}`),
    detail: {
      pid: subjectPid,
      processGone: gone,
      before: { ok: beforeEnd.ok, length: beforeEnd.text.length },
      after: { ok: afterEnd.ok, said: afterEnd.text.slice(0, 400) },
      stillListed: listingAfterEnd.text.includes(`#${String(subjectPid)}`),
      screenshot: shot.file
    },
    notes: [
      'The before half is what makes the after half a claim: the same call, the',
      'same pid, the same token, answered fully a moment earlier.',
      'A stale record is what this is about. Claude Code removes its own record on',
      'a clean exit and leaves it on a hard kill; either way the reader’s liveness',
      'filter is what has to refuse it, and the answer must not be the last one it',
      'could have given.'
    ]
  })

  stopReporterGates()
  await ctx.sessions.close({ id: reporter.id, force: true })
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
