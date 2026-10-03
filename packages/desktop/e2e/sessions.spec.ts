import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
