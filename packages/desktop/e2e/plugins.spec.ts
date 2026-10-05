import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Frame, Locator, Page } from '@playwright/test'
import type { HelmBridge } from '@helm/plugin-sdk'
import { expect, test as base } from './helm'
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

test('a plugin page that crashes says so in its own place, and Reload brings it back', async ({ helm, sample }) => {
  const ui = helm.window
  await storeToken(ui, sample.server.url)
  const panel = await openPanel(ui)
  await expect(panel.locator('[data-sample-item]')).toHaveCount(3)

  const cdp = await ui.context().newCDPSession(panel)
  // Never answered: the process it would answer from is the one that ends.
  void cdp.send('Page.crash').catch(() => undefined)

  const failed = ui.locator('[data-plugin-error]')
  await expect(failed).toContainText('Sample stopped')
  // Helm itself is untouched.
  await rail(ui).getByRole('button', { name: 'Session history' }).click()
  await expect(ui.getByRole('tab', { name: 'Session history' })).toBeVisible()

  await rail(ui).getByRole('button', { name: /^Sample/ }).click()
  await failed.getByRole('button', { name: 'Reload' }).click()
  await expect(failed).toHaveCount(0)
  const again = await pluginFrame(ui, 'dist/panels/main.html')
  await expect(again.locator('[data-sample-item]')).toHaveCount(3)
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
