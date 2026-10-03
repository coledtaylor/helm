import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, startSession, test as base } from './helm'

/**
 * The rail starts a piece of work; the tab it leaves open carries on with it.
 * Clicking a tab brings back the sidebar it belongs to - open, and pointed at
 * the tab's own row - so nobody goes back to the rail for a list the tab
 * already belongs to.
 */

const test = base.extend({
  world: async ({ world }, use) => {
    mkdirSync(join(world.projects.alpha, 'src'))
    writeFileSync(join(world.projects.alpha, 'src', 'app.ts'), 'export {}\n')
    await use(world)
  }
})

test('clicking a tab brings its sidebar back, opened and pointed at it', async ({ helm }) => {
  const { window } = helm
  const rail = (id: string) => window.locator(`[data-rail="${id}"]`)
  const sections = window.getByRole('navigation', { name: 'Settings sections' })
  const files = window.getByRole('group', { name: 'Project files' })
  const sessions = window.getByRole('navigation', { name: 'Projects and sessions' })
  const profiles = window.getByRole('button', { name: 'Import a profile' })

  await startSession(window, 'alpha')
  await rail('settings').click()
  await expect(sections).toBeVisible()

  // A file opened from the tree, then its folder folded away behind it.
  await rail('files').click()
  await files.getByRole('button', { name: /^src\b/ }).click()
  await files.getByRole('button', { name: /^app\.ts/ }).dblclick()
  await expect(window.getByRole('tab', { name: 'app.ts' })).toBeVisible()
  await files.getByRole('button', { name: /^src\b/ }).click()
  await expect(files.getByRole('button', { name: /^app\.ts/ })).toHaveCount(0)

  // Settings' tab brings its sections back, from another view.
  await rail('profiles').click()
  await expect(profiles).toBeVisible()
  await window.getByRole('tab', { name: 'Settings' }).click()
  await expect(sections).toBeVisible()
  await expect(profiles).toHaveCount(0)

  // The file's tab brings the tree, with the folder holding it open again.
  await window.getByRole('tab', { name: 'app.ts' }).click()
  await expect(files.getByRole('button', { name: /^app\.ts/ })).toHaveAttribute('aria-current', 'true')

  // Put away from the rail, the sidebar comes back for the session's tab.
  await rail('files').click()
  await expect(files).toHaveCount(0)
  await window.getByRole('tab', { name: 'alpha, ready' }).click()
  await expect(sessions.getByRole('button', { name: 'alpha, ready' })).toHaveAttribute('aria-current', 'true')

  // A tab with its own list inside it leaves the sidebar where it was.
  await rail('history').click()
  await rail('profiles').click()
  await window.getByRole('tab', { name: 'Session history' }).click()
  await expect(profiles).toBeVisible()
})
