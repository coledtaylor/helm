import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../test/world'
import { expect, startSession, terminalText, test, type Helm } from '../../e2e/helm'

/**
 * A screenshot of every destination on the rail and of a session's terminal,
 * once in the light theme and once in the dark, for a person to review a
 * platform nobody has in front of them. Run by `pnpm screenshots`; the macOS
 * screenshot workflow runs it on macos-latest and uploads what it writes.
 *
 * Each view is saved twice where the OS allows it:
 *
 * - `<n>-<view>.png`, the window's page through Playwright, on every OS. It is
 *   the web contents only: no title bar, no traffic lights, and no browser
 *   page, which is a native view painted over the window.
 * - `<n>-<view>.window.png`, on macOS, the window as the screen shows it,
 *   through `screencapture`. That one has the traffic lights and the browser
 *   page in it. A capture the OS refuses is reported and skipped; the page
 *   shot is still there.
 *
 * The world is the E2E tests' (`test/world.ts`): a home of its own with a fake
 * `claude`, two git projects and a data directory, so nothing here touches a
 * real `~/.claude`, a real CLI or an installed Helm.
 */

const OUT = process.env['HELM_SHOTS_DIR'] ?? join(repoRoot(), 'reports', 'screenshots')
const THEMES = ['light', 'dark'] as const
/**
 * One size wherever the screen holds it, so two runs can be compared side by
 * side. A smaller screen gets the window fitted inside it: the macOS runner's
 * is about 1024x768, and a window that runs off it is cut off in the
 * `screencapture` shot.
 */
const BOUNDS = { width: 1440, height: 900 }

type HelmWindow = Window & { helm: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }

/** Fits the main window to `BOUNDS` inside the screen, in front, and returns where it is on screen. */
async function frontWindow(helm: Helm): Promise<{ x: number; y: number; width: number; height: number }> {
  return helm.app.evaluate(({ BrowserWindow, screen }, size) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())
    if (win === undefined) throw new Error('Helm has no visible window')
    const area = screen.getPrimaryDisplay().workArea
    win.setBounds({
      x: area.x,
      y: area.y,
      width: Math.min(size.width, area.width),
      height: Math.min(size.height, area.height)
    })
    win.moveTop()
    win.focus()
    return win.getBounds()
  }, BOUNDS)
}

/** Lets fonts load, layout land and a transition finish before a shot. */
async function settle(ui: Page): Promise<void> {
  await ui.evaluate(async () => {
    await document.fonts.ready
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  })
  await ui.waitForTimeout(400)
}

async function shoot(helm: Helm, dir: string, name: string): Promise<void> {
  await settle(helm.window)
  await helm.window.screenshot({ path: join(dir, `${name}.png`) })
  if (process.platform !== 'darwin') return
  const { x, y, width, height } = await frontWindow(helm)
  try {
    execFileSync('screencapture', ['-x', `-R${String(x)},${String(y)},${String(width)},${String(height)}`, join(dir, `${name}.window.png`)], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    console.warn(`screencapture refused ${name}: ${String((err as { stderr?: unknown }).stderr ?? err)}`)
  }
}

test('every rail destination and a session terminal, in the light and the dark theme', async ({ helm }) => {
  const ui = helm.window
  rmSync(OUT, { recursive: true, force: true })
  await frontWindow(helm)

  // A running session first, so the Sessions view and the terminal have
  // something in them. The fake claude prints its banner and waits for input.
  const session = await startSession(ui, 'alpha')
  await expect.poll(() => terminalText(ui, session)).toContain('Claude Code')

  const rail = ui.getByRole('navigation', { name: 'Destinations' })
  const destinations = await rail
    .locator('[data-rail]')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-rail') ?? ''))
  expect(destinations.length).toBeGreaterThan(0)

  for (const theme of THEMES) {
    const dir = join(OUT, theme)
    mkdirSync(dir, { recursive: true })
    await ui.evaluate((value) => (window as unknown as HelmWindow).helm.invoke('settings:write', { theme: value }), theme)
    await expect.poll(() => ui.evaluate(() => document.documentElement.style.colorScheme)).toBe(theme)

    for (const [index, id] of destinations.entries()) {
      const button = rail.locator(`[data-rail="${id}"]`)
      // Pressing a view that is already showing puts the sidebar away.
      if ((await button.getAttribute('aria-current')) !== 'true') await button.click()
      await expect(button).toHaveAttribute('aria-current', 'true')
      await shoot(helm, dir, `${String(index + 1).padStart(2, '0')}-${id}`)
    }

    const sessions = rail.locator('[data-rail="sessions"]')
    if ((await sessions.getAttribute('aria-current')) !== 'true') await sessions.click()
    await ui.getByRole('tab', { name: /^alpha/ }).first().click()
    await expect.poll(() => terminalText(ui, session)).toContain('Claude Code')
    await shoot(helm, dir, `${String(destinations.length + 1).padStart(2, '0')}-terminal`)
  }

  console.log(`screenshots in ${OUT}`)
})
