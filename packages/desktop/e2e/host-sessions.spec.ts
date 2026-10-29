import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AppSettings } from '@helm/core'
import { fakeClaudeLogs, seedSettings, type FakeClaudeLog, type World } from '../test/world'
import {
  claudeRunIn,
  expect,
  launchHelm,
  processAlive,
  sessionIdOf,
  startSession,
  terminalText,
  test as base,
  typeLine,
  type Helm
} from './helm'

/**
 * With "Run sessions in the local host" on: sessions and terminals run in a
 * `floti host` Helm starts in its own data directory, reached through
 * `floti bridge` from Helm's client folder. `pnpm test:e2e` builds both.
 */
const test = base.extend({
  world: async ({ world }, use) => {
    seedSettings(world, { sessionsInHost: true })
    await use(world)
  }
})

const clientFolder = (world: World): string => join(world.dataDir, 'host-client')
const enrolmentFile = (world: World): string => join(world.dataDir, 'host', 'data', 'enrolment.json')

type Bridge = { helm: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
const invoke = <T>(window: Page, channel: string): Promise<T> =>
  window.evaluate((name) => (window as unknown as Bridge).helm.invoke(name), channel) as Promise<T>

/** The pid of Helm's main process: `app.process()` is the launcher Playwright started. */
const mainPid = (helm: Helm): Promise<number> => helm.app.evaluate(() => process.pid)

/** The `floti` programs a process started, by pid: the host and the bridge. */
function flotiChildren(parent: number): number[] {
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

/** How many times `text` is on a session's screen. */
const count = (screen: string, text: string): number => screen.split(text).length - 1

test('the first start enrols as the host’s first admin, and the next connects to the key it pinned', async ({
  helm,
  world,
  relaunch
}) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')

  expect(readdirSync(clientFolder(world)).sort()).toEqual(['device.key', 'host.pub'])
  expect(existsSync(enrolmentFile(world))).toBe(false)

  ;({ window } = await relaunch())
  const again = await startSession(window, 'beta')
  await expect.poll(() => terminalText(window, again)).toContain('Claude Code v2.1.999 (fake)')
  expect(readdirSync(clientFolder(world)).sort()).toEqual(['device.key', 'host.pub'])
  expect(existsSync(enrolmentFile(world))).toBe(false)
})

test('a session in the host takes input, takes the pane’s size, is drawn again after a reload, and closes with confirmation', async ({
  helm,
  world
}) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')

  await typeLine(pane, 'hello there')
  await expect.poll(() => terminalText(window, id)).toContain('You said: hello there')
  const run = await claudeRunIn(world, world.projects.alpha)
  const log = (): FakeClaudeLog | undefined => fakeClaudeLogs(world).find((entry) => entry.pid === run.pid)
  expect(log()?.received).toEqual(['hello there'])
  // The `claude` chosen in Settings, run by the host in the project.
  expect(run.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())

  // The pane's size reaches the agent's terminal.
  await helm.app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    const [width, height] = win?.getSize() ?? [1200, 800]
    win?.setSize((width ?? 1200) + 160, (height ?? 800) + 80)
  })
  const grid = async (): Promise<{ cols: number; rows: number } | undefined> => {
    const sessions = await window.evaluate(
      () =>
        (
          window as unknown as { __helmTerminals: () => { sessions: { key: string; cols: number; rows: number }[] } }
        ).__helmTerminals().sessions
    )
    const terminal = sessions.find((session) => session.key === String(id))
    return terminal === undefined ? undefined : { cols: terminal.cols, rows: terminal.rows }
  }
  await expect
    .poll(async () => {
      const shown = await grid()
      return (
        shown !== undefined &&
        (log()?.resized ?? []).some((size) => size.cols === shown.cols && size.rows === shown.rows)
      )
    })
    .toBe(true)

  // A reload draws the screen as it was, then streams, with nothing repeated.
  await window.reload()
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  await expect.poll(() => terminalText(window, id)).toContain('You said: hello there')
  expect(count(await terminalText(window, id), 'You said: hello there')).toBe(1)
  await typeLine(pane, 'after the reload')
  await expect.poll(() => terminalText(window, id)).toContain('You said: after the reload')
  expect(count(await terminalText(window, id), 'You said: hello there')).toBe(1)
  expect(log()?.received).toEqual(['hello there', 'after the reload'])

  // Declined, the session keeps running; agreed, the host ends it.
  const dialog = window.getByRole('alertdialog', { name: '“alpha” is still running.' })
  await pane.getByRole('button', { name: 'Close alpha' }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pane.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(processAlive(run.pid)).toBe(true)

  await pane.getByRole('button', { name: 'Close alpha' }).click()
  await dialog.getByRole('button', { name: 'End session' }).click()
  await expect(window.getByRole('tab', { name: /^alpha/ })).toHaveCount(0)
  await expect.poll(() => processAlive(run.pid)).toBe(false)
  expect(await invoke<unknown[]>(window, 'session:list')).toEqual([])
})

