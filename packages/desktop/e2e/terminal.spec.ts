import type { Page } from '@playwright/test'
import { expect, test, typeLine } from './helm'

/**
 * A terminal tab: a plain shell in a folder, with no `claude` in it, opened
 * from Ctrl+N or a pane's `+`. Each is a shell of its own and ends with its tab.
 */

/** What the window's terminal inspector says of a shell; see `describeShellTerminals`. */
interface ShellReport {
  path: string
  lines: string[]
}

async function shells(window: Page): Promise<ShellReport[]> {
  return window.evaluate(
    () => (window as unknown as { __helmTerminals: () => { shells: ShellReport[] } }).__helmTerminals().shells
  )
}

const tabShells = async (window: Page): Promise<ShellReport[]> =>
  (await shells(window)).filter((shell) => shell.path.startsWith('terminal:'))

test('a terminal tab runs a plain shell in the chosen folder, one per tab, ending with its tab', async ({
  helm,
  world
}) => {
  const { window } = helm
  const pane = window.getByRole('region', { name: 'First pane' })

  // From the launcher: Alt+Enter on a folder opens a terminal there, not a session.
  await expect(window.getByRole('button', { name: 'Start a session in alpha' })).toBeAttached()
  await window.keyboard.press('Control+N')
  const launcher = window.getByRole('dialog', { name: 'New session' })
  await expect(launcher.getByRole('combobox', { name: 'Folder' })).toBeFocused()
  await window.keyboard.type('alp')
  await expect(
    launcher.getByRole('listbox', { name: 'Folders' }).getByRole('option', { name: 'alpha' })
  ).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Alt+Enter')
  await expect(launcher).toBeHidden()
  const first = pane.getByRole('tab', { name: 'alpha' })
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(first).toHaveAttribute('data-tab', /^terminal:\d+$/)

  await typeLine(pane, 'node -e "console.log(\'cwd=\' + process.cwd())"')
  await expect
    .poll(async () => (await tabShells(window)).flatMap((shell) => shell.lines).join('\n'))
    .toContain(`cwd=${world.projects.alpha}`)
  // Nothing about it is a session.
  await expect(window.locator('[data-status-sessions="none"]')).toBeVisible()

  // From the pane's +: the same folder again is a second shell, not the first.
  await pane.getByRole('button', { name: 'New tab' }).click()
  await window.getByRole('menu', { name: 'New tab' }).getByRole('menuitem', { name: 'Terminal' }).click()
  await window.getByRole('menu', { name: 'Open a terminal in' }).getByRole('menuitem', { name: 'alpha' }).click()
  await expect(pane.getByRole('tab', { name: 'alpha' })).toHaveCount(2)
  await expect.poll(async () => (await tabShells(window)).length).toBe(2)

  // Closing one ends its shell and leaves the other.
  await first.first().hover()
  await pane.getByRole('button', { name: 'Close alpha' }).first().click()
  await expect(pane.getByRole('tab', { name: 'alpha' })).toHaveCount(1)
  await expect.poll(async () => (await tabShells(window)).length).toBe(1)
})
