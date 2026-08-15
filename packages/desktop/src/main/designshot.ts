import type { BrowserWindow } from 'electron'
import {
  readPull,
  replaceRepoPulls,
  writePullDetail,
  type PullDetail,
  type PullSummary,
  type Store
} from '@helm/core'
import type { CheckContext } from './sessionscheck'
import { drag, screenshot, sendMouse, sleep } from './bridge'

/**
 * `--design-shot`: open the real window, walk the main views, and capture a
 * screenshot of each in both themes.
 *
 * Not a check - nothing is asserted. It exists so that "does the app still
 * follow docs/DESIGN.md" is answered by looking at the app rather than at the
 * class names, and so a design review has current evidence without anyone
 * clicking through five panes twice.
 *
 * The one place it prints numbers rather than only writing files is the
 * `responsive` group, and for the reason DESIGN.md gives for measuring an edge
 * in the PNG: a header that has run out of room does not look wrong in a
 * thumbnail, it looks slightly tight, and the difference between the two is a
 * `scrollWidth` nobody can eyeball.
 */

/** The groups `--only=` can name. The one authority for the list. */
const GROUPS = ['views', 'states', 'responsive', 'split', 'tabs'] as const
type Group = (typeof GROUPS)[number]

function wantedGroups(): ReadonlySet<Group> {
  const arg = process.argv.find((a) => a.startsWith('--only='))
  if (arg === undefined) return new Set(GROUPS)
  const asked = arg
    .slice('--only='.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  const known = asked.filter((a): a is Group => (GROUPS as readonly string[]).includes(a))
  for (const a of asked) {
    if (!known.includes(a as Group)) console.error(`design-shot: no such group: ${a}`)
  }
  return new Set(known)
}

async function js<T>(win: BrowserWindow, expression: string): Promise<T> {
  return (await win.webContents.executeJavaScript(expression, true)) as T
}

async function pollJs(win: BrowserWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await js<boolean>(win, `Boolean(${expression})`).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Click one project row, found by the path it carries as its `title`.
 *
 * Compared in JavaScript rather than matched with `[title="..."]`, because a
 * Windows path is full of backslashes and a backslash is an escape character in
 * a CSS string too - the selector would have to be escaped twice, and the shape
 * that only fails on paths with a `\U` or a `\t` in them is the shape that
 * fails on somebody else's machine.
 */
async function clickProjectRow(win: BrowserWindow, path: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const want = ${JSON.stringify(path.toLowerCase())};
      const el = [...document.querySelectorAll('aside nav button[title]')]
        .find((b) => b.title.toLowerCase() === want);
      if (!el) return false; el.click(); return true })()`
  )
}

/**
 * Every open tab closed, so an empty workspace is a state the walk can get
 * back to - the second theme pass starts where the first one left off. Scoped
 * to the tab strip: other things on screen have close buttons too.
 *
 * One close per turn of the event loop, re-querying each time, rather than a
 * `for` over one `querySelectorAll`. That earlier shape left the strip **fully
 * populated** and the light pass photographed the dark pass's last pane as
 * `welcome-light.png` - the exact failure the anchors below were written to
 * stop, which `welcome` was exempt from for having none. A static NodeList
 * taken before the first click holds nodes React detaches as it re-renders the
 * strip, and a click on a detached button is a no-op that reports nothing.
 *
 * Returns what is left, because "closed them all" is not a claim a loop that
 * clicked into the void can make - and this one made it for as long as it
 * existed.
 */
async function closeAllTabs(win: BrowserWindow): Promise<number> {
  return js<number>(
    win,
    `(async () => {
      const strip = () => document.querySelectorAll('[role="tablist"] button[aria-label^="Close "]')
      // A plain timeout rather than requestAnimationFrame: Chromium throttles
      // rAF to nothing while the window is occluded, which is the normal state
      // of a window a check drives on a machine somebody is working on.
      const settle = () => new Promise((r) => setTimeout(r, 40))
      for (let guard = 0; guard < 40; guard++) {
        const next = strip()[0]
        if (!next) break
        next.click()
        await settle()
      }
      return strip().length
    })()`
  )
}

/**
 * Wait until the window has drawn what the DOM already says.
 *
 * `capturePage` hands back the **last frame the compositor produced**, not a
 * fresh render of the current tree, so a click that has already reconciled can
 * still be photographed as the view before it - which is how this walk came to
 * write a Pull requests file holding the Session history pane. Two animation
 * frames is the ordinary "React has committed and the compositor has drawn it"
 * wait.
 *
 * The `setTimeout` beside it is not belt-and-braces. Chromium throttles
 * `requestAnimationFrame` to nothing while a window is occluded - which is the
 * normal state of a window a check is driving on a machine somebody is working
 * on - and without the timeout this would hang there rather than take the
 * photograph it was asked for.
 */
async function drawn(win: BrowserWindow): Promise<void> {
  await js<boolean>(
    win,
    `new Promise((resolve) => {
       const done = () => resolve(true)
       requestAnimationFrame(() => requestAnimationFrame(done))
       setTimeout(done, 1200)
     })`
  ).catch(() => false)
}

/**
 * The views worth looking at, how to reach each from the sidebar, and the one
 * element that proves the walk arrived.
 *
 * The anchor is the part that is not decoration. A walk that clicks and then
 * photographs whatever is on screen writes a file named for a view it may
 * never have reached, and a wrong screenshot is worse than a missing one - it
 * is reviewed as though it were the thing it is named after. The anchors are
 * written out here rather than imported from `affordancecheck.ts`'s table, so
 * this driver states for itself what "arrived" means.
 */
const VIEWS: Array<{ name: string; selector: string | null; anchor: string | null }> = [
  // Nothing open. Reached by the close-everything above rather than a click,
  // hence the null selector. It is anchored like everything else, though the
  // reading is inverted: the anchor is the empty state's own pane, and what it
  // rules out is a *leftover* view being shot under this name. It was exempt
  // once, on the argument that a window with no pane in it has nothing to
  // anchor on, and that is how `welcome-light.png` came to hold the Pull
  // requests pane for as long as `closeAllTabs` was silently closing nothing.
  { name: 'welcome', selector: null, anchor: '[data-welcome-pane]' },
  // First project row in the tree - the launcher's home view.
  { name: 'project', selector: 'aside nav button[title]', anchor: '[data-project-pane]' },
  { name: 'config', selector: '[data-open-config]', anchor: '[data-config-scope]' },
  { name: 'content', selector: '[data-open-content]', anchor: '[data-content-scope]' },
  { name: 'history', selector: '[data-open-history]', anchor: '[data-history-search]' },
  // Painted from the cache, so it has rows whether or not a fetch has happened
  // on this run - and it is the one list in the app whose rows are almost all
  // chips and mono, which is where a tone that only works in one theme shows.
  { name: 'pulls', selector: '[data-open-pulls]', anchor: '[data-pulls-refresh]' },
  // The gear, not a sidebar row: settings is a window-level place. It is the
  // longest page in the app and the one most likely to grow a control that
  // does not match the others, which is exactly what a shot is for.
  { name: 'settings', selector: '[data-open-settings]', anchor: '[data-settings-pane]' }
]

const THEME_LABEL = {
  system: 'Match the system theme',
  light: 'Light theme',
  dark: 'Dark theme'
} as const

/** The ignore list, written the way the settings pane writes it. */
async function writeIgnored(win: BrowserWindow, slugs: string[]): Promise<void> {
  await js<void>(
    win,
    `window.helm.invoke('settings:write', { prIgnoredRepos: ${JSON.stringify(slugs)} }).then(() => undefined)`
  ).catch(() => undefined)
}

/**
 * The Pulls pane with something ignored, then put back.
 *
 * Ignores whichever repository the snapshot happens to have first, because the
 * shot is of the *state* and not of any particular repository - and returns
 * null rather than an empty pane when there is nothing to ignore, which is the
 * honest answer on a machine with no github.com remotes on it.
 *
 * A machine that already ignores something needs none of this: the plain
 * `pulls-*` shot above is already carrying the state.
 */
async function shootIgnored(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  found: string[]
): Promise<string | null> {
  if (found.length > 0) return null
  const slug = await js<string | null>(
    win,
    `window.helm.invoke('pr:snapshot').then((s) => s.repos[0] ? s.repos[0].slug : null)`
  ).catch(() => null)
  if (slug === null) return null

  await writeIgnored(win, [slug])
  await sleep(700)
  const shot = await screenshot(win, outDir, `pulls-ignored-${theme}.png`)
  await writeIgnored(win, found)
  await sleep(400)
  return shot.file
}

/**
 * The transcript viewer, and the state where there is nothing to view.
 *
 * Two shots because the pane now has two answers for a session Claude Code has
 * reaped, and they look nothing alike: a conversation Helm kept before the reap
 * (a read-only transcript, which is the longest run of prose anywhere in the
 * app and the one place a list of mixed-length paragraphs has to hold a rhythm),
 * and a session that was gone before Helm ever saw it (a panel of explanation,
 * with the prompts underneath it).
 *
 * Both are found by asking the database which sessions are in each state rather
 * than by clicking down the list, because which sessions those are is a
 * property of the machine and not of the walk. Either returns null out loud
 * where the machine has none - a fresh install has no archive yet, and a shot
 * of the wrong state is worse than a missing one.
 *
 * Waits for the archive first. On a machine with 311 MB of transcripts the
 * first catch-up is twenty chunks over as many ticks, and a shot taken during
 * it is a photograph of a progress state nobody will ever see twice.
 */
async function shootTranscript(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  store: Store
): Promise<string[]> {
  const files: string[] = []

  const archived = await (async () => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const row = store.raw
        .prepare(
          `SELECT session_id FROM transcript_sessions
           WHERE state = 'archived' AND message_count BETWEEN 6 AND 40
           ORDER BY message_count DESC LIMIT 1`
        )
        .get() as { session_id: string } | undefined
      if (row !== undefined) return row.session_id
      await sleep(500)
    }
    return null
  })()

  // A session the archive never had: reaped before Helm ever looked at it.
  const never = store.raw
    .prepare(
      `SELECT s.session_id FROM history_sessions s
       LEFT JOIN transcript_sessions a ON a.session_id = lower(s.session_id)
       WHERE s.transcript_file IS NULL AND a.session_id IS NULL AND s.prompt_count BETWEEN 3 AND 12
       ORDER BY s.last_at DESC LIMIT 1`
    )
    .get() as { session_id: string } | undefined

  const open = async (sessionId: string, wait: string): Promise<boolean> => {
    if (!(await click(win, '[data-open-history]'))) return false
    await sleep(400)
    if (!(await click(win, `button[data-session="${sessionId}"]`))) return false
    return pollJs(win, wait, 8000)
  }

  if (archived === null) {
    console.error('design-shot: nothing archived yet, so no transcript to photograph')
  } else if (await open(archived, `document.querySelector('[data-transcript]')`)) {
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-transcript]');
        if (el) el.scrollIntoView({ block: 'start' }) })()`
    )
    await sleep(400)
    files.push((await screenshot(win, outDir, `history-transcript-${theme}.png`)).file)
  }

  if (never === undefined) {
    console.error('design-shot: no session on this machine was reaped before Helm saw it')
  } else if (await open(never.session_id, `document.querySelector('[data-unavailable]')`)) {
    await sleep(300)
    files.push((await screenshot(win, outDir, `history-archive-empty-${theme}.png`)).file)
  }

  return files
}

