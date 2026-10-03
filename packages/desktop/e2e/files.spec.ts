import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, startSession, test as base } from './helm'

/**
 * The Files view: a project's tree with git's letters on it, a file read beside
 * the session changing it with the changed lines marked and the view following
 * each edit, Ctrl+P, and the hand-offs to VS Code, Explorer and the clipboard.
 */

/** 120 lines, so the file is longer than the pane and its last line has to be scrolled to. */
const LINES = Array.from({ length: 120 }, (_, i) => `// line ${String(i + 1)}`)
const text = (lines: string[]): string => `${lines.join('\n')}\n`

const test = base.extend({
  world: async ({ world }, use) => {
    const alpha = world.projects.alpha
    mkdirSync(join(alpha, 'src'))
    writeFileSync(join(alpha, 'src', 'app.ts'), text(LINES))
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=Helm Tests', '-c', 'user.email=tests@helm.invalid', ...args], {
        cwd: alpha,
        stdio: 'ignore'
      })
    }
    git('add', '.')
    git('commit', '-q', '-m', 'app')
    await use(world)
  }
})

test('a file opens beside its session with the changed lines marked, and follows the edits', async ({ helm, world }) => {
  const { window } = helm
  const app = join(world.projects.alpha, 'src', 'app.ts')
  await startSession(window, 'alpha')

  await window.getByRole('button', { name: 'Files', exact: true }).click()
  // The view is on the project of the session in front.
  await expect(window.getByRole('button', { name: 'Project', exact: true })).toHaveText('alpha')
  const tree = window.getByRole('group', { name: 'Project files' })

  // What the session does: rewrite two lines.
  const edited = [...LINES]
  edited[2] = '// line three'
  edited[3] = '// line four'
  writeFileSync(app, text(edited))

  // A row's name carries what git says about it: "src Holds changed files".
  await tree.getByRole('button', { name: /^src\b/ }).click()
  const row = tree.getByRole('button', { name: /^app\.ts/ })
  await expect(row).toHaveAccessibleName('app.ts Modified')
  await row.click()

  const first = window.getByRole('region', { name: 'First pane' })
  const second = window.getByRole('region', { name: 'Second pane' })
  await expect(first.getByRole('tab', { name: 'alpha, ready' })).toBeVisible()
  await expect(second.getByRole('tab', { name: 'app.ts' })).toBeVisible()
  // Named in full on the crumb's hover text; the pane beside a session is too
  // narrow for the sentence, so the crumb shows its short form.
  await expect(second.getByTitle('2 lines changed since the last commit')).toHaveText(/2 changed$/)
  const view = second.getByRole('textbox', { name: 'Contents of src/app.ts' })
  await expect(view).toHaveValue(text(edited))
  await expect(second.getByText('packages')).toHaveCount(0)

  // The line numbers run to the bottom of the file.
  await view.evaluate((box) => {
    box.scrollTop = box.scrollHeight
    box.dispatchEvent(new Event('scroll'))
  })
  await expect(second.getByText('120', { exact: true })).toBeVisible()

  // The session edits again, and the view follows without being asked.
  edited.push('// line 121')
  writeFileSync(app, text(edited))
  await expect(view).toHaveValue(text(edited))
  await expect(second.getByTitle('3 lines changed since the last commit')).toBeVisible()
})

test('Ctrl+P opens a file by a few letters, and a file goes to VS Code, Explorer or the clipboard', async ({
  helm,
  world
}) => {
  const { app, window } = helm
  const file = join(world.projects.alpha, 'src', 'app.ts')

  // Nothing leaves the app: VS Code and Explorer are recorded rather than opened.
  await app.evaluate(({ app: electronApp, shell }) => {
    const record = globalThis as { opened?: string[]; shown?: string[] }
    record.opened = []
    record.shown = []
    shell.openExternal = async (url: string) => {
      record.opened?.push(url)
    }
    shell.showItemInFolder = (path: string) => {
      record.shown?.push(path)
    }
    electronApp.getApplicationNameForProtocol = () => 'Visual Studio Code'
  })
  // The window asks whether VS Code is here when it mounts.
  await window.reload()

  await window.getByRole('button', { name: 'Files', exact: true }).click()
  await window.getByRole('button', { name: 'Project', exact: true }).click()
  await window.getByRole('listbox', { name: 'Projects' }).getByRole('option', { name: 'alpha', exact: true }).click()
  await expect(window.getByRole('group', { name: 'Project files' }).getByRole('button', { name: /^src\b/ })).toBeVisible()

  await window.keyboard.press('Control+p')
  await window.getByRole('combobox', { name: 'File name' }).fill('app')
  await expect(window.getByRole('option', { name: 'src/app.ts' })).toBeVisible()
  await window.keyboard.press('Enter')

  const pane = window.getByRole('region', { name: 'First pane' })
  await expect(pane.getByRole('tab', { name: 'app.ts' })).toBeVisible()
  await expect(pane.getByTitle('No changes since the last commit')).toBeVisible()

  await pane.getByRole('button', { name: 'Copy path' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(file)

  await pane.getByRole('button', { name: 'Reveal in Explorer' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { shown?: string[] }).shown)).toEqual([file])

  await pane.getByRole('button', { name: 'Open in VS Code' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
    .toEqual([expect.stringMatching(/^vscode:\/\/file\/.+\/src\/app\.ts:1:1$/)])
})
