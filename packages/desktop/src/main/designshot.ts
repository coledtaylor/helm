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

/** The views worth looking at, and how to reach each from the sidebar. */
const VIEWS: Array<{ name: string; selector: string | null }> = [
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
    }
  }

  return files
}
