import type { BrowserWindow } from 'electron'
import type { M2Context } from './m2check'
import { screenshot, sleep } from './bridge'

/**
 * `--design-shot`: open the real window, walk the main views, and capture a
 * screenshot of each in both themes.
 *
 * Not a check - nothing is asserted. It exists so that "does the app still
 * follow docs/DESIGN.md" is answered by looking at the app rather than at the
 * class names, and so a design review has current evidence without anyone
 * clicking through five panes twice.
 */

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
  { name: 'history', selector: '[data-open-history]' }
]

const THEME_LABEL = {
  system: 'Match the system theme',
  light: 'Light theme',
  dark: 'Dark theme'
} as const

export async function runDesignShot(ctx: M2Context, outDir: string): Promise<string[]> {
  const { win } = ctx
  const files: string[] = []

  const painted = await pollJs(win, `document.querySelector('aside')`, 20_000)
  if (!painted) {
    console.error('design-shot: the sidebar never painted')
    return files
  }
  // Let the first scan land so the tree has rows to click.
  await pollJs(win, `document.querySelector('aside nav button[title]')`, 20_000)

  // Driving the real toggle persists the preference, so remember what it was
  // and put it back - a screenshot run must not repaint the user's app.
  const before = ctx.services.settings.theme

  for (const theme of ['dark', 'light'] as const) {
    // Through the real toggle, so the shot proves the control too.
    await click(win, `button[aria-label="${THEME_LABEL[theme]}"]`)
    await sleep(400)
    await closeAllTabs(win)
    await sleep(400)

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
    }
  }

  await click(win, `button[aria-label="${THEME_LABEL[before]}"]`)
  await sleep(200)

  // A collapsed section is a design state as much as an open one, and the
  // headers are `sticky` inside a scroll container - a place where "it renders"
  // and "it still behaves" are not the same claim.
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

  // The split view, with a real session on the right and the workspace still
  // browsable on the left. The session is reaped by the app's own teardown
  // when the run quits - the same path M2-9 proves.
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

      // The "still running" confirmation, reached the way a user reaches it -
      // by closing a tab whose session is alive. Worth walking here because it
      // is the one dialog `m2-check` cannot see: that driver injects its own
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
