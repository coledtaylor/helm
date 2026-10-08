import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Locator, Page } from '@playwright/test'
import type { HelmBridge } from '@coledtaylor/helm-plugin-sdk'
import { bearerOf, callTool, readMcpConfig, rpc, rpcResult, toolNames } from '../test/mcp-client'
import { claudeRunIn, expect, startSession, test as base, type Helm } from './helm'
import { TOKEN, installSample, pluginFrame, registerPlugin, startServer, type SampleFixture } from './plugin-fixture'

/**
 * Plugins, through the real window: the sample plugin (`examples/sample-plugin`)
 * against a sample server on this machine. Its rail panel, its tab, its
 * background page, the secret it asks for, the programs and service it runs,
 * and what Helm holds it to - the hosts it may reach, the shortcuts it may not
 * keep, the process it may crash without taking Helm with it.
 *
 * The detail is in `main/plugins/*.test.ts` and the relay's and bridge's own
 * tests; these are the workflows.
 */

const test = base.extend<{ sample: SampleFixture }>({
  sample: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const server = await startServer()
      await use({ dir: '', server })
      await server.close()
    },
    { scope: 'test' }
  ],
  // Registered before the app starts, as a folder added in an earlier run is.
  world: async ({ world, sample }, use) => {
    sample.dir = installSample(world, sample.server)
    await use(world)
  }
})

/** The page's `window.helm`, in a frame's `evaluate`. */
type PluginWindow = Window & { helm: HelmBridge }
/** Helm's own window and its IPC bridge, as Settings uses it. */
type HelmWindow = Window & { helm: { invoke: (channel: string, payload?: unknown) => Promise<unknown> } }

const statusItem = (ui: Page): Locator => ui.locator('[data-status-plugin="sample"]')
const rail = (ui: Page): Locator => ui.getByRole('navigation', { name: 'Destinations' })

async function openPanel(ui: Page): Promise<Frame> {
  await rail(ui).getByRole('button', { name: /^Sample/ }).click()
  return pluginFrame(ui, 'dist/panels/main.html')
}

/** The token stored the way Settings stores it, for tests that are not about storing it. */
async function storeToken(ui: Page, url: string): Promise<void> {
  await ui.evaluate(
    ({ token, host }) =>
      (window as unknown as HelmWindow).helm.invoke('secrets:save', {
        key: 'sample-token',
        value: token,
        hosts: [host],
        plugins: ['sample']
      }),
    { token: TOKEN, host: url }
  )
}

test('a plugin: its background page, a secret it asks for, its panel, badge, status and a tab of its own', async ({
  helm,
  sample
}) => {
  const ui = helm.window

  // The background page runs with nothing of the plugin's on screen.
  await expect(statusItem(ui)).toHaveText('Sample: no token')

  // Its rail icon is drawn at the rail's size, as Helm's own are: the icon is
  // what is left in the button once the badge, the dot and the 2px edge of a
  // current view are set aside.
  const iconSize = (button: Locator): Promise<number[][]> =>
    button.evaluate((element) =>
      [...element.children]
        .filter((child) => !child.matches('[data-rail-badge], [data-rail-attention]'))
        .map((child) => child.getBoundingClientRect())
        .filter((box) => box.width > 2)
        .map((box) => [box.width, box.height])
    )
  const sampleIcon = await iconSize(rail(ui).getByRole('button', { name: /^Sample/ }))
  expect(sampleIcon).toEqual(await iconSize(ui.locator('[data-rail="sessions"]')))
  expect(sampleIcon).toEqual([[20, 20]])

  const panel = await openPanel(ui)
  await panel.getByRole('button', { name: 'Add token' }).click()
  const dialog = ui.getByRole('dialog', { name: 'Sample needs sample-token' })
  await dialog.getByLabel('Value').fill(TOKEN)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  await expect(panel.locator('[data-sample-item]')).toHaveCount(3)
  await expect(statusItem(ui)).toHaveText('2 unread')
  await expect(ui.locator('[data-rail-badge]')).toHaveText('2')
  await expect(panel.locator('[data-sample-service]')).toContainText('Hello from the service')

  // The value went to the server in place of the placeholder, and nothing
  // else ever arrived in that header.
  const authorizations = sample.server.requests.map((request) => request.authorization)
  expect(authorizations).toContain(`Bearer ${TOKEN}`)
  expect(authorizations.every((value) => value === null || value === `Bearer ${TOKEN}`)).toBe(true)
  expect(sample.server.requests.every((request) => request.cookie === null)).toBe(true)

  // A tab with parameters: the item it is about, under the item's own title.
  await panel.locator('[data-sample-item="2"]').click()
  await expect(ui.getByRole('tab', { name: /Second item/ })).toBeVisible()
  const tab = await pluginFrame(ui, 'dist/tabs/item.html')
  expect(await tab.evaluate(() => (window as unknown as PluginWindow).helm.context.params)).toEqual({ id: '2' })

  // A program from the manifest's `exec`, with the secret in its environment.
  await tab.getByRole('button', { name: 'Run echo' }).click()
  await expect(tab.locator('[data-sample-echo-output]')).toHaveText('{"args":["2"],"token":"set"}')

  // Reading it marked it read; the background page heard and the bar follows.
  await expect(statusItem(ui)).toHaveText('1 unread')
  await expect(ui.locator('[data-rail-badge]')).toHaveText('1')
})

