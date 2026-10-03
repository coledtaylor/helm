import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setOrigin } from '../test/gh-fixture'
import { repoRoot, type World } from '../test/world'
import { claudeRunIn, expect, test as base } from './helm'

/** Alpha's origin. The world's synthetic gh derives this repository's pull requests from the slug. */
const SLUG = 'example/alpha'

const test = base.extend<{ world: World }>({
  world: async ({ world }, use) => {
    setOrigin(world.projects.alpha, `https://github.com/${SLUG}.git`)
    await use(world)
  }
})

/** What the fake gh answers, asked of it directly rather than of Helm. */
function gh<T>(world: World, ...args: string[]): T {
  const out = execFileSync(
    process.execPath,
    [join(repoRoot(), 'packages', 'desktop', 'scripts', 'fake-gh.mjs'), ...args],
    { env: { ...world.env, HELM_FAKE_GH_SYNTHETIC: '1' }, encoding: 'utf8' }
  )
  return JSON.parse(out) as T
}

test('a project on GitHub shows its open pull requests, opens one, and reviews it in a session', async ({ helm, world }) => {
  const { window } = helm
  const open = gh<Array<{ number: number; title: string }>>(world, 'pr', 'list', '--repo', SLUG, '--json', 'number,title')
  expect(open.length).toBeGreaterThan(0)
  const [first] = open as [{ number: number; title: string }]
  const { comments } = gh<{ comments: Array<{ body: string }> }>(world, 'pr', 'view', String(first.number), '--repo', SLUG)
  expect(comments.length).toBeGreaterThan(0)

  await window.getByRole('button', { name: /^alpha/ }).click()
  const panel = window.getByRole('region', { name: 'First pane' })
  for (const pull of open) {
    await expect(panel.getByRole('button', { name: new RegExp(`^#${String(pull.number)}\\D`) })).toBeVisible()
  }

  await panel.getByRole('button', { name: new RegExp(`^#${String(first.number)}\\D`) }).click()
  await expect(panel.getByRole('heading', { level: 1, name: first.title })).toBeVisible()
  await expect(panel.getByText(comments[0]!.body)).toBeVisible()
  const review = panel.getByRole('button', { name: 'Review with Claude' })
  await expect(review).toBeEnabled()

  await review.click()
  const name = `PR #${String(first.number)} review - alpha`
  await expect(window.getByRole('tab', { name: new RegExp(`^${name}, `) })).toBeVisible()

  const run = await claudeRunIn(world, world.projects.alpha)
  expect(run.argv.slice(0, 2)).toEqual(['-n', name])
  expect(run.argv.at(-1)).toBe(`/code-review ${String(first.number)}`)
})
