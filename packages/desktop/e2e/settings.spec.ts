import { expect, test } from './helm'

test('a setting changed in the settings pane survives a restart', async ({ helm, relaunch }) => {
  await helm.window.getByRole('button', { name: 'Settings' }).click()
  const compact = helm.window.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' })
  await compact.click()
  await expect(compact).toBeChecked()

  const { window } = await relaunch()
  await window.getByRole('button', { name: 'Settings' }).click()
  await expect(window.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' })).toBeChecked()
})
