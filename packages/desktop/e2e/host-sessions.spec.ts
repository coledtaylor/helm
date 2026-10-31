import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { openStore, readArchiveStats, readHistorySessions, type AppSettings } from '@helm/core'
import { bearerOf, callTool, readMcpConfig, rpc, rpcResult, toolNames } from '../test/mcp-client'
import { fakeClaudeLogs, seedSettings, type FakeClaudeLog, type World } from '../test/world'
import { harnessIn, plantHarness, removeShims } from '../test/overlay-world'
import { startBrowserFixture } from './browser-fixture'
import { TOKEN, installSample, pluginFrame, startServer, type SampleFixture } from './plugin-fixture'
import {
  claudeRunIn,
  expect,
  flotiChildren,
  flotiHostsAmong,
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

/** The window's routed bridge (`inspect.ts`): host features over the window's own connection. */
type Bridge = { __helmRouted: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }
const invoke = <T>(window: Page, channel: string): Promise<T> =>
  window.evaluate((name) => (window as unknown as Bridge).__helmRouted.invoke(name), channel) as Promise<T>

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
  const dialog = window.getByRole('alertdialog', { name: '“alpha” is still running on this PC’s host.' })
  await pane.getByRole('button', { name: 'Close alpha' }).click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(pane.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(processAlive(run.pid)).toBe(true)

  await pane.getByRole('button', { name: 'Close alpha' }).click()
  await dialog.getByRole('button', { name: 'End session' }).click()
  await expect(window.getByRole('tab', { name: /^alpha/ })).toHaveCount(0)
  await expect.poll(() => processAlive(run.pid)).toBe(false)
})

test('the sessions pane shows a host session’s process tree and listening ports as the host read them', async ({
  helm,
  world
}) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')
  await typeLine(pane, '/child')
  let child = 0
  await expect
    .poll(async () => {
      child = Number(/child (\d+)/.exec(await terminalText(window, id))?.[1] ?? 0)
      return child
    })
    .toBeGreaterThan(0)
  const run = await claudeRunIn(world, world.projects.alpha)

  await window.locator('[data-open-sessions]').click()
  await window.getByRole('region', { name: 'In Helm' }).locator('[data-session-hosted="true"]').click()

  // The agent and the child it started, from the host's pass.
  const tree = window.getByRole('region', { name: 'Process tree' })
  await expect(tree.locator(`[data-tree-pid="${String(run.pid)}"]`)).toBeVisible()
  await expect(tree.locator(`[data-tree-pid="${String(child)}"]`)).toBeVisible()
  // The host looked and the child listens on nothing: said so, not Unknown.
  await expect(window.getByRole('region', { name: 'Listening ports' })).toContainText(
    'Nothing in this session’s process tree is listening.'
  )
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
        (window as unknown as Bridge).__helmRouted.invoke('secrets:save', {
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

withSample(
  "a session in the host calls the sample plugin's tools and Helm's session tools, served by the host and answered by Helm",
  async ({ helm, sample, world }) => {
    const ui = helm.window
    await ui.evaluate(
      ({ token, host }) =>
        (window as unknown as Bridge).__helmRouted.invoke('secrets:save', {
          key: 'sample-token',
          value: token,
          hosts: [host],
          plugins: ['sample']
        }),
      { token: TOKEN, host: sample.server.url }
    )
    await startSession(ui, 'alpha')

    // The host wrote the session's tools, under today's names, in its own
    // launch folder: Helm's own listener is not there to.
    const run = await claudeRunIn(world, world.projects.alpha)
    const file = run.argv[run.argv.indexOf('--mcp-config') + 1] ?? ''
    expect(file.toLowerCase().startsWith(join(world.dataDir, 'host').toLowerCase())).toBe(true)
    const config = readMcpConfig(file)
    expect(Object.keys(config.mcpServers).sort()).toEqual(['helm-browser', 'helm-plugin-sample', 'helm-sessions'])
    const plugin = config.mcpServers['helm-plugin-sample']
    const sessions = config.mcpServers['helm-sessions']
    if (plugin === undefined || sessions === undefined) throw new Error(`missing servers in ${JSON.stringify(config)}`)
    expect(new URL(plugin.url).pathname).toBe('/mcp/plugin/sample')
    // The one tool the manifest marks read-only is allowed without asking.
    expect(run.allowedTools).toEqual(['mcp__helm-plugin-sample__list_items'])

    // Listed as Helm's listener lists it, and answered by the plugin's
    // background page through its own network and secret.
    const token = bearerOf(plugin)
    expect(await toolNames(plugin.url, token)).toEqual(['list_items', 'create_item'])
    const init = await rpcResult<{ instructions: string }>(plugin.url, token, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.1.999' }
    })
    expect(init.instructions).toContain('"Sample", a plugin the user added to Helm')
    const unread = await callTool(plugin.url, token, 'list_items', { unreadOnly: true })
    expect(unread.isError).toBe(false)
    expect(JSON.parse(unread.text)).toEqual([
      { id: '2', title: 'Second item', read: false },
      { id: '1', title: 'Welcome', read: false }
    ])
    expect(await callTool(plugin.url, token, 'create_item', {})).toMatchObject({
      isError: true,
      text: 'create_item needs a title.'
    })

    // Helm's session tools, from the host: the session sees itself.
    const listing = await callTool(sessions.url, bearerOf(sessions), 'sessions_list')
    expect(listing.isError).toBe(false)
    expect(listing.text).toContain('alpha')

    // Turned off in Settings: gone from the running session at once.
    await ui.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Settings' }).click()
    await ui.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sample', exact: true }).click()
    const group = ui.locator('[data-settings-group="plugin-tools"]')
    await group.getByRole('checkbox', { name: 'Offer to sessions' }).click()
    await expect(group.locator('[data-plugin-tools-state]')).toHaveText('No session gets them.')
    await expect.poll(async () => (await rpc(plugin.url, token, 'tools/list')).status).toBe(404)
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
  // The host Helm started, the bridge main reaches it through and the window's own.
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const floti = flotiChildren(await mainPid(helm))
  expect([...pids, ...floti].every(processAlive)).toBe(true)

  await helm.app.close()
  await expect.poll(() => [...pids, ...floti].filter(processAlive)).toEqual([])
})

/** Closes Helm's window the way its close button or Alt+F4 does. */
const closeWindow = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((win) => win.isVisible())
      ?.close()
  })