/** The pinned list, written the way the sidebar's star writes it. */
async function writePinned(win: BrowserWindow, paths: string[]): Promise<void> {
  await js<void>(
    win,
    `window.helm.invoke('settings:write', { pinnedProjects: ${JSON.stringify(paths)} }).then(() => undefined)`
  ).catch(() => undefined)
}

/**
 * The sidebar with a Pinned section, and with one pin whose folder has gone.
 *
 * The `welcome` shot above already carries the sidebar in whatever pinned state
 * the machine is in, which on most machines is none - so this is the *other*
 * state, and it is arranged rather than waited for: three projects taken from
 * across the tree, so the section is visibly cross-harness, plus a path that
 * was never a project, which is the only way to photograph the `folder gone`
 * row. That last one is the picture with something to get wrong: a badge, a
 * dimmed name and no launch, in a rail 280px wide.
 *
 * Restored afterwards, like the theme and the ignore list: a screenshot run
 * must not repaint the user's app.
 */
async function shootPinned(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  pinnedBefore: string[]
): Promise<string | null> {
  const paths = await js<string[]>(
    win,
    `[...document.querySelectorAll('aside nav button[title]')].map((b) => b.title)`
  ).catch(() => [])
  if (paths.length < 2) {
    console.error('design-shot: too few project rows to pin any')
    return null
  }

  // Spread across the tree rather than the first three, which on a machine
  // organised into harnesses are three rows of one harness - and a section
  // holding one harness's projects is exactly the picture that cannot show
  // whether the section is flat.
  const picked = [...new Set([paths[0], paths[Math.floor(paths.length / 2)], paths.at(-1)])].filter(
    (path): path is string => path !== undefined
  )
  const gone = `${picked[0] ?? ''}-that-is-not-there`
  console.log(`design-shot: pinning ${String(picked.length)} projects plus one gone folder`)

  await writePinned(win, [...picked, gone])
  await sleep(700)
  const shot = await screenshot(win, outDir, `sidebar-pinned-${theme}.png`)
  await writePinned(win, pinnedBefore)
  await sleep(400)
  return shot.file
}

/**
 * The project pane of a project the pull-request surface knows about.
 *
 * The `project` shot above is whatever the tree lists first, which on a machine
 * organised into harnesses is the harness - not a git repository, so its pane
 * paints neither a branch nor the pull-request panel. Those are a third of what
 * the pane draws and nothing else in the walk reaches them.
 *
 * A repository with something open is preferred over a quiet one: an empty
 * panel and a panel full of rows are different pictures, and the rows are the
 * half that can go wrong. Returns null where there are no github.com remotes on
 * the machine, which is honest - the alternative is a second copy of the shot
 * that was just taken.
 */
async function shootProjectRepo(
  win: BrowserWindow,
  outDir: string,
  theme: string
): Promise<string | null> {
  const path = await js<string | null>(
    win,
    `window.helm.invoke('pr:snapshot').then((s) => {
       const busy = s.repos.find((r) => r.pulls.length > 0)
       const repo = busy ?? s.repos[0]
       return repo ? repo.path : null
     })`
  ).catch(() => null)
  if (path === null) return null
  if (!(await clickProjectRow(win, path))) {
    // A repository outside every scanned root has a row in the snapshot and no
    // row in the tree. Worth saying, because the alternative is a silently
    // missing shot that reads as a broken selector.
    console.error(`design-shot: no sidebar row for ${path}`)
    return null
  }
  await sleep(600)
  const shot = await screenshot(win, outDir, `project-repo-${theme}.png`)
  return shot.file
}

/**
 * The content pane as a **file tree**, which the walk cannot reach on its own.
 *
 * The walk opens the first scope, which on a machine organised into harnesses
 * is a harness, and a harness defaults to the curated view - so without this
 * the second of the pane's two modes is never photographed. It is the same
 * argument the repository shot makes for the project pane, and the same one the
 * crowded tab strip makes: the shot that matters is often a *state* rather than
 * a view.
 *
 * `packages/` is expanded when it is there so the shot carries a nested level;
 * a tree drawn one level deep does not show whether the indent works. The pane
 * is put back on Curated afterwards, because the next theme's walk starts from
 * whatever this one left.
 */
async function shootContentTree(
  win: BrowserWindow,
  outDir: string,
  theme: string
): Promise<string | null> {
  if (!(await click(win, '[data-content-view="tree"]'))) {
    console.error('design-shot: the content pane has no Tree control')
    return null
  }
  await sleep(900)
  // Whichever directory the scope actually has, rather than a name written
  // down here - one level of nesting is the point, not which one.
  await js<void>(
    win,
    `(() => {
       const rows = [...document.querySelectorAll('[data-content-tree-entry][aria-expanded="false"]')];
       const first = rows[0];
       if (first) first.click();
     })()`
  ).catch(() => undefined)
  await sleep(900)
  const shot = await screenshot(win, outDir, `content-tree-${theme}.png`)
  await click(win, '[data-content-view="curated"]')
  await sleep(500)
  return shot.file
}

/** The project shell's height, written the way its drag handle writes it. */
async function writeShellHeight(win: BrowserWindow, pct: number): Promise<void> {
  await js<void>(
    win,
    `window.helm.invoke('settings:write', { projectShellHeightPct: ${String(pct)} }).then(() => undefined)`
  ).catch(() => undefined)
}

