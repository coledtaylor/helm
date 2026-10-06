import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { join } from 'node:path'
import { createWorld, disposeWorld, fakeClaudeLogs, repoRoot, seedSettings, type FakeClaudeLog, type World } from '../test/world'

export { expect }

export interface Helm {
  app: ElectronApplication
  window: Page
}

/** Starts the built app into a world. `pnpm test:e2e` builds it first. */
export async function launchHelm(world: World): Promise<Helm> {
  const desktop = join(repoRoot(), 'packages', 'desktop')
  const app = await electron.launch({
    args: [desktop],
    cwd: desktop,
    env: world.env
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

/**
 * A test with a fresh world, seeded and torn down around it. `helm` is the app,
 * launched once; a test that restarts it calls `relaunch`.
 */
export const test = base.extend<{
  world: World
  helm: Helm
  relaunch: () => Promise<Helm>
}>({
  // eslint-disable-next-line no-empty-pattern
  world: async ({}, use) => {
    const world = createWorld()
    seedSettings(world)
    await use(world)
    disposeWorld(world)
  },
  helm: async ({ world }, use) => {
    const current = await launchHelm(world)
    await use(current)
    await current.app.close()
  },
  relaunch: async ({ world, helm }, use) => {
    let latest = helm
    await use(async () => {
      await latest.app.close()
      latest = await launchHelm(world)
      Object.assign(helm, latest)
      return latest
    })
  }
})

interface TerminalReport {
  key: string
  lines: string[]
  attached: boolean
}

/**
 * What a session's terminal shows, read through the window's read-only
 * terminal inspector, since xterm paints to a canvas.
 */
export async function terminalText(window: Page, sessionId: number): Promise<string> {
  const sessions = await window.evaluate(
    () => (window as unknown as { __helmTerminals: () => { sessions: TerminalReport[] } }).__helmTerminals().sessions
  )
  return sessions.find((s) => s.key === String(sessionId))?.lines.join('\n') ?? ''
}

/** The session id behind a session tab, which Helm keys its terminals by. */
export async function sessionIdOf(window: Page, tabName: string | RegExp): Promise<number> {
  const id = await window.getByRole('tab', { name: tabName }).first().getAttribute('data-tab')
  const match = /^session:(\d+)$/.exec(id ?? '')
  if (!match) throw new Error(`no session tab named ${String(tabName)} (found ${String(id)})`)
  return Number(match[1])
}

/** The fake CLI's record of the run started in `cwd`, once it exists. */
export async function claudeRunIn(world: World, cwd: string): Promise<FakeClaudeLog> {
  let found: FakeClaudeLog | undefined
  await expect
    .poll(() => {
      found = fakeClaudeLogs(world).find((log) => log.cwd.toLowerCase() === cwd.toLowerCase())
      return found !== undefined
    })
    .toBe(true)
  return found as FakeClaudeLog
}

/** Starts a session from a project's `+` in the sidebar and waits for it to be ready. */
export async function startSession(window: Page, project: string): Promise<number> {
  const start = window.getByRole('button', { name: `Start a session in ${project}` })
  await start.hover()
  await start.click()
  await expect(window.getByRole('tab', { name: `${project}, ready` })).toBeVisible()
  return sessionIdOf(window, `${project}, ready`)
}

/** Types a line into the terminal shown in `pane` and presses Enter. */
export async function typeLine(pane: Locator, text: string): Promise<void> {
  await pane.getByRole('textbox', { name: 'Terminal input' }).pressSequentially(text)
  await pane.page().keyboard.press('Enter')
}

/** Whether a process is still running. `EPERM` means it exists and is not ours to signal. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
