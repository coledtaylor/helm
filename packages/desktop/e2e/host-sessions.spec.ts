import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { AppSettings } from '@helm/core'
import { bearerOf, callTool, readMcpConfig } from '../test/mcp-client'
import { fakeClaudeLogs, seedSettings, type FakeClaudeLog, type World } from '../test/world'
import { harnessIn, plantHarness, removeShims } from '../test/overlay-world'
import { startBrowserFixture } from './browser-fixture'
import { TOKEN, installSample, pluginFrame, startServer, type SampleFixture } from './plugin-fixture'
import {
  claudeRunIn,
  expect,
  flotiChildren,
  launchHelm,
  mainPid,
  processAlive,
  sessionIdOf,
  startSession,
  terminalText,
  test as base,
  typeLine
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

/**
 * A harness the first scan finds, `hub`, whose `repos/tools` has a skill to
 * compose. The host's launch folders hold links into it, so any left are
 * unlinked before the world is removed.
 */
const withHarness = test.extend({
  world: async ({ world }, use) => {
    plantHarness(world)
    await use(world)
    const launches = join(world.dataDir, 'host', 'data', 'launches')
    if (existsSync(launches)) {
      for (const launch of readdirSync(launches)) removeShims(join(launches, launch, 'overlays'))
    }
  }
})

/** The sample plugin, registered before the app starts, against a sample server on this machine. */
const withSample = test.extend<{ sample: SampleFixture }>({
  sample: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServer()
      await use({ dir: '', server })
      await server.close()
    },
    { scope: 'test' }
  ],
  world: async ({ world, sample }, use) => {
    sample.dir = installSample(world, sample.server)
    await use(world)
  }
})

const clientFolder = (world: World): string => join(world.dataDir, 'host-client')
const enrolmentFile = (world: World): string => join(world.dataDir, 'host', 'data', 'enrolment.json')