test('helm.fetch reaches only the origins the manifest lists, and every redirect is checked again', async ({
  helm,
  sample
}) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)

  const outcomes = await panel.evaluate(
    async ({ base, port }) => {
      const { helm: bridge } = window as unknown as PluginWindow
      const attempt = async (url: string): Promise<string> => {
        try {
          const response = await bridge.fetch(url, { headers: { authorization: 'Bearer {{sample-token}}' } })
          return `ok ${String(response.status)} ${String(response.redirected)} ${response.url}`
        } catch (error) {
          return `refused ${String((error as { code?: unknown }).code)}`
        }
      }
      return {
        inside: await attempt(`${base}/redirect/inside`),
        outside: await attempt(`${base}/redirect/outside`),
        elsewhere: await attempt(`http://127.0.0.2:${String(port)}/items`),
        web: await attempt('https://example.com/'),
        // The page's own network is closed: helm.fetch is the only way out.
        direct: await fetch(`${base}/items`).then(
          () => 'reached',
          () => 'blocked'
        )
      }
    },
    { base: sample.server.url, port: sample.server.port }
  )

  expect(outcomes).toEqual({
    inside: `ok 200 true ${sample.server.url}/items`,
    outside: 'refused not-declared',
    elsewhere: 'refused not-declared',
    web: 'refused not-declared',
    direct: 'blocked'
  })
  // `not-declared` rather than `network` for 127.0.0.2, where nothing listens:
  // the hop was refused before anything was sent.
})

test("Helm's shortcuts work from inside a plugin page, and its commands run from Ctrl+Shift+P", async ({
  helm,
  sample
}) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)
  await expect(panel.locator('[data-sample-item]')).toHaveCount(3)

  // Focus is in the plugin's process: the key reaches Helm only because the
  // page forwards what it did not handle.
  await panel.locator('[data-sample-item="1"]').focus()
  await ui.keyboard.press('Control+Shift+P')
  const palette = ui.getByRole('dialog', { name: 'Run a command' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('option')).toHaveText([/New item/, /Refresh items/])

  await ui.keyboard.type('new')
  await ui.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  const form = await pluginFrame(ui, 'dist/tabs/item.html')
  await form.getByLabel('Title').fill('From the palette')
  await form.getByRole('button', { name: 'Create' }).click()

  await expect(ui.getByRole('tab', { name: /From the palette/ })).toBeVisible()
  expect(sample.server.items.map((item) => item.title)).toContain('From the palette')
})

/**
 * Runs `script` in Helm's window, or in the frame at `frameUrl`, through the
 * main process. Once a plugin frame's process ends, Playwright counts the whole
 * page as crashed and drives it no further, though Helm's own process is fine.
 */
function inHelm<T>(helm: Helm, script: string, frameUrl?: string): Promise<T> {
  return helm.app.evaluate(
    async ({ BrowserWindow }, { script, frameUrl }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('/plugin-host.html'))
      if (win === undefined) throw new Error('no Helm window')
      if (frameUrl === undefined) return (await win.webContents.executeJavaScript(script)) as T
      const frame = win.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(frameUrl))
      return (frame === undefined ? null : await frame.executeJavaScript(script)) as T
    },
    { script, frameUrl }
  )
}

