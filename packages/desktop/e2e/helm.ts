import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeShims } from '../test/overlay-world'
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
 * Where a launch's overlay shims are built: Helm's data folder, or the local
 * host's launch folders inside it while sessions run there.
 */
export const shimFolderOf = (world: World, sessionsInHost: boolean): string =>
  sessionsInHost ? join(world.dataDir, 'host', 'data', 'launches') : join(world.dataDir, 'overlays')

/**
 * Unlinks the overlay shims the local host's launches built in a world: they
 * hold links into the world's harness, and a link is never walked when the
 * world is removed.
 */
export function removeHostShims(world: World): void {
  const launches = join(world.dataDir, 'host', 'data', 'launches')
  if (!existsSync(launches)) return
  for (const launch of readdirSync(launches)) removeShims(join(launches, launch, 'overlays'))
}

/**
 * A test with a fresh world, seeded and torn down around it. `helm` is the app,
 * launched once; a test that restarts it calls `relaunch`.
 *
 * `sessionsInHost` seeds "Run sessions in the local host" on: the
 * `in the local host` project in `playwright.config.ts` runs the specs it
 * names again that way.
 */
export const test = base.extend<{
  sessionsInHost: boolean
  world: World
  helm: Helm
  relaunch: () => Promise<Helm>
}>({
  sessionsInHost: [false, { option: true }],
  world: async ({ sessionsInHost }, use) => {
    const world = createWorld()
    seedSettings(world, sessionsInHost ? { sessionsInHost: true } : {})
    await use(world)
    if (sessionsInHost) removeHostShims(world)
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

/** The pid of Helm's main process: `app.process()` is the launcher Playwright started. */
export const mainPid = (helm: Helm): Promise<number> => helm.app.evaluate(() => process.pid)

/** The `floti` programs a process started, by pid: the host and the bridge. */
export function flotiChildren(parent: number): number[] {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${String(parent)} AND Name='floti.exe'" | ForEach-Object { $_.ProcessId }`
      ],
      { encoding: 'utf8' }
    )
    return out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 0)
  }
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, comm]) => Number(ppid) === parent && (comm ?? '').endsWith('floti'))
    .map(([pid]) => Number(pid))
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
