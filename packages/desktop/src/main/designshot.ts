import type { BrowserWindow } from 'electron'
import { readPull, writePullDetail, type PullDetail, type Store } from '@helm/core'
import type { CheckContext } from './sessionscheck'
import { screenshot, sendMouse, sleep } from './bridge'

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
const GROUPS = ['views', 'states', 'responsive', 'split'] as const
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

/** Every open tab closed, so an empty workspace is a state the walk can get
 * back to - the second theme pass starts where the first one left off. Scoped
 * to the tab strip: other things on screen have close buttons too. */
async function closeAllTabs(win: BrowserWindow): Promise<void> {
  await js<void>(
    win,
    `(() => { for (const el of document.querySelectorAll('[role="tablist"] button[aria-label^="Close "]'))
        el.click() })()`
  )
}

/** The views worth looking at, and how to reach each from the sidebar. */
const VIEWS: Array<{ name: string; selector: string | null }> = [
  // Nothing open. Reached by the close-everything above rather than a click,
  // hence the null selector.
  { name: 'welcome', selector: null },
  // First project row in the tree - the launcher's home view.
  { name: 'project', selector: 'aside nav button[title]' },
  { name: 'config', selector: '[data-open-config]' },
  { name: 'content', selector: '[data-open-content]' },
  { name: 'history', selector: '[data-open-history]' },
  // Painted from the cache, so it has rows whether or not a fetch has happened
  // on this run - and it is the one list in the app whose rows are almost all
  // chips and mono, which is where a tone that only works in one theme shows.
  { name: 'pulls', selector: '[data-open-pulls]' },
  // The gear, not a sidebar row: settings is a window-level place. It is the
  // longest page in the app and the one most likely to grow a control that
  // does not match the others, which is exactly what a shot is for.
  { name: 'settings', selector: '[data-open-settings]' }
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
  await sendMouse(win, 'mouseDown', grip.x, grip.y)
  // Two moves: Chromium coalesces a single jump from the press point, and the
  // first one is what gets the drag past its own start.
  await sendMouse(win, 'mouseMove', (grip.x + to) / 2, grip.y)
  await sendMouse(win, 'mouseMove', to, grip.y)
  await sendMouse(win, 'mouseUp', to, grip.y)
  await sleep(400)
  return true
}

export async function runDesignShot(ctx: CheckContext, outDir: string): Promise<string[]> {
  const { win } = ctx
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

  for (const theme of ['dark', 'light'] as const) {
    // Through the real toggle, so the shot proves the control too.
    await click(win, `button[aria-label="${THEME_LABEL[theme]}"]`)
    await sleep(400)
    await closeAllTabs(win)
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

    // The settings pane scrolled to the end, because the Terminal group sits
    // below the fold on a default-sized window - and it is the group made of
    // controls the rest of the app does not use (a stepper, a preview well on
    // the terminal's own fixed ground inside a themed card), so it is the most
    // likely place for something to stop matching the system in one theme only.
    await js<void>(
      win,
      `(() => { const el = document.querySelector('[data-settings-pane]');
        if (el) el.scrollTop = el.scrollHeight })()`
    )
    await sleep(400)
    const terminalShot = await screenshot(win, outDir, `settings-terminal-${theme}.png`)
    files.push(terminalShot.file)
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