/**
 * The project page at each end of what the shell's handle can reach.
 *
 * The `project` shots above are the default third, which is the state the page
 * was designed around and the only one anything used to be able to be in. The
 * two ends are where the page has to still look like a page: at half, a
 * project pane holding the same six panels in half the room, and at the floor,
 * a terminal island short enough that its own header is a third of it. Neither
 * is reachable by clicking through the walk, and both are now one drag away
 * from anybody.
 *
 * The floor is written as the *percentage* floor and drawn at the pixel one -
 * 10% of any ordinary column is under 180px, so what this photographs is the
 * clamp rather than the number.
 *
 * It prints the numbers beside the files for the reason `responsive` does. The
 * argument the default rests on is a row count - 15 is where PSReadLine turns
 * its ListView off - and a row count is exactly what a thumbnail cannot be
 * measured for.
 *
 * Write/shoot/restore, like the pinned sidebar and the ignore list: a design
 * run must not leave the user's shell at half the page.
 */
async function shootShellHeights(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  before: number
): Promise<string[]> {
  const files: string[] = []
  for (const [name, pct] of [
    ['floor', 10],
    ['half', 50],
    ['default', 30]
  ] as const) {
    await writeShellHeight(win, pct)
    await sleep(700)
    const at = await js<{ pane: number; column: number; rows: number; cols: number } | null>(
      win,
      `(() => {
        const pane = document.querySelector('[data-project-shell]')
        if (!pane || !pane.parentElement) return null
        const term = window.__helmTerminals().shells.find((s) => s.attached)
        return {
          pane: Math.round(pane.getBoundingClientRect().height),
          column: Math.round(pane.parentElement.getBoundingClientRect().height),
          rows: term ? term.rows : -1,
          cols: term ? term.cols : -1
        }
      })()`
    ).catch(() => null)
    console.log(
      `design-shot: shell ${name.padEnd(7)} (${theme}) ` +
        (at === null
          ? 'no project shell on screen'
          : `${String(at.pane)}px of ${String(at.column)} - ${String(at.cols)}x${String(at.rows)}` +
            `${at.rows >= 15 ? '' : '  (under PSReadLine’s 15-row ListView threshold)'}`)
    )
    files.push((await screenshot(win, outDir, `project-shell-${name}-${theme}.png`)).file)
  }
  await writeShellHeight(win, before)
  await sleep(400)
  return files
}

/** One planted pull request, in the shape the cache holds. */
function densePull(options: {
  number: number
  title: string
  author: string
  head: string
  ageMs: number
  additions: number
  deletions: number
  isDraft?: boolean
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED'
  checks?: { total: number; failing: number; pending: number }
}): PullSummary {
  const at = Date.now() - options.ageMs
  return {
    number: options.number,
    title: options.title,
    url: `https://github.com/planted/pull/${String(options.number)}`,
    author: options.author,
    authorIsBot: options.author.startsWith('app/'),
    state: 'OPEN',
    isDraft: options.isDraft ?? false,
    headRefName: options.head,
    baseRefName: 'main',
    createdAt: at - 6 * 24 * 60 * 60 * 1000,
    updatedAt: at,
    additions: options.additions,
    deletions: options.deletions,
    changedFiles: 4,
    reviewDecision: options.reviewDecision ?? null,
    checks: options.checks ?? { total: 4, failing: 0, pending: 0 },
    labels: []
  }
}

/**
 * The Pulls pane with a busy GitHub behind it: ACTIVE and STALE both holding
 * rows, and the same list again under `GROUP: Repo`.
 *
 * **Planted in the cache and taken out again**, the same write/shoot/restore
 * the review threads and the ignore list use, and for the same reason: this
 * run's `gh` is the real one, so what is on screen is whatever the developer's
 * own repositories happen to have - one open pull request on the machine this
 * was written on - and the ACTIVE/STALE split, the chips and the grouping are
 * then states nobody can look at. Planting is also the honest code path: the
 * pane paints the cache, which is exactly what a person meets after a fetch.
 *
 * The ages are **relative to now and straddle the cutoff on purpose**. The
 * split is a comparison against a clock, so a fixture carrying dates would
 * photograph a different pane every month and eventually stop covering the
 * thing it is named for. The cutoff itself is set here and put back, like every
 * other setting this walk drives.
 *
 * Returns the files it wrote, and says so and returns none when the machine has
 * fewer than two github.com repositories to plant into - a grouped shot with
 * one group in it is not the state this exists to show.
 */
async function shootPullsDense(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  ctx: CheckContext,
  staleBefore: number
): Promise<string[]> {
  const files: string[] = []
  const snapshot = ctx.pulls.snapshot()
  const targets = snapshot.repos.filter((repo) => repo.slug !== null).slice(0, 3)
  if (targets.length < 2) {
    console.error('design-shot: fewer than two github.com repositories, so no dense pulls shot')
    return files
  }

  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  // Two of the three touched repositories get both halves of the split, so
  // grouping by repository has more than one group on each side of it.
  const planted: PullSummary[][] = [
    [
      densePull({
        number: 418,
        title: 'Fix session-restore race on cold start',
        author: 'busy-dev',
        head: 'fix/session-restore-race',
        ageMs: 40 * 60 * 1000,
        additions: 61,
        deletions: 12,
        checks: { total: 5, failing: 0, pending: 0 }
      }),
      densePull({
        number: 417,
        title: 'Persist harness filter across restarts',
        author: 'busy-dev',
        head: 'feat/harness-filter-persist',
        ageMs: 5 * HOUR,
        additions: 24,
        deletions: 3,
        reviewDecision: 'CHANGES_REQUESTED',
        checks: { total: 5, failing: 2, pending: 0 }
      }),
      densePull({
        number: 402,
        title: 'Overnight digest: summarize failed runs first',
        author: 'app/overnight-bot',
        head: 'digest/failed-first',
        ageMs: 26 * HOUR,
        additions: 118,
        deletions: 40
      }),
      densePull({
        number: 203,
        title: 'Report builder: custom date ranges',
        author: 'second-dev',
        head: 'report/date-ranges',
        ageMs: 3 * DAY,
        additions: 88,
        deletions: 12,
        checks: { total: 2, failing: 0, pending: 0 }
      }),
      densePull({
        number: 57,
        title: 'Dark-surface token ramp cleanup',
        author: 'second-dev',
        head: 'design/dark-ramp',
        ageMs: 5 * DAY,
        additions: 30,
        deletions: 140,
        // Stale *and* red, which is the row the whole "one rule, all the signal
        // on the chip" decision is about. It has to be visible on a chip.
        checks: { total: 3, failing: 2, pending: 0 }
      })
    ],
    [
      densePull({
        number: 86,
        title: 'Batch time-entry sync writes',
        author: 'second-dev',
        head: 'perf/batched-sync',
        ageMs: 3 * HOUR,
        additions: 210,
        deletions: 96,
        checks: { total: 4, failing: 0, pending: 3 }
      }),
      densePull({
        number: 85,
        title: 'Offline queue: retry with backoff',
        author: 'third-dev',
        head: 'fix/offline-retry',
        ageMs: 30 * HOUR,
        additions: 44,
        deletions: 9,
        isDraft: true
      }),
      densePull({
        number: 12,
        title: 'Pathfinding avoids lit tiles at night',
        author: 'third-dev',
        head: 'ai/lit-tiles',
        ageMs: 9 * DAY,
        additions: 260,
        deletions: 40,
        checks: { total: 0, failing: 0, pending: 0 }
      })
    ],
    [
      densePull({
        number: 9,
        title: 'Teach the sweeper about forks',
        author: 'busy-dev',
        head: 'feature/forks',
        ageMs: 8 * HOUR,
        additions: 412,
        deletions: 96,
        reviewDecision: 'APPROVED'
      })
    ]
  ]

  const before = targets.map((repo) => ({ slug: repo.slug ?? '', pulls: repo.pulls }))
  const fetchedAt = new Date().toISOString()
  try {
    // Two days, so the ages above land either side of it whatever the developer
    // has this set to. Written through the real channel, like the ignore list.
    await js<void>(
      win,
      `window.helm.invoke('settings:write', { prStaleDays: 2 }).then(() => undefined)`
    ).catch(() => undefined)
    targets.forEach((repo, at) => {
      replaceRepoPulls(ctx.services.store, repo.slug ?? '', planted[at] ?? [], fetchedAt)
    })
    ctx.pulls.republish()
    await click(win, '[data-open-pulls]')
    const split = await pollJs(win, `document.querySelector('[data-pulls-section="stale"]')`, 10_000)
    if (!split) {
      console.error('design-shot: the planted pull requests never split into ACTIVE and STALE')
      return files
    }
    await drawn(win)
    files.push((await screenshot(win, outDir, `pulls-dense-${theme}.png`)).file)

    // The same list arranged by repository, which is the control's whole
    // point and the one thing a flat shot cannot show.
    await click(win, '[data-pulls-group="repo"]')
    const grouped = await pollJs(win, `document.querySelector('[data-pulls-group-heading]')`, 5_000)
    if (!grouped) console.error('design-shot: GROUP: Repo drew no headings')
    await drawn(win)
    files.push((await screenshot(win, outDir, `pulls-dense-grouped-${theme}.png`)).file)
    await click(win, '[data-pulls-group="none"]')
    await sleep(200)
  } finally {
    for (const repo of before) replaceRepoPulls(ctx.services.store, repo.slug, repo.pulls, fetchedAt)
    await js<void>(
      win,
      `window.helm.invoke('settings:write', { prStaleDays: ${String(staleBefore)} }).then(() => undefined)`
    ).catch(() => undefined)
    ctx.pulls.republish()
    await sleep(300)
  }
  return files
}

