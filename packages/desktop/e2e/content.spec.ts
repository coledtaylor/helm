import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test as base } from './helm'

/**
 * Reading a project's notes in the content viewer: following a wikilink from
 * one note to another, and opening an HTML artifact in its sandboxed frame.
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

const test = base.extend({
  world: async ({ world }, use) => {
    const notes = join(world.projects.alpha, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'first.md'), '# First note\n\nGo on to [[second]].\n')
    writeFileSync(join(notes, 'second.md'), '# Second note\n\nYou followed the link.\n')
    writeFileSync(join(notes, 'lesson.html'), LESSON)
    await use(world)
  }
})

/** The content pane on the alpha project, with its notes folder open in the tree. */
async function openNotes(window: Page): Promise<void> {
  await window.getByRole('button', { name: 'Content', exact: true }).click()
  const scope = window.getByRole('combobox', { name: 'Scope' })
  const alpha = scope.locator('option', { hasText: /^alpha$/ })
  const value = await alpha.getAttribute('value')
  expect(value).not.toBeNull()
  // Only when it is not already the scope on screen: a person cannot pick the
  // option that is already selected, and Playwright would send a change anyway.
  await expect(scope).not.toHaveValue('')
  if ((await scope.inputValue()) !== value) await scope.selectOption(value!)
  await expect(scope).toHaveValue(value!)
  const files = window.getByRole('group', { name: 'Content files' })
  await files.getByRole('button', { name: 'notes/', exact: true }).click()
}

const files = (window: Page) => window.getByRole('group', { name: 'Content files' })

test('a note opens rendered, and its wikilink opens the note it names', async ({ helm }) => {
  const { window } = helm
  await openNotes(window)

  await files(window).getByRole('button', { name: 'first.md', exact: true }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'First note' })).toBeVisible()

  await window.getByRole('link', { name: 'second', exact: true }).click()
  await expect(window.getByRole('heading', { level: 1, name: 'Second note' })).toBeVisible()
  await expect(window.getByText('You followed the link.')).toBeVisible()
})

test('an HTML artifact renders in a frame that can reach nothing, and its wikilink opens the note', async ({
  helm
}) => {
  const { window } = helm
  await openNotes(window)
  await files(window).getByRole('button', { name: 'lesson.html', exact: true }).click()

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
