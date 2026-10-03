import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test as base } from './helm'

/**
 * A project's notes in the Files view: a note rendered and followed by its
 * wikilink, edited and saved, found by its text, and an HTML artifact in its
 * sandboxed frame.
 */
const LESSON = [
  '<!doctype html>',
  '<html><head><title>Lesson</title></head>',
  '<body>',
  '<h1>Lesson text</h1>',
  '<p id="probe">Then read [[second]], and later [[unwritten]].</p>',
  '<script>document.getElementById("probe").dataset.ran = "yes"</script>',
  '</body></html>',
  ''
].join('\n')

const FIRST = '# First note\n\nGo on to [[second]].\n'
const EDITED = `${FIRST}Written in Helm.`

const test = base.extend({
  world: async ({ world }, use) => {
    const notes = join(world.projects.alpha, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'first.md'), FIRST)
    writeFileSync(join(notes, 'second.md'), '# Second note\n\nYou followed the link.\n')
    writeFileSync(join(notes, 'lesson.html'), LESSON)
    await use(world)
  }
})

/** The Files view on the alpha project, with its notes folder open in the tree. */
async function openNotes(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Files', exact: true }).click()
  const picker = window.getByRole('button', { name: 'Project', exact: true })
  // Only when it is not already the project on screen.
  if ((await picker.textContent()) !== 'alpha') {
    await picker.click()
    await window.getByRole('listbox', { name: 'Projects' }).getByRole('option', { name: 'alpha', exact: true }).click()
  }
  await expect(picker).toHaveText('alpha')
  await files(window).getByRole('button', { name: /^notes\b/ }).click()
}

const files = (window: Page) => window.getByRole('group', { name: 'Project files' })
const pane = (window: Page) => window.getByRole('region', { name: 'First pane' })

test('a note opens rendered, and its wikilink opens the note it names', async ({ helm }) => {
  const { window } = helm
  await openNotes(window)

  await files(window).getByRole('button', { name: /^first\.md/ }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'First note' })).toBeVisible()
  await expect(window.getByRole('radiogroup', { name: 'Show as' }).getByRole('radio', { name: 'Preview' })).toBeChecked()

  await window.getByRole('link', { name: 'second', exact: true }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'Second note' })).toBeVisible()
  await expect(window.getByText('You followed the link.')).toBeVisible()
  // A wikilink opens beside the note, as a tab that stays.
  await expect(pane(window).getByRole('tab', { name: 'second.md' })).toBeVisible()
  await expect(pane(window).getByRole('tab', { name: 'first.md' })).toBeVisible()
})

test('a note is edited beside its preview, keeps its draft behind another tab, and saves to disk', async ({
  helm,
  world
}) => {
  const { window } = helm
  const path = join(world.projects.alpha, 'notes', 'first.md')
  await openNotes(window)
  await files(window).getByRole('button', { name: /^first\.md/ }).click()
  const modes = window.getByRole('radiogroup', { name: 'Show as' })

  // Source is the plain file view, read-only.
  await modes.getByRole('radio', { name: 'Source' }).click()
  await expect(window.getByRole('textbox', { name: 'Contents of notes/first.md' })).toHaveValue(FIRST)

  await modes.getByRole('radio', { name: 'Edit' }).click()
  const editor = window.getByRole('textbox', { name: 'Edit notes/first.md' })
  await editor.click()
  await editor.press('Control+End')
  await window.keyboard.type('Written in Helm.')
  await expect(window.getByText('Unsaved changes')).toBeVisible()
  // The preview is drawn from the draft.
  await expect(window.locator('[data-content-body]').getByText('Written in Helm.')).toBeVisible()
  // The tab says there is something unsaved where its close button sits.
  await expect(pane(window).getByRole('button', { name: 'Close first.md, unsaved changes' })).toBeVisible()

  // Behind another tab and back: the draft is still there.
  await files(window).getByRole('button', { name: /^second\.md/ }).dblclick()
  await expect(window.getByRole('heading', { level: 1, name: 'Second note' })).toBeVisible()
  await pane(window).getByRole('tab', { name: 'first.md' }).click()
  await expect(editor).toHaveValue(EDITED)

  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(window.getByText('Saved', { exact: true })).toBeVisible()
  expect(readFileSync(path, 'utf8')).toBe(EDITED)
  await expect(pane(window).getByRole('button', { name: 'Close first.md', exact: true })).toBeVisible()
  // The write was snapshotted first, so the version before it is one click back.
  await expect(window.getByRole('button', { name: '1 version' })).toBeVisible()
})

test('Ctrl+Shift+F finds a note by what it says and opens it with the words marked', async ({ helm }) => {
  const { window } = helm
  await openNotes(window)

  await window.keyboard.press('Control+Shift+F')
  await window.getByRole('combobox', { name: 'Text to find' }).fill('followed the')
  const hit = window.getByRole('option', { name: 'notes/second.md line 3: You followed the link.' })
  await expect(hit).toBeVisible()
  await window.keyboard.press('Enter')

  await expect(window.getByRole('heading', { level: 1, name: 'Second note' })).toBeVisible()
  await expect(window.locator('mark.md-hit')).toHaveText('followed the')
})

test('an HTML artifact renders in a frame that can reach nothing, and its wikilink opens the note', async ({
  helm
}) => {
  const { window } = helm
  await openNotes(window)
  await files(window).getByRole('button', { name: /^lesson\.html/ }).click()

  const frameElement = window.locator('iframe[src^="helm-content:"]')
  const frame = window.frameLocator('iframe[src^="helm-content:"]')
  await expect(frame.getByRole('heading', { name: 'Lesson text' })).toBeVisible()
  await expect(frame.locator('#probe')).toHaveAttribute('data-ran', 'yes')
  await expect(frameElement).toHaveAttribute('sandbox', 'allow-scripts')

  // Its own script and Helm's bootstrap both ran without a word to the console.
  await expect(window.getByRole('button', { name: 'console clean', exact: true })).toBeVisible()

  // A server of the test's own, to see whether anything in the frame reaches it.
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.end('reached')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`

  try {
    const inside = await (await frameElement.elementHandle())!.contentFrame()
    expect(inside).not.toBeNull()
    const reach = await inside!.evaluate(async (origin) => {
      // The frame's own global. `window` in this file is the Playwright page.
      const self = globalThis as unknown as Window
      const scope = self as unknown as Record<string, unknown>
      let top: string
      try {
        top = String(self.top?.document.title)
      } catch {
        top = 'blocked'
      }
      const fetched = await fetch(`${origin}/fetch`).then(
        () => 'fetched',
        () => 'refused'
      )
      const image = await new Promise<string>((resolve) => {
        const img = document.createElement('img')
        img.onload = () => resolve('loaded')
        img.onerror = () => resolve('refused')
        img.src = `${origin}/image.png`
        document.body.append(img)
      })
      return {
        helm: typeof scope['helm'],
        require: typeof scope['require'],
        process: typeof scope['process'],
        origin: self.origin,
        top,
        fetched,
        image
      }
    }, origin)
    expect(reach).toEqual({
      helm: 'undefined',
      require: 'undefined',
      process: 'undefined',
      origin: 'null',
      top: 'blocked',
      fetched: 'refused',
      image: 'refused'
    })
    expect(requests).toEqual([])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }

  // The bootstrap made both names links, and marked the one nothing answers to.
  await expect(frame.getByTitle('No note in this scope answers to that name yet')).toHaveText('unwritten')
  await frame.getByText('second', { exact: true }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'Second note' })).toBeVisible()
})