test('a plugin page that crashes says so in its own place, and Reload brings it back', async ({ helm, sample }) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)
  await expect(panel.locator('[data-sample-item]')).toHaveCount(3)
  const url = panel.url()

  // The page's process ends from outside, the way a renderer that runs out of
  // memory or is ended in Task Manager does.
  const pids = await helm.app.evaluate(({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().endsWith('/plugin-host.html'))
    const frame = win?.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(url))
    if (win === undefined || frame === undefined) throw new Error(`no frame at ${url}`)
    const pids = { helm: win.webContents.getOSProcessId(), plugin: frame.osProcessId }
    process.kill(pids.plugin)
    return pids
  }, url)
  // The plugin had a process of its own to lose.
  expect(pids.plugin).not.toBe(pids.helm)

  await expect
    .poll(() => inHelm<string>(helm, `document.querySelector('[data-plugin-error]')?.textContent ?? ''`))
    .toContain('Sample stopped')

  // Helm itself is untouched: another destination opens.
  await inHelm(helm, `document.querySelector('[aria-label="Session history"]').click()`)
  await expect
    .poll(() => inHelm<boolean>(helm, `[...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.includes('Session history'))`))
    .toBe(true)

  // The panel stays in the sidebar beside the tab, still saying what happened.
  expect(await inHelm<number>(helm, `document.querySelectorAll('[data-plugin-error]').length`)).toBe(1)
  await inHelm(
    helm,
    `[...document.querySelectorAll('[data-plugin-error] button')].find((b) => b.textContent === 'Reload').click()`
  )
  await expect.poll(() => inHelm<number>(helm, `document.querySelectorAll('[data-plugin-error]').length`)).toBe(0)
  await expect
    .poll(() => inHelm<number | null>(helm, `document.querySelectorAll('[data-sample-item]').length`, url))
    .toBe(3)
})

test('Settings > Plugins: an unsupported apiVersion is said plainly, and turning a plugin off takes its surfaces away', async ({
  world,
  sample,
  relaunch
}) => {
  // A folder from a future Helm, registered alongside the sample.
  const future = join(world.root, 'plugins', 'future plugin')
  mkdirSync(future, { recursive: true })
  writeFileSync(
    join(future, 'helm-plugin.json'),
    JSON.stringify({ apiVersion: 2, id: 'future', name: 'Future', panels: {} })
  )
  registerPlugin(world, future)
  const { window: ui } = await relaunch()
  await storeToken(ui, sample.server.url)

  await rail(ui).getByRole('button', { name: 'Settings' }).click()
  await ui.locator('[data-settings-section-link="plugins"]').click()
  await expect(ui.locator('[data-plugin-row="future"] [data-plugin-state="error"]')).toHaveText('Not loaded')
  await ui.locator('[data-plugin-row="future"]').click()
  await expect(ui.locator('[data-plugin-verdict="error"]')).toContainText('apiVersion')

  // The sample, with a tab of its open.
  const panel = await openPanel(ui)
  await panel.locator('[data-sample-item="1"]').click()
  await expect(ui.getByRole('tab', { name: /Welcome/ })).toBeVisible()

  await rail(ui).getByRole('button', { name: 'Settings' }).click()
  await ui.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sample', exact: true }).click()
  await ui.locator('[data-plugin-toggle]').click()
  await expect(ui.locator('[data-plugin-verdict="off"]')).toBeVisible()
  await expect(rail(ui).getByRole('button', { name: /^Sample/ })).toHaveCount(0)
  await expect(statusItem(ui)).toHaveCount(0)
  await expect(ui.getByRole('tab', { name: /Welcome/ })).toHaveCount(0)

  await ui.locator('[data-plugin-toggle]').click()
  await expect(rail(ui).getByRole('button', { name: /^Sample/ })).toBeVisible()
})

test('a theme change reaches plugin pages without reloading them', async ({ helm, sample }) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)

  const read = (): Promise<{ kind: string; bg: string; marked: boolean }> =>
    panel.evaluate(() => ({
      kind: (window as unknown as PluginWindow).helm.theme.kind,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--helm-bg').trim(),
      marked: (window as unknown as { marked?: boolean }).marked === true
    }))
  await panel.evaluate(() => {
    ;(window as unknown as { marked: boolean }).marked = true
  })
  const before = await read()

  const next = before.kind === 'dark' ? 'light' : 'dark'
  await ui.evaluate((theme) => (window as unknown as HelmWindow).helm.invoke('settings:write', { theme }), next)

  await expect.poll(async () => (await read()).kind).toBe(next)
  const after = await read()
  expect(after.bg).not.toBe(before.bg)
  // The same page: what it held in memory is still there.
  expect(after.marked).toBe(true)
})

