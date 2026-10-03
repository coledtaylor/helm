import { fakeClaudeLogs, type FakeClaudeLog } from '../test/world'
import { claudeRunIn, expect, sessionIdOf, startSession, terminalText, test, typeLine } from './helm'

test('a session ended in Helm is in the history, and resumes in the folder it ran in', async ({ helm, world }) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  await typeLine(pane, 'plan the release')
  await expect.poll(() => terminalText(window, id)).toContain('You said: plan the release')
  const first = await claudeRunIn(world, world.projects.alpha)
  await typeLine(pane, '/exit')
  await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()

  await window.getByRole('navigation', { name: 'Destinations' }).getByRole('button', { name: 'Session history' }).click()
  const row = window.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: /^plan the release/ })
  await expect(row).toContainText('alpha')
  await row.click()
  await window.getByRole('button', { name: 'Resume in a tab' }).click()

  const tab = window.getByRole('tab', { name: /^plan the release/ })
  await expect(tab).toBeVisible()
  let resumed: FakeClaudeLog | undefined
  await expect
    .poll(() => {
      resumed = fakeClaudeLogs(world).find((log) => log.resumed)
      return resumed !== undefined
    })
    .toBe(true)
  const run = resumed as FakeClaudeLog
  expect(run.argv[run.argv.indexOf('--resume') + 1]).toBe(first.sessionId)
  for (const flag of ['-n', '--name', '--session-id']) expect(run.argv).not.toContain(flag)
  expect(run.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())

  const resumedId = await sessionIdOf(window, /^plan the release/)
  await expect.poll(() => terminalText(window, resumedId)).toContain(`Resumed ${first.sessionId}`)
})
