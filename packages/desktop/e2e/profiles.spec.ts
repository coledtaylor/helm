import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { harnessIn, plantHarness, removeShims } from '../test/overlay-world'
import { claudeRunIn, expect, sessionIdOf, terminalText, test as base } from './helm'

/**
 * The world gets a harness before the app starts, so the first scan finds it:
 * `hub`, whose `repos/tools` has a skill to compose. The shims a launch builds
 * hold junctions into it, so they are unlinked before the world is removed.
 */
const test = base.extend({
  world: async ({ world }, use) => {
    plantHarness(world)
    await use(world)
    removeShims(join(world.dataDir, 'overlays'))
  }
})

test('a profile made in the New profile dialog starts its composition when it is saved', async ({ helm, world }) => {
  const { window } = helm
  const hub = harnessIn(world)
  const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

  // The first scan has found the harness and its repository.
  await expect(window.getByRole('button', { name: 'hub, 2 projects' })).toBeVisible()

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Profiles' }).click()
  await window.getByRole('button', { name: 'New profile' }).click()
  const dialog = window.getByRole('dialog', { name: 'New profile' })
  await dialog.getByRole('textbox', { name: 'Profile name' }).fill('hub dev')
  await dialog.getByRole('textbox', { name: 'Root directory' }).fill(hub.root)
  await dialog.getByRole('checkbox', { name: 'Compose tools' }).check()
  await expect(dialog.getByRole('checkbox', { name: 'Grant access to tools' })).toBeChecked()
  await dialog.getByRole('combobox', { name: 'Model' }).selectOption('sonnet')
  await dialog.getByRole('button', { name: 'Save and start' }).click()
  await expect(dialog).toBeHidden()
  await expect(window.getByRole('list', { name: 'Saved profiles' }).getByRole('button', { name: /^hub dev/ })).toBeVisible()

  await expect(window.getByRole('tab', { name: 'hub dev, ready' })).toBeVisible()
  await expect(window.getByRole('tab', { name: /^hub dev/ })).toHaveCount(1)
  const id = await sessionIdOf(window, 'hub dev, ready')
  await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')

  // What the fake claude was started with: at the root, the overlay as a plugin
  // directory the app built under its own data directory, and the form's flags.
  const run = await claudeRunIn(world, hub.root)
  const pluginDir = after(run.argv, '--plugin-dir') ?? ''
  expect(pluginDir.toLowerCase().startsWith(join(world.dataDir, 'overlays').toLowerCase())).toBe(true)
  expect(existsSync(join(pluginDir, 'skills', hub.skill, 'SKILL.md'))).toBe(true)
  expect(after(run.argv, '--add-dir')).toBe(hub.overlay)
  expect(after(run.argv, '--model')).toBe('sonnet')
  expect(after(run.argv, '-n')).toBe('hub dev')
})
