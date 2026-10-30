import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { seedSettings, type World } from '../test/world'
import { expect, test as base } from './helm'

/**
 * Editing a project's CLAUDE.md in the config console and taking it back.
 *
 * The original has CRLF endings, a non-ASCII character and trailing spaces,
 * so "the original bytes exactly" is a claim a lossy round trip would fail.
 */
const ORIGINAL = '# Alpha\r\n\r\nThe original instructions, café included.  \r\n'
const EDITED = '# Alpha\n\nRewritten from the config console.\n'
const CREDENTIALS_MARKER = 'MARKER-credential-e2e'
const CREDENTIALS = `{"claudeAiOauth":{"accessToken":"${CREDENTIALS_MARKER}"}}`

const test = base.extend({
  world: async ({ world }, use) => {
    writeFileSync(join(world.projects.alpha, 'CLAUDE.md'), ORIGINAL)
    await use(world)
  }
})

/** The same world with "Run sessions in the local host" on: the console reads and writes through the host. */
const inHost = test.extend({
  world: async ({ world }, use) => {
    seedSettings(world, { sessionsInHost: true })
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

/**
 * The user's `.credentials.json`, selected: the console names it, says Helm
 * never opens it, and offers no mode to read or edit it in.
 */
async function selectCredentials(window: Page, world: World): Promise<void> {
  const file = join(world.claudeDir, '.credentials.json')
  writeFileSync(file, CREDENTIALS)

  await window.getByRole('button', { name: 'Config', exact: true }).click()
  await chooseScope(window, 'User')
  await window.getByRole('group', { name: 'Configuration files' }).getByRole('button', { name: /\.credentials\.json/ }).click()

  await expect(window.getByText('Helm never opens this file.', { exact: false })).toBeVisible()
  await expect(window.getByRole('group', { name: 'Mode' })).toHaveCount(0)
  await expect(window.getByText(CREDENTIALS_MARKER, { exact: false })).toHaveCount(0)
  expect(readFileSync(file, 'utf8')).toBe(CREDENTIALS)
}

async function editSaveAndRestore(window: Page, world: World): Promise<void> {
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
}

test('a CLAUDE.md edited and saved in the config console, then restored to its original bytes', async ({
  world,
  helm
}) => {
  await editSaveAndRestore(helm.window, world)
})

inHost('a CLAUDE.md edited and saved in the config console through the local host, then restored to its original bytes', async ({
  world,
  helm
}) => {
  await editSaveAndRestore(helm.window, world)
})

test('the user’s .credentials.json, selected in the config console, says what it is and shows none of it', async ({
  world,
  helm
}) => {
  await selectCredentials(helm.window, world)
})

inHost('the user’s .credentials.json, selected in the config console through the local host, says what it is and shows none of it', async ({
  world,
  helm
}) => {
  await selectCredentials(helm.window, world)
})
