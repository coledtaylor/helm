import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AppSettings, RestoreOffer, SavedPaneNode, SessionActivityState } from '@helm/core'
import { removeShims } from '../test/overlay-world'
import { fakeClaudeLogs, seedProfile, type FakeClaudeLog, type World } from '../test/world'
import {
  claudeRunIn,
  expect,
  launchHelm,
  processAlive,
  startSession,
  terminalText,
  test as base,
  typeLine,
  sessionIdOf,
  type Helm
} from './helm'

/**
 * After Helm stops without shutting down. The crash is real: the app's main
 * process is killed outright, which is what Task Manager's End task does, and
 * the next start is a second launch over the same data directory.
 */
const test = base.extend({
  world: async ({ world }, use) => {
    const kit = join(world.root, 'kit')
    mkdirSync(join(kit, '.claude', 'skills', 'think'), { recursive: true })
    writeFileSync(
      join(kit, '.claude', 'skills', 'think', 'SKILL.md'),
      '---\nname: think\ndescription: Think it through.\n---\n# think\n'
    )
    seedProfile(world, {
      name: 'kit',
      root: kit,
      overlays: [kit],
      access: [],
      model: 'sonnet',
      effort: null,
      permissionMode: 'auto',
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null
    })
    await use(world)
    removeShims(join(world.dataDir, 'overlays'))
  }
})

