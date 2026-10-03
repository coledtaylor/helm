import { join } from 'node:path'
import { removeShims } from '../test/overlay-world'
import { fakeClaudeLogs, seedProfile } from '../test/world'
import { claudeRunIn, expect, startSession, test as base } from './helm'

/**
 * A pane's `+`: what kind of tab first, then that tab, in that pane. The world
 * gets a profile rooted at beta before the app starts, so there is one to
 * start from the strip.
 */
const test = base.extend({
  world: async ({ world }, use) => {
    seedProfile(world, {
      name: 'betakit',
      root: world.projects.beta,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null
    })
    await use(world)
    removeShims(join(world.dataDir, 'overlays'))
  }
})

test('a pane’s + opens a session, a profile session or a browser tab in that pane, focused or not', async ({
  helm,
  world
}) => {
  const { window } = helm
  const first = window.getByRole('region', { name: 'First pane' })
  const second = window.getByRole('region', { name: 'Second pane' })

  // Two panes - alpha's session beside Settings - with the first one focused.
  await startSession(window, 'alpha')
  await window.locator('[data-rail="settings"]').click()
  await window.getByRole('button', { name: /^Split: move this tab to a pane of its own/ }).click()
  await expect(second.getByRole('tab')).toHaveText(['Settings'])
  await first.getByRole('tab', { name: 'alpha, ready' }).click()
  await expect(first).toHaveAttribute('data-pane-focused', 'true')

  // From the keyboard, so nothing is pressed inside the second pane: what lands
  // there lands because its + asked, not because the pane took the focus.
  await second.getByRole('button', { name: 'New tab' }).focus()
  await window.keyboard.press('Enter')
  await expect(window.getByRole('menu', { name: 'New tab' })).toBeFocused()
  await window.keyboard.press('Enter')
  const popover = window.getByRole('dialog', { name: 'New session' })
  await expect(popover.getByRole('combobox', { name: 'Folder' })).toBeFocused()
  await popover.getByRole('combobox', { name: 'Folder' }).selectOption({ label: 'beta' })
  // The profile follows the folder until one is chosen.
  await expect(popover.locator('[data-launch-sentence]')).toContainText('with the betakit profile')
  await popover.getByRole('combobox', { name: 'Profile' }).selectOption({ label: 'No profile' })
  await expect(popover.locator('[data-launch-sentence]')).not.toContainText('profile')
  await popover.getByRole('button', { name: 'Start session' }).click()

  await expect(popover).toBeHidden()
  await expect(second.getByRole('tab', { name: 'beta, ready' })).toBeVisible()
  await expect(first.getByRole('tab', { name: /^beta/ })).toHaveCount(0)
  await claudeRunIn(world, world.projects.beta)

  // A profile, one click, in the first pane: it runs in its own folder.
  await first.getByRole('button', { name: 'New tab' }).click()
  await window.getByRole('menu', { name: 'New tab' }).getByRole('menuitem', { name: 'Profile session' }).click()
  await window.getByRole('menu', { name: 'Start a profile' }).getByRole('menuitem', { name: /^betakit/ }).click()
  await expect(first.getByRole('tab', { name: 'betakit, ready' })).toBeVisible()
  await expect
    .poll(() => fakeClaudeLogs(world).filter((log) => log.cwd.toLowerCase() === world.projects.beta.toLowerCase()).length)
    .toBe(2)

  // A browser tab is an empty page with the caret in its address bar.
  await second.getByRole('button', { name: 'New tab' }).click()
  await window.getByRole('menu', { name: 'New tab' }).getByRole('menuitem', { name: 'Browser tab' }).click()
  await expect(second.getByRole('tab', { name: 'New tab' })).toHaveAttribute('aria-selected', 'true')
  await expect(second.getByRole('textbox', { name: 'Address' })).toBeFocused()
  await expect(first.getByRole('tab', { name: 'New tab' })).toHaveCount(0)
})
