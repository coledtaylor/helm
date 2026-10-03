import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test as base } from './helm'

/**
 * Editing a project's CLAUDE.md in the config console and taking it back.
 *
 * The original has CRLF endings, a non-ASCII character and trailing spaces,
 * so "the original bytes exactly" is a claim a lossy round trip would fail.
 */
const ORIGINAL = '# Alpha\r\n\r\nThe original instructions, café included.  \r\n'
const EDITED = '# Alpha\n\nRewritten from the config console.\n'

const test = base.extend({
  world: async ({ world }, use) => {
    writeFileSync(join(world.projects.alpha, 'CLAUDE.md'), ORIGINAL)
    await use(world)
  }
})

async function chooseScope(window: Page, name: string): Promise<void> {
  const scope = window.getByRole('combobox', { name: 'Scope' })
  const value = await scope.locator('option', { hasText: new RegExp(`^${name}\\b`) }).getAttribute('value')
  expect(value).not.toBeNull()
  // Only when it is not already the scope on screen: a person cannot pick the
  // option that is already selected, and Playwright would send a change anyway.
  await expect(scope).not.toHaveValue('')
  if ((await scope.inputValue()) !== value) await scope.selectOption(value!)
  await expect(scope).toHaveValue(value!)
}

test('a CLAUDE.md edited and saved in the config console, then restored to its original bytes', async ({
  world,
  helm
}) => {
  const { window } = helm
  const file = join(world.projects.alpha, 'CLAUDE.md')

  await window.getByRole('button', { name: 'Config', exact: true }).click()
  await chooseScope(window, 'alpha')
  await window.getByRole('group', { name: 'Configuration files' }).getByRole('button', { name: /CLAUDE\.md/ }).click()

  await window.getByRole('group', { name: 'Mode' }).getByRole('button', { name: 'Edit', exact: true }).click()
  await window.getByRole('textbox', { name: 'Edit CLAUDE.md' }).fill(EDITED)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(EDITED)

  await window.getByRole('button', { name: '1 version', exact: true }).click()
  await window.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(ORIGINAL)
  await expect(window.getByRole('button', { name: '2 versions', exact: true })).toBeVisible()
})