/**
 * Clicks an answer that quits Helm. The page clicks it once this call has
 * returned: Playwright fails any action whose page closes under it. Helm's
 * exit is then awaited on its main process, since a host it leaves running
 * holds the stdio Playwright's own close event waits on.
 */
const answer = (button: Locator): Promise<void> =>
  button.evaluate((element) => {
    setTimeout(() => (element as HTMLElement).click(), 0)
  })

test('closing the window asks first; Cancel changes nothing, Keep running and quit leaves the sessions in the host, and the next start shows their screens and takes input', async ({
  helm,
  world
}) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  await typeLine(window.getByRole('region', { name: 'First pane' }), 'draft the schema')
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  await expect
    .poll(async () => {
      const { paneLayout } = await invoke<AppSettings>(window, 'settings:read')
      return JSON.stringify(paneLayout ?? {}).includes(`"id":${String(id)}`)
    })
    .toBe(true)
  const run = await claudeRunIn(world, world.projects.alpha)
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const [host] = flotiHostsAmong(flotiChildren(await mainPid(helm)))
  expect(host).toBeDefined()
  await expect(window.getByRole('contentinfo').locator('[data-status-host]')).toHaveText('This PC · quit ends sessions')

  const question = window.getByRole('alertdialog', { name: 'Quitting Helm ends 1 session on this PC’s host.' })
  await closeWindow(helm.app)
  await expect(question.getByRole('button')).toHaveText(['Cancel', 'Keep running and quit', 'End and quit'])
  await question.getByRole('button', { name: 'Cancel' }).click()
  await expect(question).toHaveCount(0)
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect([host!, run.pid].every(processAlive)).toBe(true)

  const main = await mainPid(helm)
  await closeWindow(helm.app)
  await answer(question.getByRole('button', { name: 'Keep running and quit' }))
  await expect.poll(() => processAlive(main)).toBe(false)
  // Helm is gone; the host and the session it runs are not.
  expect([host!, run.pid].every(processAlive)).toBe(true)

  const next = await launchHelm(world)
  Object.assign(helm, next)
  window = next.window
  const pane = window.getByRole('region', { name: 'First pane' })
  await expect(pane.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(await sessionIdOf(window, 'alpha, ready')).toBe(id)
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  await typeLine(pane, 'add the indexes')
  await expect.poll(() => terminalText(window, id)).toContain('You said: add the indexes')
  // Reattached to the host it left running, and the answer was for that quit only.
  expect(flotiHostsAmong(flotiChildren(await mainPid(helm)))).toEqual([])
  const { quitSessions } = await invoke<AppSettings>(window, 'settings:read')
  expect(quitSessions['local'] ?? 'end').toBe('end')
  await expect(window.getByRole('contentinfo').locator('[data-status-host]')).toHaveText('This PC · quit ends sessions')
})

