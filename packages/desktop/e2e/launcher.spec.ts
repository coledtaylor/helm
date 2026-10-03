import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeShims } from '../test/overlay-world'
import { fakeClaudeLogs, seedProfile, type FakeClaudeLog } from '../test/world'
import { claudeRunIn, expect, sessionIdOf, startSession, terminalText, test as base, typeLine } from './helm'

/**
 * The new-session launcher. The world gets a profile before the app starts,
 * made in a folder of skills outside the scanned one, so it is a profile that
 * can only ever be taken somewhere it was not made - and the scan still finds
 * just the world's two projects.
 */
const test = base.extend({
  world: async ({ world }, use) => {
    const kit = join(world.root, 'kit')
    mkdirSync(join(kit, '.claude', 'skills', 'think'), { recursive: true })
    writeFileSync(
      join(kit, '.claude', 'skills', 'think', 'SKILL.md'),
      '---\nname: think\ndescription: Think it through.\n---\n# think\n'
    )
    seedProfile(world, {
      name: 'kit',
      root: kit,
      overlays: [kit],
      access: [kit],
      model: 'sonnet',
      effort: null,
      permissionMode: 'auto',
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null
    })
    await use(world)
    removeShims(join(world.dataDir, 'overlays'))
  }
})

const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

test('Ctrl+N starts a session in a folder found by typing, with the profile and mode picked there', async ({ helm, world }) => {
  const { window } = helm
  await expect(window.getByRole('button', { name: 'Start a session in alpha' })).toBeAttached()

  await window.keyboard.press('Control+N')
  const launcher = window.getByRole('dialog', { name: 'New session' })
  await expect(launcher.getByRole('combobox', { name: 'Folder' })).toBeFocused()
  await window.keyboard.type('alp')
  const folders = launcher.getByRole('listbox', { name: 'Folders' })
  await expect(folders.getByRole('option', { name: 'alpha' })).toHaveAttribute('aria-selected', 'true')

  // Nothing is about alpha, so it starts with no profile; taking one there
  // brings its mode, which is then changed.
  const profile = launcher.getByRole('combobox', { name: 'Profile' })
  const mode = launcher.getByRole('combobox', { name: 'Permissions' })
  await expect(profile).toHaveValue('')
  await profile.selectOption({ label: 'kit' })
  await expect(mode).toHaveValue('auto')
  await mode.selectOption({ label: 'Plan' })
  await expect(launcher.locator('[data-launch-sentence]')).toContainText(
    'with the kit profile, composing kit, and --model sonnet --permission-mode plan.'
  )

  await launcher.getByRole('combobox', { name: 'Folder' }).press('Enter')
  await expect(launcher).toBeHidden()
  await expect(window.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()

  const run = await claudeRunIn(world, world.projects.alpha)
  expect(after(run.argv, '-n')).toBe('alpha')
  expect(after(run.argv, '--model')).toBe('sonnet')
  expect(after(run.argv, '--permission-mode')).toBe('plan')
  expect((after(run.argv, '--plugin-dir') ?? '').toLowerCase()).toContain(join(world.dataDir, 'overlays').toLowerCase())
})

test('a conversation that ended reopens from the launcher, in the pane beside', async ({ helm, world }) => {
  const { window } = helm
  const id = await startSession(window, 'beta')
  const first = window.getByRole('region', { name: 'First pane' })
  await typeLine(first, 'sketch the migration')
  await expect.poll(() => terminalText(window, id)).toContain('You said: sketch the migration')
  const ended = await claudeRunIn(world, world.projects.beta)
  await typeLine(first, '/exit')
  await expect(window.getByRole('tab', { name: 'beta, ended' })).toBeVisible()

  // Opened on the folder in front, whose conversation sits under it.
  await window.getByRole('button', { name: 'New session (Ctrl+N)' }).click()
  const launcher = window.getByRole('dialog', { name: 'New session' })
  const folders = launcher.getByRole('listbox', { name: 'Folders' })
  await expect(folders.getByRole('option', { name: 'beta' })).toHaveAttribute('aria-selected', 'true')
  const conversation = folders.getByRole('option', { name: 'Resume sketch the migration' })
  await expect(conversation).toBeVisible()
  await window.keyboard.press('ArrowDown')
  await expect(conversation).toHaveAttribute('aria-selected', 'true')
  await expect(launcher.locator('[data-launch-sentence]')).toContainText('Reopens “sketch the migration” with claude --resume in')
  await window.keyboard.press('Control+Enter')

  const second = window.getByRole('region', { name: 'Second pane' })
  await expect(second.getByRole('tab', { name: /^sketch the migration/ })).toBeVisible()
  await expect(first.getByRole('tab', { name: 'beta, ended' })).toBeVisible()

  let resumed: FakeClaudeLog | undefined
  await expect
    .poll(() => {
      resumed = fakeClaudeLogs(world).find((log) => log.resumed)
      return resumed !== undefined
    })
    .toBe(true)
  const run = resumed as FakeClaudeLog
  expect(after(run.argv, '--resume')).toBe(ended.sessionId)
  for (const flag of ['-n', '--session-id']) expect(run.argv).not.toContain(flag)
  expect(run.cwd.toLowerCase()).toBe(world.projects.beta.toLowerCase())
  const resumedId = await sessionIdOf(window, /^sketch the migration/)
  await expect.poll(() => terminalText(window, resumedId)).toContain(`Resumed ${ended.sessionId}`)
})

test('a new harness and a new profile each end in a session, not on a page', async ({ helm, world }) => {
  const { window } = helm
  await expect(window.getByRole('button', { name: 'Start a session in alpha' })).toBeAttached()

  await window.getByRole('button', { name: 'Create a new harness' }).click()
  const create = window.getByRole('dialog', { name: 'Create a harness' })
  await create.getByRole('textbox', { name: 'Harness name' }).fill('camp')
  await create.getByRole('button', { name: 'Create harness' }).click()
  await expect(create).toBeHidden()
  await expect(window.getByRole('tab', { name: 'camp, ready' })).toBeVisible()
  await claudeRunIn(world, join(world.projectsDir, 'camp'))

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Profiles' }).click()
  await window.getByRole('button', { name: 'New profile' }).click()
  const editor = window.getByRole('dialog', { name: 'New profile' })
  await editor.getByRole('textbox', { name: 'Profile name' }).fill('beta plain')
  await editor.getByRole('textbox', { name: 'Root directory' }).fill(world.projects.beta)
  await editor.getByRole('button', { name: 'Save and start' }).click()
  await expect(editor).toBeHidden()
  await expect(window.getByRole('tab', { name: 'beta plain, ready' })).toBeVisible()
  const run = await claudeRunIn(world, world.projects.beta)
  expect(after(run.argv, '-n')).toBe('beta plain')
})