type Bridge = { helm: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
const invoke = <T>(window: Page, channel: string): Promise<T> =>
  window.evaluate((name) => (window as unknown as Bridge).helm.invoke(name), channel) as Promise<T>

const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

/** Waits until the panes Helm writes down name every one of these sessions. */
async function layoutNames(window: Page, ids: number[]): Promise<void> {
  await expect
    .poll(async () => {
      const { paneLayout } = await invoke<AppSettings>(window, 'settings:read')
      const sessionsIn = (node: SavedPaneNode): number[] =>
        'axis' in node
          ? node.children.flatMap(sessionsIn)
          : node.panes.flatMap((pane) => (pane.kind === 'session' ? [pane.id] : []))
      const saved = paneLayout === null ? [] : sessionsIn(paneLayout.root)
      return ids.every((id) => saved.includes(id))
    })
    .toBe(true)
}

/**
 * Kills the app the way a crash does, waits for its sessions to go with it, and
 * starts it again. The main process's own pid: `app.process()` is the
 * launcher Playwright started, and killing that leaves Helm running.
 */
async function crashAndRestart(helm: Helm, world: World): Promise<Helm> {
  const running = fakeClaudeLogs(world).filter((log) => log.exitCode === null && processAlive(log.pid))
  process.kill(await helm.app.evaluate(() => process.pid))
  await expect.poll(() => running.filter((log) => processAlive(log.pid)).map((log) => log.pid)).toEqual([])
  const next = await launchHelm(world)
  // The fixture closes whichever app `helm` is at the end.
  Object.assign(helm, next)
  return next
}

const resumedRuns = (world: World): FakeClaudeLog[] => fakeClaudeLogs(world).filter((log) => log.resumed)

test('after a crash, the sessions come back where they were, in their own folder, profile and mode', async ({ helm, world }) => {
  let { window } = helm
  const alphaId = await startSession(window, 'alpha')
  const first = window.getByRole('region', { name: 'First pane' })
  await typeLine(first, 'draft the schema')
  await expect.poll(() => terminalText(window, alphaId)).toContain('You said: draft the schema')

  // Beside it, from the launcher, with a profile and a mode picked there.
  await window.keyboard.press('Control+N')
  const launcher = window.getByRole('dialog', { name: 'New session' })
  await window.keyboard.type('beta')
  await launcher.getByRole('combobox', { name: 'Profile' }).selectOption({ label: 'kit' })
  await launcher.getByRole('combobox', { name: 'Permissions' }).selectOption({ label: 'Plan' })
  await launcher.getByRole('combobox', { name: 'Folder' }).press('Control+Enter')
  const second = window.getByRole('region', { name: 'Second pane' })
  await expect(second.getByRole('tab', { name: 'beta, ready' })).toBeVisible()
  const betaId = await sessionIdOf(window, 'beta, ready')

  // A /clear moves it to a new conversation; that is the one to bring back.
  await typeLine(second, 'sketch the migration')
  await expect.poll(() => terminalText(window, betaId)).toContain('You said: sketch the migration')
  await typeLine(second, '/clear')
  const beta = await claudeRunIn(world, world.projects.beta)
  let cleared = ''
  await expect
    .poll(() => {
      cleared = fakeClaudeLogs(world).find((log) => log.pid === beta.pid)?.current ?? ''
      return cleared !== '' && cleared !== beta.sessionId
    })
    .toBe(true)
  await typeLine(second, 'now the backfill')
  await expect.poll(() => terminalText(window, betaId)).toContain('You said: now the backfill')
  // The poller has seen the move once the window's own reading of it has.
  await expect
    .poll(async () => (await invoke<SessionActivityState[]>(window, 'session:activity')).find((s) => s.id === betaId)?.claudeSessionId)
    .toBe(cleared)
  await layoutNames(window, [alphaId, betaId])
  const alpha = await claudeRunIn(world, world.projects.alpha)

  ;({ window } = await crashAndRestart(helm, world))

  const offer = window.getByRole('region', { name: '2 sessions were running when Helm closed' })
  await expect(offer).toBeVisible()
  await expect(window.getByRole('tab', { name: 'Restore sessions' })).toBeVisible()
  await expect(offer.getByRole('checkbox', { name: 'alpha' })).toBeChecked()
  await expect(offer.getByRole('checkbox', { name: 'beta' })).toBeChecked()
  await expect(offer.locator(`[data-restore-row]`).nth(1)).toContainText('kit')
  await offer.getByRole('button', { name: 'Resume 2 sessions' }).click()

  // Each in the pane it had, and the offer gone.
  await expect(window.getByRole('region', { name: 'First pane' }).getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  await expect(window.getByRole('region', { name: 'Second pane' }).getByRole('tab', { name: 'beta, ready' })).toBeVisible()
  await expect(window.getByRole('tab', { name: 'Restore sessions' })).toHaveCount(0)

  await expect.poll(() => resumedRuns(world).length).toBe(2)
  const runs = resumedRuns(world)
  const alphaRun = runs.find((run) => run.cwd.toLowerCase() === world.projects.alpha.toLowerCase())
  const betaRun = runs.find((run) => run.cwd.toLowerCase() === world.projects.beta.toLowerCase())
  expect(after(alphaRun?.argv ?? [], '--resume')).toBe(alpha.sessionId)
  expect(alphaRun?.argv).not.toContain('--permission-mode')
  expect(after(betaRun?.argv ?? [], '--resume')).toBe(cleared)
  expect(after(betaRun?.argv ?? [], '--permission-mode')).toBe('plan')
  expect(after(betaRun?.argv ?? [], '--model')).toBe('sonnet')
  expect((after(betaRun?.argv ?? [], '--plugin-dir') ?? '').toLowerCase()).toContain(join(world.dataDir, 'overlays').toLowerCase())
  const reopened = await sessionIdOf(window, 'beta, ready')
  await expect.poll(() => terminalText(window, reopened)).toContain(`Resumed ${cleared}`)
})

test('not now reopens nothing, and the next start does not ask again', async ({ helm, world, relaunch }) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  await typeLine(window.getByRole('region', { name: 'First pane' }), 'draft the schema')
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  await layoutNames(window, [id])

  ;({ window } = await crashAndRestart(helm, world))
  const offer = window.getByRole('region', { name: '1 session was running when Helm closed' })
  await offer.getByRole('button', { name: 'Not now' }).click()
  await expect(offer).toHaveCount(0)
  await expect(window.getByRole('tab', { name: 'Restore sessions' })).toHaveCount(0)
  expect(await invoke<RestoreOffer | null>(window, 'session:restorable')).toBeNull()
  expect(resumedRuns(world)).toEqual([])

  ;({ window } = await relaunch())
  await expect(window.getByRole('button', { name: 'Start a session in alpha' })).toBeAttached()
  expect(await invoke<RestoreOffer | null>(window, 'session:restorable')).toBeNull()
  expect(resumedRuns(world)).toEqual([])
})

test('ticked to resume without asking, the next crash is put back with no question', async ({ helm, world }) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  await typeLine(window.getByRole('region', { name: 'First pane' }), 'draft the schema')
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  await layoutNames(window, [id])

  ;({ window } = await crashAndRestart(helm, world))
  const offer = window.getByRole('region', { name: '1 session was running when Helm closed' })
  // Clicked, then waited on: the box shows the stored setting, so it ticks when
  // the write has come back from main - `check()` asserts it the instant after
  // the click, and lost that race under a loaded suite.
  const always = offer.getByRole('checkbox', { name: 'Always resume without asking' })
  await always.click()
  await expect(always).toBeChecked()
  await expect
    .poll(async () => (await invoke<AppSettings>(window, 'settings:read')).restoreWithoutAsking)
    .toBe(true)
  await offer.getByRole('button', { name: 'Resume 1 session' }).click()
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  const back = await sessionIdOf(window, 'alpha, ready')
  await layoutNames(window, [back])

  ;({ window } = await crashAndRestart(helm, world))
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  await expect(window.getByText('Reopened 1 session Helm was running when it closed.')).toBeVisible()
  await expect(window.getByRole('tab', { name: 'Restore sessions' })).toHaveCount(0)
  await expect.poll(() => resumedRuns(world).length).toBe(2)
})
