import type { Locator, Page } from '@playwright/test'
import type { AppSettings, SavedPaneNode } from '@helm/core'
import { expect, startSession, test, typeLine } from './helm'

type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'

/** Drags a tab onto a pane, letting go in one of its zones - well inside it, clear of the strip. */
async function dropOn(tab: Locator, pane: Locator, zone: Zone): Promise<void> {
  const box = await pane.boundingBox()
  if (box === null) throw new Error('the pane is not on screen')
  const { width, height } = box
  const at = {
    left: { x: 12, y: height / 2 },
    right: { x: width - 12, y: height / 2 },
    top: { x: width / 2, y: height * 0.2 },
    bottom: { x: width / 2, y: height - 12 },
    center: { x: width / 2, y: height / 2 }
  }[zone]
  await tab.dragTo(pane, { targetPosition: at })
}

const pane = (window: Page, name: string): Locator => window.getByRole('region', { name })

type Bridge = { helm: { invoke: (channel: string) => Promise<unknown> } }
const savedLayout = async (window: Page): Promise<AppSettings['paneLayout']> =>
  ((await window.evaluate(() => (window as unknown as Bridge).helm.invoke('settings:read'))) as AppSettings).paneLayout

/** The saved arrangement by shape, each group as its tab count: `row(1, column(1, 1))`. */
async function savedShape(window: Page): Promise<string> {
  const layout = await savedLayout(window)
  const shape = (node: SavedPaneNode): string =>
    'axis' in node ? `${node.axis}(${node.children.map(shape).join(', ')})` : String(node.panes.length)
  return layout === null ? 'none' : shape(layout.root)
}

/** The saved root split's first share, or null for no split. */
async function savedFirstShare(window: Page): Promise<number | null> {
  const root = (await savedLayout(window))?.root
  return root !== undefined && 'axis' in root ? (root.sizes[0] ?? null) : null
}

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

test('a tab dragged to a pane’s side opens a pane there, and one dropped in its middle joins it', async ({ helm }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  await startSession(window, 'beta')
  await window.locator('[data-rail="history"]').click()
  const first = pane(window, 'First pane')
  await expect(first.getByRole('tab')).toHaveCount(3)

  // beta to the first pane's right side: a pane of its own, beside it.
  await dropOn(first.getByRole('tab', { name: 'beta, ready' }), first, 'right')
  const second = pane(window, 'Second pane')
  await expect(second.getByRole('tab')).toHaveText(['beta'])
  await expect(second).toHaveAttribute('data-pane-focused', 'true')

  // History to the second pane's foot: the second pane is split in two, one above the other.
  await dropOn(first.getByRole('tab', { name: 'Session history' }), second, 'bottom')
  const third = pane(window, 'Third pane')
  await expect(third.getByRole('tab')).toHaveText(['Session history'])
  const [above, below] = [await second.boundingBox(), await third.boundingBox()]
  expect(below!.x).toBe(above!.x)
  expect(below!.y).toBeGreaterThan(above!.y + above!.height)
  await expect.poll(() => savedShape(window)).toBe('row(1, column(1, 1))')

  // alpha into the middle of the history pane: it joins it, and the pane it
  // left - empty now - goes, giving its room to the column beside it.
  await dropOn(first.getByRole('tab', { name: 'alpha, ready' }), third, 'center')
  await expect(window.getByRole('region', { name: /pane$/ })).toHaveCount(2)
  await expect(pane(window, 'First pane').getByRole('tab')).toHaveText(['beta'])
  await expect(pane(window, 'Second pane').getByRole('tab')).toHaveText(['Session history', 'alpha'])
  await expect.poll(() => savedShape(window)).toBe('column(1, 2)')

  // The drag is over: nothing is left lying over the panes to catch a click,
  // and no tab is still drawn as the one being dragged.
  const moved = pane(window, 'Second pane')
  await moved.locator('.xterm-screen').click()
  await expect(window.locator('[draggable].opacity-40')).toHaveCount(0)
  // The session that moved is still a working terminal.
  await typeLine(moved, '/wait')
  await expect(moved.getByRole('tab', { name: 'alpha, waiting for you' })).toBeVisible()
})

test('a divider is dragged to resize the panes either side, and the arrangement survives a restart', async ({
  helm,
  relaunch
}) => {
  let { window } = helm
  await window.locator('[data-rail="history"]').click()
  await window.locator('[data-rail="settings"]').click()
  await dropOn(window.getByRole('tab', { name: 'Settings' }), pane(window, 'First pane'), 'right')
  await expect(pane(window, 'Second pane').getByRole('tab')).toHaveText(['Settings'])

  const before = (await pane(window, 'First pane').boundingBox())!
  const divider = (await window.locator('[data-sash]').boundingBox())!
  await window.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2)
  await window.mouse.down()
  await window.mouse.move(divider.x + divider.width / 2 + 120, divider.y + divider.height / 2, { steps: 8 })
  await window.mouse.up()
  const after = (await pane(window, 'First pane').boundingBox())!
  expect(Math.round(after.width - before.width)).toBe(120)

  // Written down once the gesture is over, and drawn the same way next time.
  await expect.poll(() => savedFirstShare(window)).toBeGreaterThan(0.55)
  window = (await relaunch()).window
  await expect(pane(window, 'Second pane').getByRole('tab')).toHaveText(['Settings'])
  const restored = (await pane(window, 'First pane').boundingBox())!
  expect(Math.abs(restored.width - after.width)).toBeLessThanOrEqual(1)
})