type Bridge = { helm: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
const invoke = <T>(window: Page, channel: string): Promise<T> =>
  window.evaluate((name) => (window as unknown as Bridge).helm.invoke(name), channel) as Promise<T>

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

test('a session in the host opens, reads and clicks in a page of the Browser tab, under its own name', async ({
  helm,
  world
}) => {
  const fixture = await startBrowserFixture()
  try {
    const { window } = helm
    await startSession(window, 'alpha')

    // The user is looking at a page of their own.
    await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Browser', exact: true }).click()
    const address = window.getByRole('textbox', { name: 'Address' })
    await address.fill(`${fixture.http}/find`)
    await address.press('Enter')
    const userTab = window.getByRole('tab', { name: /^Helm fixture find/ })
    await expect(userTab).toBeVisible()

    // The host wrote the session's tools under today's name, beside the
    // host's own session tools.
    const run = await claudeRunIn(world, world.projects.alpha)
    const config = readMcpConfig(run.argv[run.argv.indexOf('--mcp-config') + 1] ?? '')
    const browser = config.mcpServers['helm-browser']
    if (browser === undefined) throw new Error(`no helm-browser in ${JSON.stringify(config)}`)
    const token = bearerOf(browser)
    const tool = (name: string, args: Record<string, unknown> = {}) => callTool(browser.url, token, name, args)

    // Opened behind the user's page, labelled with the session's name.
    const opened = await tool('browser_open', { url: `${fixture.http}/` })
    expect(opened.isError).toBe(false)
    expect(opened.text).toContain('title: Helm fixture one')
    const agentTab = window.getByRole('tab', { name: /^Helm fixture one/ })
    await expect(agentTab).toBeVisible()
    await expect(agentTab.getByText('alpha', { exact: true })).toBeVisible()
    await expect(agentTab).toHaveAttribute('aria-selected', 'false')
    await expect(userTab).toHaveAttribute('aria-selected', 'true')

    // Read, then clicked by the ref the snapshot gave: the link is followed
    // in the session's tab, which keeps its name.
    const snapshot = await tool('browser_snapshot')
    expect(snapshot.isError).toBe(false)
    const ref = /- link "Two".*\[ref=([\d.]+)\]/.exec(snapshot.text)?.[1]
    expect(ref, snapshot.text).toBeDefined()
    expect((await tool('browser_click', { ref })).isError).toBe(false)
    const followed = window.getByRole('tab', { name: /^Helm fixture two/ })
    await expect(followed).toBeVisible()
    await expect(followed.getByText('alpha', { exact: true })).toBeVisible()
    await expect(userTab).toHaveAttribute('aria-selected', 'true')
    expect(fixture.requests).toContain(`${fixture.http}/two`)

    // The user's page is listed as theirs and is not the session's to read.
    const tabs = (await tool('browser_tabs')).text
    const userBlock = tabs.split(/\n(?=#)/).find((block) => block.includes(`${fixture.http}/find`)) ?? ''
    expect(userBlock).toContain('opened by the user')
    const peek = await tool('browser_snapshot', { tab: Number(/^#(\d+) /.exec(userBlock)?.[1]) })
    expect(peek.isError).toBe(true)
    expect(peek.text).toContain('opened by the user')
    expect(peek.text).not.toContain('needle')
  } finally {
    await fixture.close()
  }
})

withHarness(
  'a profile made in the New profile dialog launches in the host with its overlay, name and opening prompt',
  async ({ helm, world }) => {
    const { window } = helm
    const hub = harnessIn(world)
    const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]
    await expect(window.getByRole('button', { name: 'hub, 2 projects' })).toBeVisible()

    await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Profiles' }).click()
    await window.getByRole('button', { name: 'New profile' }).click()
    const dialog = window.getByRole('dialog', { name: 'New profile' })
    await dialog.getByRole('textbox', { name: 'Profile name' }).fill('hub dev')
    await dialog.getByRole('textbox', { name: 'Root directory' }).fill(hub.root)
    await dialog.getByRole('checkbox', { name: 'Compose tools' }).check()
    await dialog.getByRole('textbox', { name: 'Opening prompt' }).fill('/recap')
    await dialog.getByRole('button', { name: 'Save and start' }).click()
    await expect(dialog).toBeHidden()
    await expect(window.getByRole('list', { name: 'Saved profiles' }).getByRole('button', { name: /^hub dev/ })).toBeVisible()

    // Saved in the host, not in Helm's own database.
    const listed = await invoke<Array<{ name: string }>>(window, 'profile:list')
    expect(listed.map((profile) => profile.name)).toEqual(['hub dev'])

    await expect(window.getByRole('tab', { name: 'hub dev, ready' })).toBeVisible()
    const id = await sessionIdOf(window, 'hub dev, ready')
    await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')

    // Run by the host at the profile's root, the overlay a plugin directory in
    // the host's own launch folder, named for the profile, its prompt first.
    const run = await claudeRunIn(world, hub.root)
    const pluginDir = after(run.argv, '--plugin-dir') ?? ''
    expect(pluginDir.toLowerCase().startsWith(join(world.dataDir, 'host').toLowerCase())).toBe(true)
    expect(existsSync(join(pluginDir, 'skills', hub.skill, 'SKILL.md'))).toBe(true)
    expect(after(run.argv, '-n')).toBe('hub dev')
    expect(run.openingPrompt).toBe('/recap')
  }
)

withSample(
  'a plugin page starts a session in the host from a click, as the dialog showed it',
  async ({ helm, sample, world }) => {
    const ui = helm.window
    await ui.evaluate(
      ({ token, host }) =>
        (window as unknown as Bridge).helm.invoke('secrets:save', {
          key: 'sample-token',
          value: token,
          hosts: [host],
          plugins: ['sample']
        }),
      { token: TOKEN, host: sample.server.url }
    )
    await ui.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: /^Sample/ }).click()
    const panel = await pluginFrame(ui, 'dist/panels/main.html')
    await panel.locator('[data-sample-item="2"]').click()
    const item = await pluginFrame(ui, 'dist/tabs/item.html')
    await expect(item.locator('h1')).toHaveText('Second item')

    const dialog = ui.getByRole('alertdialog', { name: 'Sample wants to start a session' })
    const field = (name: string): Locator => dialog.locator(`[data-plugin-session-field="${name}"] dd`)
    await item.locator('[data-sample-session-folder]').fill(world.projects.alpha)
    await item.locator('[data-sample-session-start]').click()
    await expect(field('folder')).toHaveText(world.projects.alpha)
    await expect(field('name')).toHaveText('Second item')
    await expect(field('prompt')).toHaveText('work on Second item')
    await expect(field('command')).toHaveText('claude -n "Second item" "work on Second item"')

    await dialog.getByRole('button', { name: 'Start session' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(ui.getByRole('tab', { name: 'Second item, ready' })).toHaveAttribute('aria-selected', 'true')
    await expect(item.locator('[data-sample-session-result]')).toHaveText('Started.')

    // The host ran it in that folder, under that name, with that first message.
    const run = await claudeRunIn(world, world.projects.alpha)
    expect(run.argv[run.argv.indexOf('-n') + 1]).toBe('Second item')
    expect(run.openingPrompt).toBe('work on Second item')
    expect(run.exitCode).toBeNull()
    const sessions = await invoke<Array<{ name: string; projectPath: string | null }>>(ui, 'session:list')
    expect(sessions).toEqual([
      expect.objectContaining({ name: 'Second item', projectPath: world.projects.alpha })
    ])
  }
)

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
