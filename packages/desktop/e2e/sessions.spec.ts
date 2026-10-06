import type { Locator, Page } from '@playwright/test'
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

/** Where `text` is drawn in a session's terminal: the middle of its second cell, in window coordinates. */
async function pointAt(pane: Locator, sessionId: number, text: string): Promise<{ x: number; y: number }> {
  const terminal = await pane.page().evaluate(
    (key) =>
      (
        window as unknown as {
          __helmTerminals: () => { sessions: { key: string; lines: string[]; cols: number; rows: number }[] }
        }
      )
        .__helmTerminals()
        .sessions.find((s) => s.key === key),
    String(sessionId)
  )
  const screen = await pane.locator('.xterm-screen').boundingBox()
  const row = terminal?.lines.findIndex((line) => line.includes(text)) ?? -1
  if (terminal === undefined || screen === null || row < 0) throw new Error(`${text} is not on screen`)
  const column = (terminal.lines[row] ?? '').indexOf(text) + 1
  const cell = { width: screen.width / terminal.cols, height: screen.height / terminal.rows }
  return { x: screen.x + (column + 0.5) * cell.width, y: screen.y + (row + 0.5) * cell.height }
}

async function ctrlClick(window: Page, at: { x: number; y: number }): Promise<void> {
  await window.mouse.move(at.x, at.y)
  await window.keyboard.down('Control')
  await window.mouse.down()
  await window.mouse.up()
  await window.keyboard.up('Control')
}

test('a link in a session opens on Ctrl+click, once, wherever focus was, and a plain click stays the session’s', async ({
  helm,
  world
}) => {
  const { app, window } = helm
  // Nothing leaves the app: the system browser is recorded rather than opened.
  await app.evaluate(({ shell }) => {
    const record = globalThis as { opened?: string[] }
    record.opened = []
    shell.openExternal = async (url: string) => {
      record.opened?.push(url)
    }
  })
  const opened = (): Promise<string[] | undefined> => app.evaluate(() => (globalThis as { opened?: string[] }).opened)
  const docs = 'https://example.test/docs'
  const bare = 'https://example.test/bare'

  const id = await startSession(window, 'alpha')
  const pane = window.getByRole('region', { name: 'First pane' })
  const run = await claudeRunIn(world, world.projects.alpha)
  const mouse = (): string[] => fakeClaudeLogs(world).find((log) => log.pid === run.pid)?.mouse ?? []

  // Like Claude Code's fullscreen interface, the session asks for the mouse.
  await typeLine(pane, '/links')
  await expect.poll(() => terminalText(window, id)).toContain(`Or see ${bare} for more.`)
  // The fake draws a hyperlink only when told the terminal shows them; as
  // plain text the address would follow the words on the same line.
  expect((await terminalText(window, id)).split('\n')).toContain('Read the docs')

  // Focus elsewhere in the window first: the case where the session took the
  // press for the one that activated its window, and opened nothing.
  const filter = window.getByRole('textbox', { name: 'Filter projects and sessions' })
  await filter.click()
  await ctrlClick(window, await pointAt(pane, id, 'Read the docs'))
  await expect.poll(opened).toEqual([docs])
  await ctrlClick(window, await pointAt(pane, id, bare))
  await expect.poll(opened).toEqual([docs, bare])

  // Off the pane and straight back onto the cell it left from, where xterm on
  // its own finds no link: the browser opened over the window, say, and the
  // pointer is where it was when the window comes back.
  await filter.hover()
  await ctrlClick(window, await pointAt(pane, id, bare))
  await expect.poll(opened).toEqual([docs, bare, bare])

  // A plain click on the link is the session's: it is sent the press and the
  // release, with no modifier, and nothing opens.
  const plain = await pointAt(pane, id, 'Read the docs')
  await window.mouse.click(plain.x, plain.y)
  await expect.poll(mouse).toHaveLength(2)
  expect(mouse().map((report) => report.slice(1))).toEqual([
    expect.stringMatching(/^\[<0;\d+;\d+M$/),
    expect.stringMatching(/^\[<0;\d+;\d+m$/)
  ])
  // So no Ctrl+click reached it, and each opened its link once.
  expect(await opened()).toEqual([docs, bare, bare])
})
