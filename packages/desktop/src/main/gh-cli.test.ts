import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createGhFixture, type GhFixture } from '../../test/gh-fixture'
import { createWorld, disposeWorld, type World } from '../../test/world'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * `gh` installed as a batch shim - the scoop and npm shape - under a path with
 * a space in it, which is an ordinary Windows user folder.
 */
describe('a gh that is a .cmd shim', () => {
  let world: World
  let fx: GhFixture

  beforeAll(() => {
    world = createWorld()
    fx = createGhFixture(join(world.root, 'gh fixture'))
  })

  afterAll(() => {
    disposeWorld(world)
  })

  it('is resolved through cmd.exe and run', async () => {
    const { resolveGhCommand } = await import('./gh-cli')
    const { readGhVersion } = await import('@helm/core')
    expect(fx.gh).toContain(' ')

    const command = resolveGhCommand(fx.gh)
    expect(command?.resolved).toBe(fx.gh)
    expect(await readGhVersion(command!)).toBe('gh version 2.86.0 (fixture)')
  })

  it('hands every argument over intact, spaces and brackets included', async () => {
    const { resolveGhCommand } = await import('./gh-cli')
    const { runGh } = await import('@helm/core')
    const argv = [
      'api',
      'graphql',
      '-f',
      'query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }',
      '-f',
      'owner=acme',
      '-f',
      'name=a repo',
      '-F',
      'number=1'
    ]

    const run = await runGh(resolveGhCommand(fx.gh)!, argv)

    expect(run.stderr).toBe('')
    expect(run.ok).toBe(true)
    expect(fx.calls().at(-1)?.argv).toEqual(argv)
  })
})
