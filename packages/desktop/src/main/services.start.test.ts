import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { planOverlays, syncOverlay, type SyncedOverlay } from '@helm/core'
import {
  claimShimFor,
  exitedPid,
  isLink,
  plantHarness,
  removeShims,
  runningProcess,
  shimOwners,
  type PlantedHarness
} from '../../test/overlay-world'
import { createWorld, disposeWorld, type World } from '../../test/world'
import type { Services } from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * What `createServices` - app start - does to the data directory before any
 * window exists: seeding the templates directory, and sweeping overlay shims
 * that nothing holds any more.
 */
describe('app start', () => {
  let world: World
  let harness: PlantedHarness
  let shimRoot: string
  let templatesDir: string
  let createServices: () => Services

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, { PORTABLE_EXECUTABLE_DIR: world.portableDir, USERPROFILE: world.home, HOME: world.home })
    ;({ createServices } = await import('./services'))
    harness = plantHarness(world)
    // Where the app keeps these, by its own rule: under its data directory.
    shimRoot = join(world.dataDir, 'overlays')
    templatesDir = join(world.dataDir, 'templates')
  })

  afterEach(() => removeShims(shimRoot))

  afterAll(() => {
    removeShims(shimRoot)
    disposeWorld(world)
  })

  /** Starts the app's services once and closes the database again. */
  const start = (): Services => {
    const services = createServices()
    services.store.close()
    return services
  }

  /** The shim a launch composing the harness's overlay would build. */
  const buildShim = (): SyncedOverlay => {
    const [plan] = planOverlays([harness.overlay], shimRoot)
    if (plan === undefined) throw new Error('no overlay plan')
    const shim = syncOverlay(plan)
    expect(isLink(join(shim.dir, 'skills'))).toBe(true)
    return shim
  }

  const skillThroughShim = (shim: SyncedOverlay): string =>
    readFileSync(join(shim.dir, 'skills', harness.skill, 'SKILL.md'), 'utf8')

  it('seeds the templates directory on the first start and writes nothing on a later one', () => {
    expect(existsSync(templatesDir)).toBe(false)

    const first = start()
    expect(first.templates.seeded).toBe(true)
    expect(readdirSync(templatesDir).sort()).toEqual(['README.md', 'example'])
    expect(existsSync(join(templatesDir, 'example', 'template.yaml'))).toBe(true)

    writeFileSync(join(templatesDir, 'README.md'), 'edited by hand')
    const second = start()
    expect(second.templates.seeded).toBe(false)
    expect(readFileSync(join(templatesDir, 'README.md'), 'utf8')).toBe('edited by hand')
  })

  it('sweeps a shim whose owner has exited, and leaves the repository it linked', () => {
    const shim = buildShim()
    const gone = exitedPid()
    claimShimFor(shim.dir, gone)
    expect(shimOwners(shim.dir)).toEqual([gone])

    const services = start()

    expect(services.staleShims).toBe(1)
    expect(readdirSync(shimRoot).filter((name) => name.startsWith('overlay-'))).toEqual([])
    expect(readFileSync(join(harness.overlay, '.claude', 'skills', harness.skill, 'SKILL.md'), 'utf8')).toContain(
      '# think'
    )
    expect(existsSync(join(harness.overlay, '.claude', 'agents', `${harness.agent}.md`))).toBe(true)
  })

  it('leaves the live shim of another Helm on the same data directory, junctions and all', () => {
    const shim = buildShim()
    const other = runningProcess()
    try {
      claimShimFor(shim.dir, other.pid)

      const services = start()

      expect(services.staleShims).toBe(0)
      expect(shimOwners(shim.dir)).toEqual([other.pid])
      expect(isLink(join(shim.dir, 'skills'))).toBe(true)
      expect(skillThroughShim(shim)).toContain('# think')
    } finally {
      other.stop()
    }
  })
})
