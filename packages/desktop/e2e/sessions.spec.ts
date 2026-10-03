import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClaudeLogs } from '../test/world'
import { claudeRunIn, expect, processAlive, startSession, terminalText, test, typeLine } from './helm'

test('a session starts in a project, takes input and ends', async ({ helm, world }) => {
  const { window } = helm
  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })

  await expect.poll(() => terminalText(window, id)).toContain('Claude Code v2.1.999 (fake)')
  // The crumb under the tabs names the branch the session is on.
  await expect(pane.getByText('main', { exact: true })).toBeVisible()

  await typeLine(pane, 'hello there')
  await expect.poll(() => terminalText(window, id)).toContain('You said: hello there')

  const run = await claudeRunIn(world, world.projects.alpha)
  expect(run.argv[run.argv.indexOf('--session-id') + 1]).toMatch(/^[0-9a-f-]{36}$/)
  const history = readFileSync(join(world.claudeDir, 'history.jsonl'), 'utf8')
  expect(history).toContain('"display":"hello there"')

  await typeLine(pane, '/exit')
  await expect(window.getByRole('tab', { name: 'alpha, ended' })).toBeVisible()
  await expect(pane.getByRole('status')).toContainText('Session ended')

  await pane.getByRole('status').getByRole('button', { name: 'Close tab' }).click()
  await expect(window.getByRole('tab', { name: /^alpha/ })).toHaveCount(0)
  await expect(window.getByRole('contentinfo')).toContainText('No sessions running')
})

test('quitting Helm ends every session and everything a session started', async ({ helm, world }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  const beta = await startSession(window, 'beta')

  await typeLine(window.getByRole('region', { name: 'First pane' }), '/child')
  let child = 0
  await expect
    .poll(async () => {
      child = Number(/child (\d+)/.exec(await terminalText(window, beta))?.[1] ?? 0)
      return child
    })
    .toBeGreaterThan(0)

  const pids = [
    (await claudeRunIn(world, world.projects.alpha)).pid,
    (await claudeRunIn(world, world.projects.beta)).pid,
    child
  ]
  expect(pids.every(processAlive)).toBe(true)

  await helm.app.close()
  await expect.poll(() => pids.filter(processAlive), { timeout: 10_000 }).toEqual([])
})

test('a session tab is renamed, then closed with confirmation', async ({ helm, world }) => {
  const { window } = helm
  await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  const run = await claudeRunIn(world, world.projects.alpha)
  const received = (): string[] => fakeClaudeLogs(world).find((log) => log.pid === run.pid)?.received ?? []

  await typeLine(pane, 'before')
  await expect.poll(received).toEqual(['before'])

  // The rename field takes the keyboard while it is open.
  await pane.getByRole('tab', { name: 'alpha, ready' }).dblclick()
  const field = pane.getByRole('textbox', { name: 'Rename this tab' })
  await expect(field).toBeFocused()
  await field.pressSequentially('review')
  await expect(field).toBeFocused()
  await expect(field).toHaveValue('review')
  await field.press('Enter')
  await expect(pane.getByRole('tab', { name: 'review, ready' })).toBeVisible()
  await expect(field).toHaveCount(0)

  // Had any of the rename's keys reached the session, they would be on the
  // front of this line.
  await typeLine(pane, 'after')
  await expect.poll(received).toEqual(['before', 'after'])

  // Closing the live tab asks first, by its new name; Cancel keeps the tab and the process.
  const dialog = window.getByRole('alertdialog', { name: '“review” is still running.' })
  await pane.getByRole('button', { name: 'Close review' }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(pane.getByRole('tab', { name: 'review, ready' })).toBeVisible()
  expect(processAlive(run.pid)).toBe(true)

  // Agreeing ends the session and takes its tab away.
  await pane.getByRole('button', { name: 'Close review' }).click()
  await dialog.getByRole('button', { name: 'End session' }).click()
  await expect(window.getByRole('tab', { name: /^review/ })).toHaveCount(0)
  await expect.poll(() => processAlive(run.pid), { timeout: 10_000 }).toBe(false)
  await expect(window.getByRole('contentinfo')).toContainText('No sessions running')
})