test('End and quit ends the sessions, and no host or bridge is left running', async ({ helm, world }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')
  const pids = [
    (await claudeRunIn(world, world.projects.alpha)).pid,
    (await claudeRunIn(world, world.projects.beta)).pid
  ]
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const floti = flotiChildren(await mainPid(helm))

  const main = await mainPid(helm)
  await closeWindow(helm.app)
  await answer(
    window
      .getByRole('alertdialog', { name: 'Quitting Helm ends 2 sessions on this PC’s host.' })
      .getByRole('button', { name: 'End and quit' })
  )
  await expect.poll(() => [main, ...pids, ...floti].filter(processAlive)).toEqual([])
})

test('with the quit setting keeping them, quitting asks nothing and the sessions run on', async ({ helm, world }) => {
  let { window } = helm
  const id = await startSession(window, 'alpha')
  const run = await claudeRunIn(world, world.projects.alpha)
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const [host] = flotiHostsAmong(flotiChildren(await mainPid(helm)))

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Settings' }).click()
  await window.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sessions', exact: true }).click()
  await window.getByRole('combobox', { name: 'When you quit Helm' }).selectOption('keep')
  const status = window.getByRole('contentinfo').locator('[data-status-host]')
  await expect(status).toHaveText('This PC · quit keeps sessions')
  await expect.poll(async () => (await invoke<AppSettings>(window, 'settings:read')).quitSessions).toEqual({ local: 'keep' })

  const main = await mainPid(helm)
  await closeWindow(helm.app)
  await expect.poll(() => processAlive(main)).toBe(false)
  expect([host!, run.pid].every(processAlive)).toBe(true)

  const next = await launchHelm(world)
  Object.assign(helm, next)
  window = next.window
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(await sessionIdOf(window, 'alpha, ready')).toBe(id)
  // Kept across the restart; the status bar's item opens the row that says so.
  await expect(window.getByRole('contentinfo').locator('[data-status-host]')).toHaveText('This PC · quit keeps sessions')
  await window.getByRole('contentinfo').locator('[data-status-host]').click()
  const quit = window.getByRole('combobox', { name: 'When you quit Helm' })
  await expect(quit).toHaveValue('keep')
  // Set back, so the fixture's quit ends what this test started.
  await quit.selectOption('end')
  await expect(window.getByRole('contentinfo').locator('[data-status-host]')).toHaveText('This PC · quit ends sessions')
})

test('Settings’ Stop host says how many sessions end; Cancel changes nothing, and Stop host ends them and the host', async ({
  helm,
  world
}) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')
  const pids = [
    (await claudeRunIn(world, world.projects.alpha)).pid,
    (await claudeRunIn(world, world.projects.beta)).pid
  ]
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const [host] = flotiHostsAmong(flotiChildren(await mainPid(helm)))

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Settings' }).click()
  await window.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sessions', exact: true }).click()
  const ask = window.getByRole('alertdialog', { name: 'Stopping this PC’s host ends 2 sessions.' })

  await window.locator('[data-settings-stop-host]').click()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  expect([host!, ...pids].every(processAlive)).toBe(true)

  await window.locator('[data-settings-stop-host]').click()
  await ask.getByRole('button', { name: 'Stop host' }).click()
  await expect.poll(() => [host!, ...pids].filter(processAlive)).toEqual([])
})

/** Picks Close tab, keep running from a session tab's menu. */
async function closeKeepRunning(window: Page, tab: Locator, name: string): Promise<void> {
  await tab.click({ button: 'right' })
  await window
    .getByRole('menu', { name: `${name} tab` })
    .getByRole('menuitem', { name: 'Close tab, keep running' })
    .click()
}

