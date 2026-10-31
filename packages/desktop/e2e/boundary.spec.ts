import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isClientOnly, isHostInternal } from '../../../crates/floti-protocol/generated/floti-protocol.generated'
import type { RecordedChannel } from '../src/main/ipc-recorder'
import { bearerOf, callTool, readMcpConfig } from '../test/mcp-client'
import { startBrowserFixture } from './browser-fixture'
import { TOKEN, installSample, pluginFrame, startServer, type SampleFixture } from './plugin-fixture'
import { claudeRunIn, expect, startSession, terminalText, test as base, typeLine, type Helm } from './helm'

/** Runs `script` in the sample's background page, in Helm's hidden plugin host window. */
function inBackground<T>(helm: Helm, script: string): Promise<T> {
  return helm.app.evaluate(
    async ({ BrowserWindow }, { script, url }) => {
      const host = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/plugin-host.html'))
      const frame = host?.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(url))
      if (frame === undefined) throw new Error('no background page')
      return (await frame.executeJavaScript(script)) as T
    },
    { script, url: 'helm-plugin://sample/dist/background/index.html' }
  )
}

/**
 * With "Run sessions in the local host" on, Electron IPC carries only what
 * `boundary.rs` lists as client-only: the browser pane, clipboard, window,
 * theme, dialogs and each Helm page's own connection to the host. Everything
 * else reaches the host over that connection, in the protocol's types.
 *
 * Main records every channel used and which page used it (`ipc-recorder.ts`);
 * after each workflow the test fails naming any channel the generated
 * client-only list does not cover. A host-internal channel passes only on the
 * hidden window plugins' background pages run in, where API v1 runs them
 * inside the desktop. Main registers nothing else with the setting on, so a
 * channel it does not list could only show up here as one main answered.
 */

const test = base.extend<{ sample: SampleFixture }>({
  sessionsInHost: true,
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
    const notes = join(world.projects.alpha, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'first.md'), '# First note\n\nWritten for the boundary.\n')
    writeFileSync(join(world.projects.alpha, 'CLAUDE.md'), '# Alpha\n')
    await use(world)
  }
})

/** Every channel main recorded so far, and which page used it. */
const recorded = (helm: Helm): Promise<RecordedChannel[]> =>
  helm.app.evaluate(() => (globalThis as unknown as { __helmIpcChannels: () => RecordedChannel[] }).__helmIpcChannels())

/** What crossed Electron IPC that `boundary.rs` does not keep on the client, named. */
function strays(channels: readonly RecordedChannel[]): string[] {
  return channels
    .filter(
      ({ channel, page }) =>
        !isClientOnly(channel) && !(isHostInternal(channel) && page === 'background')
    )
    .map(({ channel, kind, page }) => `${channel} (${kind}, ${page})`)
    .sort()
}

/** Fails naming every stray channel, and any page but Helm's own that used a page's connection. */
async function expectOnlyClientChannels(helm: Helm): Promise<void> {
  const channels = await recorded(helm)
  expect(channels.length).toBeGreaterThan(0)
  expect(strays(channels)).toEqual([])
  const foreign = channels.filter(({ channel, page }) => channel.startsWith('hostLink:') && page === 'other')
  expect(foreign).toEqual([])
}

const destination = (helm: Helm, name: string | RegExp) =>
  helm.window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name, exact: typeof name === 'string' })

test('the launcher, a session and its terminal, and a project’s terminal use only client channels', async ({
  helm,
  world
}) => {
  const { window } = helm
  const pane = window.getByRole('region', { name: 'First pane' })
  await window.getByRole('button', { name: 'alpha main' }).click()
  await expect(pane.getByRole('textbox', { name: 'Terminal input' })).toBeAttached()
  const id = await startSession(window, 'alpha')
  await typeLine(pane, 'hello boundary')
  await expect.poll(() => terminalText(window, id)).toContain('You said: hello boundary')
  await claudeRunIn(world, world.projects.alpha)
  await expectOnlyClientChannels(helm)
})

