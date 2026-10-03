import type { Page } from '@playwright/test'
import { expect, startSession, test } from './helm'

/** A section of Settings, picked in the sidebar the way a person picks it. */
const section = (window: Page, name: string) =>
  window.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name, exact: true })

test('a setting changed in the settings pane survives a restart', async ({ helm, relaunch }) => {
  await helm.window.getByRole('button', { name: 'Settings' }).click()
  await section(helm.window, 'Appearance').click()
  const compact = helm.window.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' })
  await compact.click()
  await expect(compact).toBeChecked()

  const { window } = await relaunch()
  await window.getByRole('button', { name: 'Settings' }).click()
  await section(window, 'Appearance').click()
  await expect(window.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' })).toBeChecked()
})

test('the gear opens Settings as a tab with its sections beside it, and Ctrl+Tab walks every tab once from inside a terminal', async ({ helm }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')

  await expect(window.getByRole('tab', { name: 'Settings' })).toHaveCount(0)
  await window.getByRole('button', { name: 'Settings' }).click()
  await expect(window.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true')
  // The sections in the sidebar, the first of them in the pane.
  await expect(section(window, 'General')).toHaveAttribute('aria-current', 'page')
  await expect(window.getByRole('heading', { level: 1, name: 'General' })).toBeVisible()
  await section(window, 'Terminal').click()
  await expect(window.getByRole('heading', { level: 1, name: 'Terminal' })).toBeVisible()
  const strip = ['alpha, ready', 'beta, ready', 'Settings']
  await expect(window.getByRole('tab')).toHaveCount(strip.length)
  for (const [at, name] of strip.entries()) {
    await expect(window.getByRole('tab').nth(at)).toHaveAccessibleName(name)
  }

  // Bound in capture on the window, so a terminal with the focus does not eat it.
  await window.getByRole('tab', { name: 'alpha, ready' }).click()
  await window.getByRole('region', { name: 'First pane' }).getByRole('textbox', { name: 'Terminal input' }).focus()
  for (const next of ['beta, ready', 'Settings', 'alpha, ready']) {
    await window.keyboard.press('Control+Tab')
    await expect(window.getByRole('tab', { selected: true })).toHaveAccessibleName(next)
  }
})
