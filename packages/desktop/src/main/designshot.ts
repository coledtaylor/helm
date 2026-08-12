import type { BrowserWindow } from 'electron'
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

      // The project pane again, for a project that is a github.com repository -
      // the state that carries a branch and the pull-request panel.
      if (view.name === 'project') {
        const repoShot = await shootProjectRepo(win, outDir, theme)
        if (repoShot !== null) files.push(repoShot)
      }

      // The Pulls pane again with a repository ignored. A design state nothing
      // else photographs: a section that only exists when the setting is not
      // empty, and the app's only dashed border - which is exactly the kind of
      // hairline that can read as a tone in one theme and as a gap in the other.
      if (view.name === 'pulls') {
        const ignored = await shootIgnored(win, outDir, theme, ignoredBefore)
        if (ignored !== null) files.push(ignored)
      }
    }

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