/**
 * A pull request's Conversation, with review threads in it.
 *
 * Two clicks past everything else in this walk, and the one view whose hardest
 * design question - does a thread *read* as one entity - cannot be answered
 * from any of the shots above. It carries the states worth arguing over at
 * once: an open thread with replies indented under a hairline, a resolved one
 * collapsed to its header, an outdated one whose header shows the original line
 * because it has no current one, and a review with a verdict and no body, which
 * is what a review made entirely of inline notes looks like.
 *
 * The threads are **planted in the cache and taken out again**, the same
 * write/shoot/restore the pinned sidebar and the ignore list use. Nothing else
 * would do: this run's `gh` is the real one, so what is on the machine is
 * whatever the developer's own repositories happen to have, and a shot that is
 * empty on most machines is a shot nobody looks at. Planting is also the honest
 * code path - `pr:detail` paints a held detail without running gh at all, which
 * is exactly what a person opening a cached pull request gets.
 */
async function shootPullThreads(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  store: Store
): Promise<string | null> {
  const found = await js<{ path: string; slug: string; number: number } | null>(
    win,
    `window.helm.invoke('pr:snapshot').then((s) => {
       const repo = s.repos.find((r) => r.pulls.length > 0)
       return repo ? { path: repo.path, slug: repo.slug, number: repo.pulls[0].number } : null
     })`
  ).catch(() => null)
  if (found === null) {
    console.error('design-shot: no cached pull request to open, so no thread shot')
    return null
  }

  const row = readPull(store, found.slug, found.number)
  if (row === null) {
    console.error(`design-shot: ${found.slug}#${String(found.number)} is not in the cache`)
    return null
  }
  const before = row.detail

  writePullDetail(store, found.slug, found.number, threadFixture(before))
  await click(win, '[data-open-pulls]')
  await sleep(400)
  await click(win, `[data-pull="${found.slug}#${String(found.number)}"]`)
  const opened = await pollJs(win, `document.querySelector('[data-pr-thread]')`, 20_000)
  if (!opened) console.error('design-shot: the planted threads never painted')
  await sleep(700)
  const shot = await screenshot(win, outDir, `pr-threads-${theme}.png`)

  // The tab goes, then the row goes back. The tab first, because the pane holds
  // what it painted and would put the planted threads back on screen otherwise.
  await closeAllTabs(win)
  await sleep(300)
  if (before !== null) writePullDetail(store, found.slug, found.number, before)
  return shot.file
}

/**
 * A detail with three threads on it, built onto whatever was cached.
 *
 * Built **onto** rather than instead of: the body, the commits and the file
 * list are the pull request's real ones, so the shot is of Helm's layout rather
 * than of a mock. Only the threads are invented, and they are invented because
 * this machine's pull requests may have none.
 */
function threadFixture(held: PullDetail | null): PullDetail {
  const base: PullDetail = held ?? {
    body: '',
    comments: [],
    reviews: [],
    commits: [],
    files: [],
    checks: null,
    mergeStateStatus: ''
  }
  const path = base.files[0]?.path ?? 'packages/core/src/github/gh.ts'
  const at = (hours: number): number => Date.now() - hours * 3_600_000
  const person = (
    id: string,
    author: string,
    association: string,
    body: string,
    hours: number
  ): PullDetail['comments'][number] => ({
    id,
    author,
    authorIsBot: false,
    association,
    body,
    createdAt: at(hours),
    url: ''
  })

  return {
    ...base,
    // A review with a verdict and no body: the shape a review made entirely of
    // inline notes has, and the one this change stopped being a dead end.
    reviews: [
      ...base.reviews,
      {
        id: 'design-shot-review',
        author: 'reviewer-two',
        authorIsBot: false,
        association: 'COLLABORATOR',
        state: 'CHANGES_REQUESTED',
        body: '',
        submittedAt: at(3)
      }
    ],
    reviewThreads: [
      {
        id: 'design-shot-thread-1',
        path,
        line: 118,
        originalLine: 118,
        diffHunk: [
          '@@ -110,6 +110,9 @@ export async function fetchReviewThreads(',
          '   const threads: PullReviewThread[] = []',
          '   let cursor: string | null = null',
          '+  for (let page = 0; page < MAX_THREAD_PAGES; page++) {'
        ].join('\n'),
        isResolved: false,
        isOutdated: false,
        comments: [
          person(
            'design-shot-c1',
            'reviewer-two',
            'COLLABORATOR',
            'This walks `reviewThreads`, but the comments **inside** a thread page too - a thread somebody argued in would stop at fifty.',
            3.5
          ),
          person(
            'design-shot-c2',
            'coledtaylor',
            'OWNER',
            'Good catch. Continuing by node id now, so reaching reply 51 does not re-fetch the fifty threads beside it.',
            3.2
          ),
          person('design-shot-c3', 'reviewer-one', 'MEMBER', 'Reads right to me.', 3)
        ]
      },
      {
        id: 'design-shot-thread-2',
        path,
        line: 47,
        originalLine: 47,
        diffHunk: '@@ -45,3 +45,4 @@\n   const said = firstMeaningfulLine(run.stderr)\n+  throw new Error(said)',
        isResolved: true,
        isOutdated: false,
        comments: [
          person(
            'design-shot-c4',
            'reviewer-one',
            'MEMBER',
            'Settled - this one was already handled upstream.',
            2.5
          )
        ]
      },
      {
        id: 'design-shot-thread-3',
        path: base.files[1]?.path ?? 'README.md',
        line: null,
        originalLine: 88,
        diffHunk: '@@ -86,2 +86,3 @@\n-  A paragraph that has since moved.\n+  A paragraph that has since moved, twice.',
        isResolved: false,
        isOutdated: true,
        comments: [
          person(
            'design-shot-c5',
            'reviewer-three',
            'MEMBER',
            'The diff moved under this one - leaving the note for the record.',
            2
          )
        ]
      }
    ],
    reviewThreadsFetchedAt: at(1.5)
  }
}

/**
 * A hover tint, **measured** rather than photographed.
 *
 * Hover is the design state this walk could never reach: it clicks and moves
 * on, and a screenshot taken a frame later has the pointer somewhere else. It
 * is also the state most able to vanish unnoticed, because seeing it at all
 * requires the pointer to be in one particular place - which is how "the tabs
 * have no hover any more" came to be reported from the running app rather than
 * caught here.
 *
 * A colour before and a colour after, from `getComputedStyle` on the element
 * that carries the class, with a real `mouseMove` between them. Printed and not
 * only saved, because "the tint is subtle" and "there is no tint" are the same
 * thumbnail and different bugs.
 */