test('closing a session’s tab asks first naming its host; Close tab, keep running leaves it not open here, where Open shows its screen and End ends it after asking', async ({
  helm,
  world
}) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await typeLine(pane, 'draft the schema')
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  const run = await claudeRunIn(world, world.projects.alpha)
  const tab = pane.getByRole('tab', { name: 'alpha, ready' })

  // Closing asks, naming the session and its host; Cancel keeps the tab and the session.
  const ask = window.getByRole('alertdialog', { name: '“alpha” is still running on this PC’s host.' })
  await pane.getByRole('button', { name: 'Close alpha' }).click()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toHaveCount(0)
  await expect(tab).toBeVisible()
  expect(processAlive(run.pid)).toBe(true)

  // Close tab, keep running: no question, and the session runs on, not open here.
  await closeKeepRunning(window, tab, 'alpha')
  await expect(window.getByRole('tab', { name: /^alpha/ })).toHaveCount(0)
  await expect(window.getByRole('alertdialog')).toHaveCount(0)
  expect(processAlive(run.pid)).toBe(true)
  await window.locator('[data-open-sessions]').click()
  const notHere = window.getByRole('region', { name: 'Not open here' })
  await expect(notHere.locator(`[data-not-open-here="${String(id)}"]`)).toContainText('alpha')

  // Open: a tab again, drawing its screen as it is, then streaming and taking input.
  await notHere.getByRole('button', { name: 'Open alpha' }).click()
  await expect(pane.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(await sessionIdOf(window, 'alpha, ready')).toBe(id)
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')
  await typeLine(pane, 'add the indexes')
  await expect.poll(() => terminalText(window, id)).toContain('You said: add the indexes')
  expect(count(await terminalText(window, id), 'You said: draft the schema')).toBe(1)

  // End from the sessions pane asks the same question; Cancel changes nothing, End session ends it.
  await closeKeepRunning(window, pane.getByRole('tab', { name: 'alpha, ready' }), 'alpha')
  await pane.getByRole('tab', { name: 'Sessions' }).click()
  await notHere.getByRole('button', { name: 'End alpha' }).click()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(notHere.locator(`[data-not-open-here="${String(id)}"]`)).toBeVisible()
  expect(processAlive(run.pid)).toBe(true)
  await notHere.getByRole('button', { name: 'End alpha' }).click()
  await ask.getByRole('button', { name: 'End session' }).click()
  await expect.poll(() => processAlive(run.pid)).toBe(false)
  await expect(notHere).toHaveCount(0)
})

test('tabs, panes and splits come back on this device after a Keep running restart, kept in its own data, and a session it has no tab for gets none', async ({
  helm,
  world
}) => {
  let { window } = helm
  const alpha = await startSession(window, 'alpha')
  const beta = await startSession(window, 'beta')
  await typeLine(window.getByRole('region', { name: 'First pane' }), 'draft the schema')
  await expect.poll(() => terminalText(window, beta)).toContain('You said: draft the schema')
  const runs = [(await claudeRunIn(world, world.projects.alpha)).pid, (await claudeRunIn(world, world.projects.beta)).pid]

  // beta in a pane of its own, with the history beside it there; then beta's tab closed, kept running.
  await window.getByRole('button', { name: /^Split: move this tab to a pane of its own/ }).click()
  await window.locator('[data-rail="history"]').click()
  const first = window.getByRole('region', { name: 'First pane' })
  const second = window.getByRole('region', { name: 'Second pane' })
  await expect(second.getByRole('tab')).toHaveText(['beta', 'Session history'])
  await closeKeepRunning(window, second.getByRole('tab', { name: 'beta, ready' }), 'beta')
  await expect(first.getByRole('tab')).toHaveText(['alpha'])
  await expect(second.getByRole('tab')).toHaveText(['Session history'])

  // Saved in this device's own settings: alpha's tab, the split, and no tab for beta.
  const saved = async (): Promise<string> =>
    JSON.stringify((await invoke<AppSettings>(window, 'settings:read')).paneLayout ?? null)
  await expect
    .poll(async () => {
      const layout = await saved()
      return layout.includes(`"id":${String(alpha)}`) && !layout.includes(`"id":${String(beta)}`) && layout.includes('"axis"')
    })
    .toBe(true)
  const before = await saved()

  const main = await mainPid(helm)
  await closeWindow(helm.app)
  await answer(
    window
      .getByRole('alertdialog', { name: 'Quitting Helm ends 2 sessions on this PC’s host.' })
      .getByRole('button', { name: 'Keep running and quit' })
  )
  await expect.poll(() => processAlive(main)).toBe(false)
  expect(runs.every(processAlive)).toBe(true)

  const next = await launchHelm(world)
  Object.assign(helm, next)
  window = next.window
  const firstAgain = window.getByRole('region', { name: 'First pane' })
  const secondAgain = window.getByRole('region', { name: 'Second pane' })
  await expect(firstAgain.getByRole('tab')).toHaveText(['alpha'])
  await expect(secondAgain.getByRole('tab')).toHaveText(['Session history'])
  expect(await sessionIdOf(window, 'alpha, ready')).toBe(alpha)
  // Nothing opened for beta, so the arrangement stands as it was saved.
  await expect(window.getByRole('tab', { name: /^beta/ })).toHaveCount(0)
  expect(await saved()).toBe(before)

  await window.locator('[data-open-sessions]').click()
  await expect(
    window.getByRole('region', { name: 'Not open here' }).locator(`[data-not-open-here="${String(beta)}"]`)
  ).toContainText('beta')
  expect(runs.every(processAlive)).toBe(true)
})

