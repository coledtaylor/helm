import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
    // Main records the channels each page uses over IPC (`ipc-recorder.ts`).
    env: { ...world.env, HELM_RECORD_IPC: '1' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window }
}

/** Where a launch's overlay shims are built: the local host's launch folders. */
export const shimFolderOf = (world: World): string => join(world.dataDir, 'host', 'data', 'launches')

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

/** A host log line naming a process the host ran: its own start, or a session keeper it started or took back. */
const HOST_LOG_PID = /floti host \S+ started at .*, process (\d+)|session keeper, process (\d+)\b/

/**
 * Every process a world's hosts ran, by pid, and every fake `claude` run in
 * it: what the world's files stay open in while it runs. Each host writes its
 * own pid, and each keeper's, into the host logs inside the world.
 */
export function worldProcesses(world: World): number[] {
  const pids = new Set(fakeClaudeLogs(world).map((log) => log.pid))
  const hostFolder = join(world.dataDir, 'host')
  if (existsSync(hostFolder)) {
    for (const entry of readdirSync(hostFolder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/^host\.log(\.\d+)?$/.test(entry.name)) continue
      for (const line of readFileSync(join(entry.parentPath, entry.name), 'utf8').split(/\r?\n/)) {
        const match = HOST_LOG_PID.exec(line)
        const pid = Number(match?.[1] ?? match?.[2])
        if (pid > 0) pids.add(pid)
      }
    }
  }
  return [...pids]
}

/**
 * A test with a fresh world, seeded and torn down around it. `helm` is the app,
 * launched once; a test that restarts it calls `relaunch`.
 *
 * The world goes only once nothing it ran is still running: the app's quit
 * ends the sessions, then the keeper and the host exit by themselves, and
 * until they have, Windows refuses to delete the files they hold. A test that
 * leaves something running fails here, naming its pids.
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
    await expect
      .poll(() => worldProcesses(world).filter(processAlive), { message: 'what the world ran has exited' })
      .toEqual([])
    removeHostShims(world)
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

/**
 * Moves Helm's window clear of the system cursor before a test holds a divider
 * down, without moving the cursor: it is the person's at the machine.
 *
 * Playwright's mouse is not the system's. Whenever what is under the resting
 * cursor changes (a browser page standing down, say), Windows sends the window
 * a move at that cursor with no button held, and a divider takes a buttonless
 * move as a release made outside the window (`PaneGrid.tsx`), so a press the
 * test holds would end wherever the cursor happened to rest over the window.
 * The window keeps its size, so what the test measures is unchanged, and goes
 * to whichever side of the cursor has more room, past the screen's edge if it
 * must.
 */
export async function keepClearOfCursor(helm: Helm): Promise<void> {
  await helm.app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())
    if (win === undefined) throw new Error('no visible Helm window')
    const cursor = screen.getCursorScreenPoint()
    const under = (b: Electron.Rectangle): boolean =>
      cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height
    const bounds = win.getBounds()
    if (!under(bounds)) return
    const area = screen.getDisplayNearestPoint(cursor).workArea
    const margin = 16
    const leftRoom = cursor.x - area.x
    const rightRoom = area.x + area.width - cursor.x
    win.setBounds({ ...bounds, x: leftRoom >= rightRoom ? cursor.x - margin - bounds.width : cursor.x + margin })
    if (under(win.getBounds())) throw new Error(`the window could not be moved clear of the cursor at ${String(cursor.x)},${String(cursor.y)}`)
  })
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

/** Which of the `floti` processes `pids` is a host (`floti host`), told from a bridge by its command line. */
export function flotiHostsAmong(pids: readonly number[]): number[] {
  if (pids.length === 0) return []
  const listing =
    process.platform === 'win32'
      ? execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process -Filter "Name='floti.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`
          ],
          { encoding: 'utf8' }
        )
      : execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
  const hosts = new Set<number>()
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match !== null && /floti(\.exe)?"?\s+host(\s|$)/.test(match[2] ?? '')) hosts.add(Number(match[1]))
  }
  return pids.filter((pid) => hosts.has(pid))
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