test("a session calls the plugin's tools, its background page answers, and turning them off in Settings takes them away", async ({
  helm,
  sample,
  world
}) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  await startSession(ui, 'alpha')

  // What the session was told: the plugin's own server, beside Helm's.
  const run = await claudeRunIn(world, world.projects.alpha)
  const config = readMcpConfig(run.argv[run.argv.indexOf('--mcp-config') + 1] ?? '')
  const tools = config.mcpServers['helm-plugin-sample']
  if (tools === undefined) throw new Error(`no plugin server among ${Object.keys(config.mcpServers).join(', ')}`)
  const token = bearerOf(tools)
  expect(await toolNames(tools.url, token)).toEqual(['list_items', 'create_item'])
  const init = await rpcResult<{ instructions: string }>(tools.url, token, 'initialize', {})
  expect(init.instructions).toContain('"Sample", a plugin the user added to Helm')
  expect(init.instructions).toContain('List them before adding one')

  // The background page answers, through the plugin's own network and secret.
  const unread = await callTool(tools.url, token, 'list_items', { unreadOnly: true })
  expect(unread.isError).toBe(false)
  expect(JSON.parse(unread.text)).toEqual([
    { id: '2', title: 'Second item', read: false },
    { id: '1', title: 'Welcome', read: false }
  ])
  const created = await callTool(tools.url, token, 'create_item', { title: 'From a session' })
  expect(created.isError).toBe(false)
  expect(JSON.parse(created.text)).toMatchObject({ title: 'From a session', read: false })
  expect(sample.server.items.map((item) => item.title)).toContain('From a session')
  expect(await callTool(tools.url, token, 'create_item', {})).toMatchObject({ isError: true, text: 'create_item needs a title.' })

  // The plugin's own surfaces show what the session did.
  await expect(statusItem(ui)).toHaveText('3 unread')
  const panel = await openPanel(ui)
  await expect(panel.getByText('From a session')).toBeVisible()

  // Turned off in Settings: gone from the running session at once.
  await rail(ui).getByRole('button', { name: 'Settings' }).click()
  await ui.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Sample', exact: true }).click()
  const group = ui.locator('[data-settings-group="plugin-tools"]')
  await expect(group.locator('[data-plugin-tools] li')).toHaveCount(2)
  await group.getByRole('checkbox', { name: 'Offer to sessions' }).click()
  await expect(group.locator('[data-plugin-tools-state]')).toHaveText('No session gets them.')
  expect((await rpc(tools.url, token, 'tools/list')).status).toBe(404)
  // Helm's own tools are another family, and stay.
  const browser = config.mcpServers['helm-browser']
  if (browser === undefined) throw new Error('no browser server')
  expect((await rpc(browser.url, token, 'tools/list')).status).toBe(200)
})