test('after Helm is killed outright, its sessions run on in the host, and the next start reattaches to that host and shows them, offering no restore', async ({
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
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(3)
  const floti = flotiChildren(await mainPid(helm))
  const hosts = flotiHostsAmong(floti)
  expect(hosts).toHaveLength(1)
  const host = hosts[0]!
  const bridges = floti.filter((pid) => pid !== host)

  process.kill(await mainPid(helm))
  // The bridges end with the Helm whose pipes they were; the host and the
  // session it runs do not.
  await expect.poll(() => bridges.filter(processAlive)).toEqual([])
  expect([host, run.pid].every(processAlive)).toBe(true)

  const next = await launchHelm(world)
  Object.assign(helm, next)
  window = next.window
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  expect(await sessionIdOf(window, 'alpha, ready')).toBe(id)
  await expect.poll(() => terminalText(window, id)).toContain('You said: draft the schema')

  // Reached through the host already running: this Helm started only its bridges.
  await expect.poll(async () => flotiChildren(await mainPid(helm)).length).toBe(2)
  expect(flotiHostsAmong(flotiChildren(await mainPid(helm)))).toEqual([])
  expect([host, run.pid].every(processAlive)).toBe(true)
  // Nothing ended, so there is nothing to offer back and nothing was resumed.
  await expect(window.getByRole('region', { name: /when Helm closed/ })).toHaveCount(0)
  expect(fakeClaudeLogs(world).filter((log) => log.resumed)).toEqual([])
})

test('a session ended in the host is in the history without a refresh, its archive opens, and it resumes in its folder through the host', async ({
  helm,
  world
}) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await typeLine(pane, 'plan the release')
  await expect.poll(() => terminalText(window, id)).toContain('You said: plan the release')
  const first = await claudeRunIn(world, world.projects.alpha)
  await typeLine(pane, '/exit')
  await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Session history' }).click()
  const row = window.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: /^plan the release/ })
  await expect(row).toContainText('alpha')
  await row.click()
  // The host's archive took the conversation in the same pass that listed it.
  await expect(window.getByText('You said: plan the release').first()).toBeVisible()

  // The host indexed and archived it; Helm's own database holds none of it.
  const store = openStore({ file: join(world.dataDir, 'helm.db') })
  try {
    expect(readHistorySessions(store, {}).total).toBe(0)
    expect(readArchiveStats(store, 1024 ** 3).sessions).toBe(0)
  } finally {
    store.close()
  }

  await window.getByRole('button', { name: 'Resume in a tab' }).click()
  await expect(window.getByRole('tab', { name: /^plan the release/ })).toBeVisible()
  let resumed: FakeClaudeLog | undefined
  await expect
    .poll(() => {
      resumed = fakeClaudeLogs(world).find((log) => log.resumed)
      return resumed !== undefined
    })
    .toBe(true)
  const run = resumed as FakeClaudeLog
  expect(run.argv[run.argv.indexOf('--resume') + 1]).toBe(first.sessionId)
  expect(run.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
  const resumedId = await sessionIdOf(window, /^plan the release/)
  await expect.poll(() => terminalText(window, resumedId)).toContain(`Resumed ${first.sessionId}`)
})

/** Claude Code's cached plan-limit figures, one session limit at `percent`, as the CLI writes them. */
function writeUsage(world: World, percent: number): void {
  writeFileSync(
    join(world.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      userID: 'helm-tests',
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent,
              severity: 'normal',
              resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
              is_active: true
            }
          ]
        }
      }
    })
  )
}

const withUsage = test.extend({
  world: async ({ world }, use) => {
    writeUsage(world, 42)
    await use(world)
  }
})

withUsage('the status bar shows the usage figures the host read, and a rewritten reading reaches it', async ({
  helm,
  world
}) => {
  const segment = helm.window.locator('[data-usage-segment]')
  await expect(segment).toContainText('42%')
  writeUsage(world, 77)
  await expect(segment).toContainText('77%')
})