async function reportHover(
  win: BrowserWindow,
  outDir: string,
  probe: { name: string; find: string },
  files: string[]
): Promise<void> {
  const read = `(() => {
    const el = ${probe.find}
    if (!el) return null
    const b = el.getBoundingClientRect()
    return {
      x: b.left + b.width / 2,
      y: b.top + b.height / 2,
      bg: getComputedStyle(el).backgroundColor,
      // A hover is not always a fill. The select's is a border that goes from
      // the 8% hairline to the 16% one, and reading only the background would
      // report that control as dead.
      bd: getComputedStyle(el).borderTopColor,
      // A second hover-driven property on the same element, so "this tint is
      // broken" can be told apart from "no hover variant resolves at all".
      kidColor: (() => {
        const kid = el.querySelector('[data-tab], span, svg')
        return kid ? getComputedStyle(kid).color : ''
      })(),
      // Whether the engine itself thinks the pointer is on this element. The
      // probe's own positive control: a synthesised mouseMove that never
      // reaches the hit-test would report "no tint" for every element on
      // screen, which is indistinguishable from every tint being broken. If
      // this is false, the finding is about this driver and not about the app.
      hot: el.matches(':hover')
    }
  })()`

  type Read = { x: number; y: number; bg: string; bd: string; hot: boolean; kidColor: string }
  const at = await js<Read | null>(win, read).catch(() => null)
  if (at === null) {
    console.error(`design-shot: hover ${probe.name} - nothing to hover`)
    return
  }
  // Away first, so "after" cannot be a tint left over from wherever the last
  // click put the pointer.
  await sendMouse(win, 'mouseMove', 2, 2)
  await sleep(200)
  await sendMouse(win, 'mouseMove', at.x, at.y)
  await sleep(300)
  const hovered = await js<Read | null>(win, read).catch(() => null)
  const after = hovered?.bg ?? '<gone>'
  const still =
    after === at.bg &&
    (hovered?.bd ?? '') === at.bd &&
    (hovered?.kidColor ?? '') === at.kidColor
  const verdict = !(hovered?.hot ?? false)
    ? '  *** POINTER NEVER LANDED - probe, not app ***'
    : still
      ? '  *** NO CHANGE ***'
      : ''
  console.log(
    `design-shot: hover ${probe.name} - bg ${at.bg} -> ${after}` +
      ` | border ${at.bd} -> ${hovered?.bd ?? '?'}` +
      ` | kid ${at.kidColor} -> ${hovered?.kidColor ?? '?'}${verdict}`
  )
  const shot = await screenshot(win, outDir, `hover-${probe.name}.png`)
  files.push(shot.file)
  await sendMouse(win, 'mouseMove', 2, 2)
  await sleep(150)
}

/**
 * What to hover, and the element that carries the tint.
 *
 * The tab's is on the **wrapper**, not the `[data-tab]` button inside it - the
 * button is only as tall as its text, and the fill belongs to the whole folder
 * tab. Reading the button would report `rgba(0, 0, 0, 0)` whether or not the
 * hover works.
 */
const HOVER_PROBES: Array<{ name: string; find: string }> = [
  {
    name: 'tab',
    find: `[...document.querySelectorAll('[role="tablist"] > div')]
      .find((d) => d.querySelector('[data-tab][aria-selected="false"]'))`
  },
  {
    name: 'project-row',
    find: `document.querySelector('aside nav button[title]:not([aria-current])')`
  },
  {
    name: 'project-link',
    find: `document.querySelector('[data-project-link]')`
  },
  // The two recipes whose hover is a *judgement about a colour* rather than a
  // yes/no. `affordance-check` says both changed; only the numbers here say
  // whether the change is one an eye can find - which is the whole reason the
  // chosen segment hovers to `active` and not to `hover`.
  {
    name: 'segment-on',
    find: `document.querySelector('[role="radio"][aria-checked="true"]')`
  },
  {
    name: 'select',
    find: `document.querySelector('[data-config-scope], select')`
  }
]

// ---------------------------------------------------------------------------
// The width sweep
// ---------------------------------------------------------------------------

/**
 * The panes whose header carries a scope switcher, and the control the driver
 * finds that header by.
 *
 * `closest('header')` rather than a data attribute of the driver's own, so this
 * measures the same element before and after a change to how the header is
 * built - which is the whole point of having the numbers.
 */
const NARROWED: Array<{ name: string; open: string; anchor: string }> = [
  { name: 'config', open: '[data-open-config]', anchor: '[data-config-scope]' },
  { name: 'content', open: '[data-open-content]', anchor: '[data-content-scope]' }
]

/**
 * Window widths to walk. 900 is the window's own `minWidth`, so the narrowest
 * a pane gets without a split; 1280 is the default. A pane is the window less
 * the 280px sidebar and 24px of gutters, so this sweep covers pane widths of
 * roughly 596 to 1136 - and the `split` group covers everything below that,
 * which is where the reported failure lives.
 */
const SWEEP_WIDTHS = [900, 1000, 1120, 1280]

interface HeaderShape {
  width: number
  /** Past zero, the row is wider than the box holding it. */
  overflow: number
  /** How far the furthest child reaches past the header's content box. */
  spill: number
  parts: Array<{ name: string; w: number }>
}

/**
 * What a header actually did, in pixels.
 *
 * Both numbers are needed and they are not the same failure. `overflow` is the
 * row being wider than its box. `spill` is a child painting outside the
 * padding box - which is what a `shrink-0` control does when the row has run
 * out: it does not clip, because nothing here sets `overflow: hidden`, it
 * paints over the island's own border and onto the canvas.
 */
async function measureHeader(win: BrowserWindow, anchor: string): Promise<HeaderShape | null> {
  return js<HeaderShape | null>(
    win,
    `(() => {
      const el = document.querySelector(${JSON.stringify(anchor)})?.closest('header')
      if (!el) return null
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const right = box.right - parseFloat(style.paddingRight)
      const parts = []
      let spill = 0
      for (const kid of el.children) {
        const k = kid.getBoundingClientRect()
        if (k.width === 0) continue
        spill = Math.max(spill, k.right - right)
        parts.push({
          name: kid.dataset.head ?? kid.tagName.toLowerCase(),
          w: Math.round(k.width)
        })
      }
      return {
        width: Math.round(el.clientWidth),
        overflow: Math.round(el.scrollWidth - el.clientWidth),
        spill: Math.round(spill),
        parts
      }
    })()`
  ).catch(() => null)
}

function reportHeader(label: string, shape: HeaderShape | null): void {
  if (shape === null) {
    console.error(`design-shot: ${label} - no header found`)
    return
  }
  const parts = shape.parts.map((p) => `${p.name} ${String(p.w)}`).join(' / ')
  console.log(
    `design-shot: ${label} - ${String(shape.width)}px, overflow ${String(shape.overflow)}, ` +
      `spill ${String(shape.spill)} - ${parts}`
  )
}

/**
 * Both scoped panes at a range of window widths, measured and photographed.
 *
 * The window is resized rather than the pane, because that is the half of the
 * range a person reaches without a session open - and because `minWidth` stops
 * it going far enough to break anything, which is itself worth having on the
 * record.
 */
async function sweepWidths(
  win: BrowserWindow,
  outDir: string,
  theme: string,
  files: string[]
): Promise<void> {
  const before = win.getBounds()
  if (win.isMaximized()) win.unmaximize()

  for (const width of SWEEP_WIDTHS) {
    win.setBounds({ ...win.getBounds(), width })
    await sleep(300)
    for (const pane of NARROWED) {
      if (!(await click(win, pane.open))) continue
      await sleep(500)
      reportHeader(`${pane.name} at window ${String(width)} (${theme})`, await measureHeader(win, pane.anchor))
      const shot = await screenshot(win, outDir, `${pane.name}-w${String(width)}-${theme}.png`)
      files.push(shot.file)
    }
  }

  win.setBounds(before)
  await sleep(300)
}

/**
 * Workspace widths to dock at, in pixels of pane rather than fractions of a
 * split: the fraction that produces a 300px pane depends on the monitor the
 * run happens on, and the number these shots are about is the pane's.
 *
 * They are the bands either side of every threshold in `PaneHeader` - below
 * the title, below the controls' own row, below the caption, and one width
 * somebody would actually work at. The drag is bounded at 20%, so on a small
 * screen the first of these is all that is reachable and the rest land where
 * the bound puts them; the console line reports what was achieved, not what
 * was asked for.
 */
const DOCKED_TARGETS = [300, 420, 520, 760]

/**
 * Drag the split divider until the workspace half is about `target` px wide.
 *
 * Through real mouse events on the real grip: the divider's handler lives on
 * `window` and reads `clientX`, so a synthetic click on the element would move
 * nothing.
 *
 * Through `drag()` rather than four `sendMouse` calls, and that is not tidying.
 * Written out by hand this sent its two middle moves with no button held -
 * `buttons: 0`, which is a hover - and the divider moved anyway, because its
 * handler did not check. Both halves have since been fixed, and either one
 * alone would have turned this function into a silent no-op: every docked
 * screenshot below would have been taken at the default split while claiming
 * the width in its filename.
 */