test('history and the usage figures come over the window’s own connection', async ({ helm }) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await typeLine(pane, 'plan the boundary')
  await expect.poll(() => terminalText(window, id)).toContain('You said: plan the boundary')
  await typeLine(pane, '/exit')
  await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()

  await destination(helm, 'Session history').click()
  const row = window.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: /^plan the boundary/ })
  await row.click()
  await expect(window.getByText('You said: plan the boundary').first()).toBeVisible()

  const channels = await recorded(helm)
  // Read over the window's connection: main was asked none of it.
  expect(channels.filter(({ channel }) => /^(history:(summary|sessions|changed)|archive:|usage:)/.test(channel))).toEqual([])
  expect(channels).toContainEqual({ channel: 'hostLink:open', kind: 'invoke', page: 'window' })
  await expectOnlyClientChannels(helm)
})

test('the config console, the Files view and a note use only client channels', async ({ helm }) => {
  const { window } = helm
  await window.getByRole('button', { name: 'Config', exact: true }).click()
  await window.getByRole('group', { name: 'Configuration files' }).first().waitFor()

  await window.locator('[data-rail="files"]').click()
  const picker = window.getByRole('button', { name: 'Project', exact: true })
  if ((await picker.textContent()) !== 'alpha') {
    await picker.click()
    await window.getByRole('listbox', { name: 'Projects' }).getByRole('option', { name: 'alpha', exact: true }).click()
  }
  const files = window.getByRole('group', { name: 'Project files' })
  await files.getByRole('button', { name: /^notes\b/ }).click()
  await files.getByRole('button', { name: /^first\.md/ }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'First note' })).toBeVisible()
  await expectOnlyClientChannels(helm)
})

test('profiles use only client channels', async ({ helm }) => {
  const { window } = helm
  await destination(helm, 'Profiles').click()
  await window.getByRole('button', { name: 'New profile' }).click()
  const dialog = window.getByRole('dialog', { name: 'New profile' })
  await dialog.getByRole('textbox', { name: 'Profile name' }).fill('boundary')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expectOnlyClientChannels(helm)
})

test('a plugin page, its tool called by a session, and the Browser tab use only client channels', async ({
  helm,
  sample,
  world
}) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await window.evaluate(
    ({ token, host }) =>
      (
        window as unknown as { __helmRouted: { invoke: (channel: string, payload: unknown) => Promise<unknown> } }
      ).__helmRouted.invoke('secrets:save', { key: 'sample-token', value: token, hosts: [host], plugins: ['sample'] }),
    { token: TOKEN, host: sample.server.url }
  )
  await destination(helm, /^Sample/).click()
  const panel = await pluginFrame(window, 'dist/panels/main.html')
  await panel.locator('[data-sample-item="2"]').click()
  const item = await pluginFrame(window, 'dist/tabs/item.html')
  await expect(item.locator('h1')).toHaveText('Second item')

  // A panel's post on a BroadcastChannel reaches the background page, through
  // the host and the hidden window's own connection.
  const sent = { from: 'the panel' }
  await expect
    .poll(() =>
      inBackground(
        helm,
        `(() => { window.__heard = []; new BroadcastChannel('boundary').onmessage = (event) => window.__heard.push(event.data); return true })()`
      ).catch(() => false)
    )
    .toBe(true)
  await panel.evaluate(`(() => { new BroadcastChannel('boundary').postMessage(${JSON.stringify(sent)}); return true })()`)
  await expect.poll(() => inBackground(helm, 'window.__heard')).toEqual([sent])

  const run = await claudeRunIn(world, world.projects.alpha)
  const config = readMcpConfig(run.argv[run.argv.indexOf('--mcp-config') + 1] ?? '')
  const plugin = config.mcpServers['helm-plugin-sample']
  if (plugin === undefined) throw new Error(`no helm-plugin-sample in ${JSON.stringify(config)}`)
  // The background page answers the session's call.
  const answered = await callTool(plugin.url, bearerOf(plugin), 'list_items', { unreadOnly: true })
  expect(answered.isError).toBe(false)

  const fixture = await startBrowserFixture()
  try {
    await destination(helm, 'Browser').click()
    const address = window.getByRole('textbox', { name: 'Address' })
    await address.fill(`${fixture.http}/`)
    await address.press('Enter')
    await expect(window.getByRole('tab', { name: /^Helm fixture one/ })).toBeVisible()
  } finally {
    await fixture.close()
  }
  await expectOnlyClientChannels(helm)
})