test('a project’s terminal on the host takes input and is drawn again after a reload', async ({ helm, world }) => {
  const { window } = helm
  const pane = window.getByRole('region', { name: 'First pane' })
  // The project's own shell, under its tab: the tab is kept across a reload.
  const shellText = async (): Promise<string> =>
    (
      await window.evaluate(
        () =>
          (
            window as unknown as { __helmTerminals: () => { shells: { path: string; lines: string[] }[] } }
          ).__helmTerminals().shells
      )
    )
      .filter((shell) => shell.path.toLowerCase() === world.projects.alpha.toLowerCase())
      .flatMap((shell) => shell.lines)
      .join('\n')

  await window.getByRole('button', { name: 'alpha main' }).click()
  await expect(pane.getByRole('textbox', { name: 'Terminal input' })).toBeAttached()
  // Its folder's name, as the shell in the project's folder prints it.
  await typeLine(pane, `node -e "console.log('here=' + require('path').basename(process.cwd()))"`)
  const cwdLine = 'here=alpha'
  await expect.poll(shellText).toContain(cwdLine)
  // The project's tab is written down before the reload, as any is in time.
  await expect
    .poll(async () => JSON.stringify((await invoke<AppSettings>(window, 'settings:read')).paneLayout ?? {}))
    .toContain('"kind":"project"')

  await window.reload()
  await expect(pane.getByRole('textbox', { name: 'Terminal input' })).toBeAttached()
  // Drawn from the host's screen, once.
  await expect.poll(shellText).toContain(cwdLine)
  expect(count(await shellText(), cwdLine)).toBe(1)
  await typeLine(pane, 'node -e "console.log(\'again=\' + (6 * 7))"')
  await expect.poll(shellText).toContain('again=42')
  expect(count(await shellText(), cwdLine)).toBe(1)
})

test('quitting ends every session in the host and leaves no host or bridge running', async ({ helm, world }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')
  const pids = [
    (await claudeRunIn(world, world.projects.alpha)).pid,
    (await claudeRunIn(world, world.projects.beta)).pid
  ]
  const floti = flotiChildren(await mainPid(helm))
  // The host Helm started and the bridge it reaches it through.
  expect(floti).toHaveLength(2)
  expect([...pids, ...floti].every(processAlive)).toBe(true)

  await helm.app.close()
  await expect.poll(() => [...pids, ...floti].filter(processAlive)).toEqual([])
})

test('after Helm is killed outright, the host went with it, and the sessions it had come back through the host', async ({
  helm,
  world
}) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  await typeLine(window.getByRole('region', { name: 'First pane' }), 'draft the schema')
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  // Its conversation is known, and the pane layout names it.
  await expect
    .poll(async () => {
      const { paneLayout } = await invoke<AppSettings>(window, 'settings:read')
      return JSON.stringify(paneLayout ?? {}).includes(`"id":${String(id)}`)
    })
    .toBe(true)
  const run = await claudeRunIn(world, world.projects.alpha)
  const floti = flotiChildren(await mainPid(helm))
  expect(floti).toHaveLength(2)

  process.kill(await mainPid(helm))
  await expect.poll(() => [run.pid, ...floti].filter(processAlive)).toEqual([])

  const next = await launchHelm(world)
  Object.assign(helm, next)
  window = next.window
  const offer = window.getByRole('region', { name: '1 session was running when Helm closed' })
  await expect(offer).toBeVisible()
  await offer.getByRole('button', { name: 'Resume 1 session' }).click()
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()

  await expect.poll(() => fakeClaudeLogs(world).filter((log) => log.resumed).length).toBe(1)
  const resumed = fakeClaudeLogs(world).find((log) => log.resumed)
  expect(resumed?.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
  expect(resumed?.argv[(resumed?.argv.indexOf('--resume') ?? 0) + 1]).toBe(run.sessionId)
  const back = await sessionIdOf(window, 'alpha, ready')
  await expect.poll(() => terminalText(window, back)).toContain(`Resumed ${run.sessionId}`)
})