async function dragSplit(win: BrowserWindow, target: number): Promise<boolean> {
  const grip = await js<{ x: number; y: number; left: number; width: number } | null>(
    win,
    `(() => {
      const el = document.querySelector('[role="separator"][aria-orientation="vertical"]')
      if (!el) return null
      const b = el.getBoundingClientRect()
      const row = el.parentElement.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, left: row.left, width: row.width }
    })()`
  ).catch(() => null)
  if (grip === null) return false

  const to = grip.left + Math.min(Math.max(target, grip.width * 0.2), grip.width * 0.8)
  await drag(win, { x: grip.x, y: grip.y }, { x: to, y: grip.y })
  await sleep(400)
  return true
}

/** How many session tabs the strip is photographed holding. */
const CROWDED_TABS = 6

/** The window's own `minWidth` - the narrowest a person can make it. */
const NARROWEST_WINDOW = 900

/**
 * Rename a tab the way a person does: double-click the title, type, Enter.
 *
 * The value is set through `HTMLInputElement`'s own `value` setter rather than
 * by assigning `el.value`. React installs a setter of its own on the element to
 * track what it last rendered, and assigning through it leaves React's copy
 * equal to the new text - so the `input` event that follows looks like a change
 * from "PR review" to "PR review" and the handler never runs. The prototype's
 * setter is the one that writes the DOM without telling React it already knew.
 */
async function openRename(win: BrowserWindow, tabId: string): Promise<boolean> {
  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-tab=${JSON.stringify(tabId)}]');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true })()`
  ).catch(() => false)
}

async function renameTab(win: BrowserWindow, tabId: string, label: string): Promise<boolean> {
  if (!(await openRename(win, tabId))) return false
  await sleep(300)

  return js<boolean>(
    win,
    `(() => { const el = document.querySelector('[data-tab-rename=${JSON.stringify(tabId)}]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(label)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true })()`
  ).catch(() => false)
}

/**
 * What the crowded strip actually measured, printed beside the shot.
 *
 * For the reason the `responsive` group prints its header numbers: a tab whose
 * subtitle has been ellipsised does not look wrong in a thumbnail, it looks
 * slightly shorter - and "the distinguishing part of a label survives
 * truncation" is a claim about `scrollWidth` against `clientWidth`, not
 * something an eye can settle at 10px. Each line is one tab: how wide it is,
 * and whether its title and its subtitle are being cut.
 */
async function reportStrip(win: BrowserWindow, theme: string): Promise<void> {
  const strip = await js<{
    scrollWidth: number
    clientWidth: number
    tabs: Array<{ title: string; subtitle: string; width: number; titleCut: boolean; subCut: boolean }>
  } | null>(
    win,
    `(() => {
       const list = document.querySelector('[role="tablist"]');
       if (!list) return null;
       const tabs = [...document.querySelectorAll('[role="tab"][data-tab^="session:"]')].map((t) => {
         const sub = t.querySelector('[data-tab-subtitle]');
         const title = sub ? sub.previousElementSibling : t.querySelector('span span');
         const cut = (el) => el ? el.scrollWidth > el.clientWidth + 1 : false;
         return {
           title: title ? title.textContent : '',
           subtitle: sub ? sub.textContent : '',
           width: Math.round(t.getBoundingClientRect().width),
           titleCut: cut(title),
           subCut: cut(sub)
         }
       });
       return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, tabs }
     })()`
  ).catch(() => null)

  if (strip === null) {
    console.error('design-shot: no tab strip to measure')
    return
  }
  console.log(
    `design-shot: session strip (${theme}) ${String(strip.tabs.length)} tabs, ` +
      `${String(strip.scrollWidth)}px of content in ${String(strip.clientWidth)}px`
  )
  for (const tab of strip.tabs) {
    console.log(
      `      ${String(tab.width).padStart(4)}px  ${tab.titleCut ? 'CUT ' : '    '}${tab.title}` +
        `  /  ${tab.subCut ? 'CUT ' : '    '}${tab.subtitle}`
    )
  }
}

/** Every session tab ended and forgotten, without six confirmations. */
async function closeAllSessions(win: BrowserWindow): Promise<void> {
  await js<void>(
    win,
    `(async () => {
       for (const s of await window.helm.invoke('session:list')) {
         await window.helm.invoke('session:close', { id: s.id, force: true })
       }
     })()`
  ).catch(() => undefined)
  await sleep(1500)
}

/**
 * The tab strip carrying as many sessions as anyone actually opens on one
 * project, at the narrowest window the app allows.
 *
 * The state this walk had no shot of, and the one the whole session-tab-label
 * work is about: several sessions against a single project is the normal case -
 * that is what tabs are for - and until now they were `dev`, `dev 2`, `dev 3`
 * with an empty second line, three tabs saying nothing about which was which. So
 * the shot has to *be* the crowded case, at `minWidth`, in both themes, or it is
 * photographing the easy state and calling it the answer.
 *
 * Two of the six are renamed through the real gesture rather than through the
 * channel, so the picture includes what a named tab looks like beside unnamed
 * ones and the double-click is exercised on the way past. One shot is taken with
 * the editor open, because a text field on the terminal's fixed ground is the
 * one control here that could plausibly arrive wearing the app's light-mode
 * input styling, and no assertion would notice.
 *
 * Write/shoot/restore, like the pinned sidebar and the ignore list: the window's
 * bounds and the theme go back, and the six sessions are ended - a design run
 * must not leave the machine six `claude` processes.
 */
async function shootCrowdedTabs(
  win: BrowserWindow,
  outDir: string,
  themeBefore: 'system' | 'light' | 'dark'
): Promise<string[]> {
  const files: string[] = []

  // A git repository by preference: the subtitle under each title is the branch
  // its session started on, and a folder that is not a repo photographs the
  // fallback rather than the feature.
  const repo = await js<string | null>(
    win,
    `window.helm.invoke('pr:snapshot').then((s) => s.repos[0] ? s.repos[0].path : null)`
  ).catch(() => null)
  const opened = repo !== null ? await clickProjectRow(win, repo) : false
  if (!opened && !(await click(win, 'aside nav button[title]'))) {
    console.error('design-shot: no project row to launch sessions from')
    return files
  }
  await sleep(500)

  for (let n = 0; n < CROWDED_TABS; n++) {
    const started = await js<boolean>(
      win,
      `(() => { const el = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent ?? '').includes('Start session here'));
        if (!el) return false; el.click(); return true })()`
    )
    if (!started) break
    await pollJs(
      win,
      `document.querySelectorAll('[data-tab^="session:"]').length >= ${String(n + 1)}`,
      20_000
    )
  }

  const tabs = await js<string[]>(
    win,
    `[...document.querySelectorAll('[data-tab^="session:"]')].map((t) => t.dataset.tab)`
  )
  console.log(`design-shot: ${String(tabs.length)} session tabs open on one project`)
  if (tabs.length === 0) return files

  // Two named, four left as they launched - the mixture the strip actually ends
  // up in, rather than a row of six renamed tabs that proves nothing about the
  // default state.
  if (tabs[1]) await renameTab(win, tabs[1], 'PR review')
  if (tabs[3]) await renameTab(win, tabs[3], 'flaky test hunt')
  await sleep(400)

  // Long enough for the TUIs behind the strip to have painted; a pane still
  // blank makes the shot look like a bug that is not there.
  await sleep(8000)

  const bounds = win.getBounds()
  if (win.isMaximized()) win.unmaximize()
  win.setBounds({ ...win.getBounds(), width: NARROWEST_WINDOW })
  await sleep(600)

  for (const theme of ['dark', 'light'] as const) {
    await click(win, `button[aria-label="${THEME_LABEL[theme]}"]`)
    await sleep(500)

    // Launching from a project row leaves the split up, which gives the strip
    // about 250px and answers a different question. Both are worth having: the
    // split is what someone is actually looking at while they work, and the
    // maximised one is the only place six tabs can be judged against each other.
    files.push((await screenshot(win, outDir, `session-tabs-split-w900-${theme}.png`)).file)

    const maximized = await click(win, 'button[aria-label="Maximize the session pane"]')
    if (maximized) await sleep(600)
    files.push((await screenshot(win, outDir, `session-tabs-crowded-w900-${theme}.png`)).file)
    await reportStrip(win, theme)
    if (maximized) await click(win, 'button[aria-label="Restore the split"]')
    await sleep(400)

    // And the same strip with a rename open on the active tab.
    const active = await js<string | null>(
      win,
      `(() => { const el = document.querySelector('[role="tab"][data-tab^="session:"][aria-selected="true"]');
        return el ? el.dataset.tab : null })()`
    )
    if (active !== null) {
      await openRename(win, active)
      await sleep(500)
      files.push(
        (await screenshot(win, outDir, `session-tab-rename-${theme}.png`)).file
      )
      // Escape, so the next theme starts from the strip rather than the editor.
      await js<void>(
        win,
        `(() => { const el = document.querySelector('[data-tab-rename]');
          if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })()`
      ).catch(() => undefined)
      await sleep(300)
    }
  }

  await click(win, `button[aria-label="${THEME_LABEL[themeBefore]}"]`)
  win.setBounds(bounds)
  await sleep(400)
  await closeAllSessions(win)
  return files
}

