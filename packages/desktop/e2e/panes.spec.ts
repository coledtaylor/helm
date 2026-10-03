import { expect, startSession, test, typeLine } from './helm'

test('two sessions side by side, and the one waiting on an answer is marked', async ({ helm }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')

  await window.getByRole('button', { name: /^Split: move this tab to a pane of its own/ }).click()
  const first = window.getByRole('region', { name: 'First pane' })
  const second = window.getByRole('region', { name: 'Second pane' })
  await expect(first.getByRole('tab')).toHaveText(['alpha'])
  await expect(second.getByRole('tab')).toHaveText(['beta'])

  await typeLine(second, '/wait')
  await expect(second.getByRole('tab', { name: 'beta, waiting for you' })).toBeVisible()
  await expect(window.getByRole('contentinfo').getByRole('button', { name: '1 needs you' })).toBeVisible()
  await expect(second).toHaveAttribute('data-pane-attention', 'true')
  await expect(first).not.toHaveAttribute('data-pane-attention')

  await second.getByRole('textbox', { name: 'Terminal input' }).press('y')
  await expect(second.getByRole('tab', { name: 'beta, ready' })).toBeVisible()
  await expect(second).not.toHaveAttribute('data-pane-attention')
  await expect(window.getByRole('contentinfo')).toContainText('2 idle')
})