/** The sample as a plugin that declares `pageStrip`: its tabs open as pages in one tab of its own. */
const stripTest = test.extend({
  world: async ({ world, sample }, use) => {
    const file = join(sample.dir, 'helm-plugin.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...manifest, pageStrip: true }, null, 2))
    await use(world)
  }
})

stripTest('a plugin with a page strip opens its tabs as pages in one tab, which Ctrl+W closes page by page', async ({
  helm,
  sample,
  relaunch
}) => {
  let ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)
  await expect(panel.locator('[data-sample-item]')).toHaveCount(3)
  const pages = (page: Page): Locator => page.getByRole('tablist', { name: 'Sample pages' })

  // The first page opens the plugin's one tab, named for the plugin.
  await panel.locator('[data-sample-item="2"]').click()
  await expect(pages(ui).getByRole('tab')).toHaveText(['Second item'])
  await expect(ui.getByRole('tab', { name: /^Sample$/ })).toHaveAttribute('aria-selected', 'true')
  const second = await pluginFrame(ui, 'dist/tabs/item.html')
  // Loaded, named and marked read by the page itself, so the name below is the last word.
  await expect(statusItem(ui)).toHaveText('1 unread')
  await second.evaluate(() => {
    ;(window as unknown as { marker: string }).marker = 'kept'
    ;(window as unknown as PluginWindow).helm.surface.setTitle('Second, renamed')
  })
  // setTitle names the page in the strip, not the plugin's tab.
  await expect(pages(ui).getByRole('tab')).toHaveText(['Second, renamed'])
  await expect(ui.getByRole('tab', { name: /^Sample$/ })).toBeVisible()

  // A second page joins the strip rather than the pane's tabs.
  await panel.locator('[data-sample-item="1"]').click()
  await expect(pages(ui).getByRole('tab')).toHaveText(['Second, renamed', 'Welcome'])
  await expect(ui.getByRole('tab', { name: /Welcome/ })).toHaveCount(1)
  await expect(pages(ui).getByRole('tab', { name: /Welcome/ })).toHaveAttribute('aria-selected', 'true')

  // The same item again brings its page forward, with the title asked for, and
  // the page behind kept running all along.
  await panel.locator('[data-sample-item="2"]').click()
  await expect(pages(ui).getByRole('tab')).toHaveText(['Second item', 'Welcome'])
  await expect(pages(ui).getByRole('tab', { name: /Second item/ })).toHaveAttribute('aria-selected', 'true')
  expect(await second.evaluate(() => (window as unknown as { marker?: string }).marker)).toBe('kept')

  // Reordered as the Browser tab's pages are.
  await pages(ui).getByRole('tab', { name: /Second item/ }).press('Control+Shift+ArrowRight')
  await expect(pages(ui).getByRole('tab')).toHaveText(['Welcome', 'Second item'])

  // Written down with the panes, and back after a restart.
  const saved = (): Promise<string> =>
    ui.evaluate(async () => {
      const settings = (await (window as unknown as HelmWindow).helm.invoke('settings:read')) as { paneLayout: unknown }
      return JSON.stringify(settings.paneLayout)
    })
  await expect.poll(saved).toMatch(/"kind":"plugin-pages".*"params":\{"id":"1"\}.*"params":\{"id":"2"\}/)
  ui = (await relaunch()).window
  await expect(pages(ui).getByRole('tab')).toHaveText(['Welcome', 'Second item'])
  await expect(pages(ui).getByRole('tab', { name: /Second item/ })).toHaveAttribute('aria-selected', 'true')

  // Ctrl+W closes the page in front, and the last page takes the tab with it.
  await pages(ui).getByRole('tab', { name: /Second item/ }).click()
  await ui.keyboard.press('Control+w')
  await expect(pages(ui).getByRole('tab')).toHaveText(['Welcome'])
  await ui.keyboard.press('Control+w')
  await expect(pages(ui)).toHaveCount(0)
  await expect(ui.getByRole('tab', { name: /^Sample$/ })).toHaveCount(0)
})

test('a plugin page starts a session from a click, once the user has seen what it will run', async ({ helm, sample, world }) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)
  await panel.locator('[data-sample-item="2"]').click()
  const item = await pluginFrame(ui, 'dist/tabs/item.html')
  await expect(item.locator('h1')).toHaveText('Second item')

  // Asked for without a click, it is refused before Helm draws anything.
  // Long enough after any click that the page's activation has lapsed.
  const unasked = await item.evaluate(
    (cwd) =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          ;(window as unknown as PluginWindow).helm.sessions
            .start({ cwd, prompt: 'hello' })
            .then(resolve, (error: { code: string }) => resolve(error.code))
        }, 6000)
      }),
    world.projects.alpha
  )
  expect(unasked).toBe('not-allowed')

  const dialog = ui.getByRole('alertdialog', { name: 'Sample wants to start a session' })
  const field = (name: string): Locator => dialog.locator(`[data-plugin-session-field="${name}"] dd`)
  await item.locator('[data-sample-session-folder]').fill(world.projects.alpha)
  await item.locator('[data-sample-session-start]').click()

  // Everything that will run is on screen, and Cancel has the focus.
  await expect(field('folder')).toHaveText(world.projects.alpha)
  await expect(field('name')).toHaveText('Second item')
  await expect(field('prompt')).toHaveText('work on Second item')
  await expect(field('command')).toHaveText('claude -n "Second item" "work on Second item"')
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(item.locator('[data-sample-session-result]')).toHaveText('Cancelled.')
  await expect(ui.getByRole('tab', { name: /^Second item, / })).toHaveCount(0)

  // Started, it is a session like any other, with the message as its first.
  await item.locator('[data-sample-session-start]').click()
  await dialog.getByRole('button', { name: 'Start session' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(ui.getByRole('tab', { name: 'Second item, ready' })).toHaveAttribute('aria-selected', 'true')
  await expect(item.locator('[data-sample-session-result]')).toHaveText('Started.')
  const run = await claudeRunIn(world, world.projects.alpha)
  expect(run.argv[run.argv.indexOf('-n') + 1]).toBe('Second item')
  expect(run.argv.at(-1)).toBe('work on Second item')
})