export async function runDesignShot(ctx: CheckContext, outDir: string): Promise<string[]> {
  const { win } = ctx
  // Keep drawing while nobody is looking at the window.
  //
  // Chromium throttles rendering, timers and `requestAnimationFrame` in a
  // window it believes is occluded, and a driver's window is occluded by
  // definition: it runs behind whatever the developer is actually working in.
  // `capturePage` then hands back the last frame that *was* drawn, which is how
  // this walk photographed the previous view under a later view's name. Set on
  // the driver rather than in the app, where the throttle is right and saves a
  // laptop's battery.
  win.webContents.setBackgroundThrottling(false)
  const files: string[] = []
  const want = wantedGroups()
  if (want.size === 0) {
    console.error(`design-shot: nothing to do - groups are ${GROUPS.join(', ')}`)
    return files
  }

  const painted = await pollJs(win, `document.querySelector('aside')`, 20_000)
  if (!painted) {
    console.error('design-shot: the sidebar never painted')
    return files
  }
  // Let the first scan land so the tree has rows to click.
  await pollJs(win, `document.querySelector('aside nav button[title]')`, 20_000)

  // Driving the real toggle persists the preference, so remember what it was
  // and put it back - a screenshot run must not repaint the user's app. The
  // ignore list is remembered for the same reason and restored beside it.
  const before = ctx.services.settings.theme
  const ignoredBefore = [...ctx.services.settings.prIgnoredRepos]
  const pinnedBefore = [...ctx.services.settings.pinnedProjects]
  const shellHeightBefore = ctx.services.settings.projectShellHeightPct
  // The stale cutoff is driven too, for the dense pulls shot, and put back the
  // same way: the split is only photographable when it is switched on, and a
  // screenshot run must not repaint the developer's own app.
  const staleBefore = ctx.services.settings.prStaleDays

  for (const theme of ['dark', 'light'] as const) {
    // Through the real toggle, so the shot proves the control too.
    await click(win, `button[aria-label="${THEME_LABEL[theme]}"]`)
    await sleep(400)
    // Said out loud: `welcome` is the empty workspace, so a tab left open here
    // is not a cosmetic difference between the two passes - it is a different
    // view under that name.
    const stuck = await closeAllTabs(win)
    if (stuck > 0) console.error(`design-shot: ${String(stuck)} tab(s) would not close (${theme})`)
    await sleep(400)

    if (want.has('responsive')) await sweepWidths(win, outDir, theme, files)
    if (!want.has('views')) continue

    for (const view of VIEWS) {
      if (view.selector !== null) {
        const clicked = await click(win, view.selector)
        if (!clicked) {
          console.error(`design-shot: nothing matched ${view.selector}`)
          continue
        }
        await sleep(600)
      }
      // Arrived, and painted, before the shutter. Neither half is optional:
      // the anchor says the pane the file is named for is the pane on screen,
      // and `drawn` says the compositor has caught up with it. Without the
      // second one this walk wrote `pulls-light.png` holding the Session
      // history pane - the view clicked immediately before it - because
      // `capturePage` returns the last frame drawn rather than the current
      // tree. A file named for a view it does not hold is worse than a missing
      // one: it is reviewed as though it were the thing it is named after.
      if (view.anchor !== null) {
        const landed = await pollJs(win, `document.querySelector('${view.anchor}')`, 10_000)
        if (!landed) {
          console.error(
            `design-shot: ${view.name} (${theme}) never showed ${view.anchor} - no shot written`
          )
          continue
        }
      }
      await drawn(win)
      const shot = await screenshot(win, outDir, `${view.name}-${theme}.png`)
      files.push(shot.file)

      // The sidebar again, with things pinned. `welcome` is where the rail has
      // nothing else on screen competing with it, and the plain shot above is
      // the same rail with whatever the machine has pinned - which is the zero
      // state on a machine that has pinned nothing.
      if (view.name === 'welcome') {
        const pinned = await shootPinned(win, outDir, theme, pinnedBefore)
        if (pinned !== null) files.push(pinned)
      }

      // The project pane again, for a project that is a github.com repository -
      // the state that carries a branch and the pull-request panel.
      if (view.name === 'project') {
        const repoShot = await shootProjectRepo(win, outDir, theme)
        if (repoShot !== null) files.push(repoShot)
        // And the same page with its shell dragged to each end of what the
        // handle allows. Taken after the repository shot deliberately: the
        // question is what a *full* project pane does when it is given half
        // the room, and the harness row the walk opens first has no branch,
        // no git stats and no pull-request panel to squeeze.
        files.push(...(await shootShellHeights(win, outDir, theme, shellHeightBefore)))
      }

      // The content pane again, in its other mode. The walk opens a harness,
      // which defaults to curated, so the file tree is a state rather than a
      // view and no click in the itinerary reaches it.
      if (view.name === 'content') {
        const treeShot = await shootContentTree(win, outDir, theme)
        if (treeShot !== null) files.push(treeShot)
      }

      // The history pane again, two clicks in: the archived transcript, and a
      // session whose conversation was gone before Helm existed. Neither is
      // reachable from the list shot above, which is the list.
      if (view.name === 'history') {
        files.push(...(await shootTranscript(win, outDir, theme, ctx.services.store)))
        // Back to the list, so the next view starts from a clean pane.
        await click(win, '[data-open-history]')
        await sleep(300)
      }

      // The Pulls pane again with a repository ignored. A design state nothing
      // else photographs: a section that only exists when the setting is not
      // empty, and the app's only dashed border - which is exactly the kind of
      // hairline that can read as a tone in one theme and as a gap in the other.
      if (view.name === 'pulls') {
        // The busy pane first, because it is the one this walk could not reach
        // at all before: a machine with one open pull request never draws the
        // ACTIVE/STALE split, the stale chips or a group with anything in it.
        files.push(...(await shootPullsDense(win, outDir, theme, ctx, staleBefore)))

        const ignored = await shootIgnored(win, outDir, theme, ignoredBefore)
        if (ignored !== null) files.push(ignored)

        // And a pull request's own tab, two clicks past everything else in the
        // walk - the one place a review thread is drawn, and the one design
        // question here a list of pull requests cannot answer.
        const threads = await shootPullThreads(win, outDir, theme, ctx.services.store)
        if (threads !== null) files.push(threads)
      }
    }

    // The Updates group, which is below the fold too and is the one group whose
    // content is a *sentence* rather than a row of controls. What a thumbnail
    // has to answer for it is whether that sentence sits in the same rhythm as
    // the label-and-control rows around it and whether it wraps somewhere
    // sensible - neither of which the top-of-pane shot reaches.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-settings-group="updates"]');
        if (el) el.scrollIntoView({ block: 'center' }) })()`
    )
    await sleep(400)
    const updatesShot = await screenshot(win, outDir, `settings-updates-${theme}.png`)
    files.push(updatesShot.file)

    // The Transcript archive group, which is the one group in the pane made
    // entirely of *figures* - four numbers and a select - and the one that has
    // to read as reassurance rather than as a warning. Below the fold like the
    // two around it.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-settings-group="archive"]');
        if (el) el.scrollIntoView({ block: 'center' }) })()`
    )
    await sleep(400)
    files.push((await screenshot(win, outDir, `settings-archive-${theme}.png`)).file)

    // The Terminal group, which is below the fold on a default-sized window and
    // is the group made of controls the rest of the app does not use (a
    // stepper, a preview well on the terminal's own fixed ground inside a
    // themed card), so it is the most likely place for something to stop
    // matching the system in one theme only.
    //
    // Scrolled *to the group*, like the two above. It used to scroll to the
    // end of the pane, which was the Terminal group until the GitHub group was
    // added under it - after which the file called `settings-terminal` was a
    // photograph of the review-prompt rows and nothing was looking at the
    // group it is named for.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-settings-group="terminal"]');
        if (el) el.scrollIntoView({ block: 'center' }) })()`
    )
    await sleep(400)
    const terminalShot = await screenshot(win, outDir, `settings-terminal-${theme}.png`)
    files.push(terminalShot.file)

    // And the end of the pane, which is where a group added later lands and
    // where the page has to stop cleanly.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-settings-pane]');
        if (el) el.scrollTop = el.scrollHeight })()`
    )
    await sleep(400)
    files.push((await screenshot(win, outDir, `settings-end-${theme}.png`)).file)
  }

  await click(win, `button[aria-label="${THEME_LABEL[before]}"]`)
  await sleep(200)
  await writeIgnored(win, ignoredBefore)

  // A collapsed section is a design state as much as an open one, and the
  // headers are `sticky` inside a scroll container - a place where "it renders"
  // and "it still behaves" are not the same claim.
  if (want.has('states')) {
    // Hover first, from a project pane: the one view carrying all three probes
    // at once - the tree, the pane links, and a tab strip. Two tabs are opened
    // deliberately and the project left in front, because the tab probe needs
    // an **inactive** tab to hover and `--only=states` reaches here with the
    // strip in whatever state the last run left it.
    await click(win, '[data-open-pulls]')
    await sleep(400)
    await click(win, 'aside nav button[title]')
    await sleep(600)
    // The capability the override in theme.css exists for. Printed because a
    // machine answering false here is one where every hover state in the app
    // would be dead if that override were ever removed.
    console.log(
      'design-shot: pointer - ' +
        (await js<string>(
          win,
          `['hover: hover', 'any-hover: hover', 'pointer: fine', 'any-pointer: fine']
             .map((q) => q + '=' + matchMedia('(' + q + ')').matches).join('  ')`
        ).catch(() => '<unreadable>'))
    )
    for (const probe of HOVER_PROBES) await reportHover(win, outDir, probe, files)

    await click(win, '[data-open-config]')
    await sleep(500)
    const before1 = await js<number>(win, `document.querySelectorAll('button[data-config-file]').length`)
    await click(win, '[data-config-section]')
    await sleep(400)
    const collapsedShot = await screenshot(win, outDir, 'config-collapsed.png')
    files.push(collapsedShot.file)
    const after = await js<number>(win, `document.querySelectorAll('button[data-config-file]').length`)
    await click(win, '[data-config-section]')
    await sleep(400)
    const reopened = await js<number>(win, `document.querySelectorAll('button[data-config-file]').length`)
    console.log(
      `design-shot: config section rows ${String(before1)} -> ${String(after)} -> ${String(reopened)}`
    )
  }

  // The crowded strip, before `split` opens a session of its own: this group
  // ends by closing every session it started, so the two do not photograph each
  // other's tabs.
  if (want.has('tabs')) {
    await closeAllTabs(win)
    await sleep(400)
    files.push(...(await shootCrowdedTabs(win, outDir, before)))
  }

  if (!want.has('split')) return files

  // The split view, with a real session on the right and the workspace still
  // browsable on the left. The session is reaped by the app's own teardown
  // when the run quits - the same path SESS-9 proves.
  await click(win, 'aside nav button[title]')
  await sleep(400)
  const launched = await click(win, '[data-tab]') // focus strip first for a stable shot
  if (launched) {
    const started = await js<boolean>(
      win,
      `(() => { const el = [...document.querySelectorAll('button')]
          .find((b) => (b.textContent ?? '').includes('Start session here'));
        if (!el) return false; el.click(); return true })()`
    )
    if (started) {
      await pollJs(win, `document.querySelector('[data-tab^="session:"]')`, 20_000)
      await sleep(8000)
      const shot = await screenshot(win, outDir, 'session-split.png')
      files.push(shot.file)

      // A pane docked beside a session, at each width its header changes shape
      // at. This is the state the header bug was reported from, and the only
      // one that reaches pane widths the window's own `minWidth` puts out of
      // reach: the drag bound is a fraction of the row, so it goes far below
      // the 596px a 900px window leaves.
      //
      // Dark for the sweep and light for the narrowest of them: the widths are
      // a layout question, which a second theme answers identically, but the
      // two-row header is a shape no other shot in this walk carries and a
      // shape is worth seeing on both grounds.
      await click(win, `button[aria-label="${THEME_LABEL.dark}"]`)
      await sleep(400)
      for (const target of DOCKED_TARGETS) {
        if (!(await dragSplit(win, target))) {
          console.error('design-shot: the split divider was not there to drag')
          break
        }
        for (const pane of NARROWED) {
          if (!(await click(win, pane.open))) continue
          await sleep(500)
          reportHeader(`${pane.name} docked at ~${String(target)}`, await measureHeader(win, pane.anchor))
          const shot = await screenshot(win, outDir, `${pane.name}-docked-${String(target)}-dark.png`)
          files.push(shot.file)
        }

        // The project pane at the same widths. It has no scope header to
        // measure, so it is not in `NARROWED` - but its action row is the one
        // row in the app with a group pinned to the far end of a **wrapping**
        // flex (the Config and Content links), and where that group lands once
        // the row has wrapped is only visible down here.
        if (await click(win, 'aside nav button[title]')) {
          await sleep(500)
          const shot = await screenshot(win, outDir, `project-docked-${String(target)}-dark.png`)
          files.push(shot.file)
        }
      }

      const narrowest = DOCKED_TARGETS[0] ?? 300
      await click(win, `button[aria-label="${THEME_LABEL.light}"]`)
      await sleep(400)
      if (await dragSplit(win, narrowest)) {
        for (const pane of NARROWED) {
          if (!(await click(win, pane.open))) continue
          await sleep(500)
          const shot = await screenshot(win, outDir, `${pane.name}-docked-${String(narrowest)}-light.png`)
          files.push(shot.file)
        }
      }
      await click(win, `button[aria-label="${THEME_LABEL[before]}"]`)
      await sleep(300)

      // The "still running" confirmation, reached the way a user reaches it -
      // by closing a tab whose session is alive. Worth walking here because it
      // is the one dialog `sessions-check` cannot see: that driver injects its own
      // `Confirm`, so the real renderer round trip runs in the app and nowhere
      // else. Nothing is asserted; the console lines and the shot are the
      // evidence, same as every other view in this walk.
      const closeSessionTab = `(() => {
        const tab = document.querySelector('[data-tab^="session:"]');
        const close = tab?.parentElement?.querySelector('button[aria-label^="Close "]');
        if (!close) return false; close.click(); return true })()`

      if (await js<boolean>(win, closeSessionTab)) {
        if (await pollJs(win, `document.querySelector('[data-confirm-session]')`, 10_000)) {
          // The poll returns when the node is in the DOM, which is a frame or
          // two before the compositor has painted it - without this the shot is
          // of the app as it was just before the dialog appeared.
          await sleep(600)
          const confirmShot = await screenshot(win, outDir, 'confirm-session.png')
          files.push(confirmShot.file)

          // Cancel must leave the session alone, and accepting must end it.
          await click(win, '[data-confirm-cancel]')
          await sleep(600)
          const survived = await js<boolean>(
            win,
            `Boolean(document.querySelector('[data-tab^="session:"]'))
             && !document.querySelector('[data-confirm-session]')`
          )
          console.log(`design-shot: confirm cancelled, session survived: ${String(survived)}`)

          await js(win, closeSessionTab)
          await pollJs(win, `document.querySelector('[data-confirm-session]')`, 10_000)
          await click(win, '[data-confirm-accept]')
          const ended = await pollJs(
            win,
            `!document.querySelector('[data-tab^="session:"]')`,
            10_000
          )
          console.log(`design-shot: confirm accepted, session ended: ${String(ended)}`)
        } else {
          console.error('design-shot: the confirmation never appeared')
        }
      }
    }
  }

  return files
}
