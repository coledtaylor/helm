import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as core from '@helm/core'
import { createWorld, disposeWorld, type World } from '../../test/world'
import type * as servicesModule from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * Scans that finish when the test says so. The real scan runs; only the moment
 * its answer is handed back is held, which is the one thing a slow disk changes.
 */
const held = vi.hoisted(() => [] as { roots: string[]; release: () => void }[])

vi.mock('@helm/core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>()
  return {
    ...actual,
    scan: async (opts: Parameters<typeof actual.scan>[0]): Promise<core.DiscoveryResult> => {
      const result = await actual.scan(opts)
      await new Promise<void>((release) => held.push({ roots: [...opts.roots], release }))
      return result
    }
  }
})

/**
 * `runScan` when scans overlap: the startup scan is still walking when a root
 * accepted in the setup pane starts another one (TPL-13).
 */
describe('overlapping scans', () => {
  let world: World
  let services: servicesModule.Services
  let mod: typeof servicesModule
  let first: string
  let second: string
  let added: string

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, { PORTABLE_EXECUTABLE_DIR: world.portableDir, USERPROFILE: world.home, HOME: world.home })
    mod = await import('./services')
    services = mod.createServices()

    first = world.projectsDir
    second = join(world.root, 'more')
    added = join(second, 'gamma')
    mkdirSync(join(added, '.claude'), { recursive: true })
  })

  afterAll(() => {
    services.store.close()
    disposeWorld(world)
  })

  beforeEach(() => {
    held.length = 0
  })

  /**
   * Starts a scan over `roots`, the way `roots:accept` and then a rescan do.
   * Boxed, because an async function returning the scan's promise would wait on it.
   */
  const startScan = async (roots: string[]): Promise<{ done: Promise<core.DiscoveryResult> }> => {
    mod.updateSettings(services, { scanRoots: roots })
    const before = held.length
    const done = mod.runScan(services, { includeGit: false })
    await vi.waitFor(() => expect(held.length).toBe(before + 1))
    return { done }
  }

  it('keeps the newer scan when the older one finishes after it', async () => {
    const startup = await startScan([first])
    const accepted = await startScan([first, second])
    expect(held.map((scan) => scan.roots)).toEqual([[first], [first, second]])

    held[1]?.release()
    await accepted.done
    held[0]?.release()
    const told = await startup.done

    // What the app holds, and what the window was handed last, both describe
    // the roots as they are now - with the project only the new root has.
    expect(services.lastScan?.roots).toEqual([resolve(first), resolve(second)])
    expect(services.lastScan?.projects.map((project) => project.path)).toContain(added)
    expect(told.roots).toEqual([resolve(first), resolve(second)])
    expect(mod.cachedProjects(services).map((project) => project.path)).toContain(added)
  })

  it('takes the newer scan when the two finish in the order they started', async () => {
    const older = await startScan([second])
    const newer = await startScan([first, second])

    held[0]?.release()
    await older.done
    held[1]?.release()
    await newer.done

    expect(services.lastScan?.roots).toEqual([resolve(first), resolve(second)])
    expect(services.lastScan?.projects.map((project) => project.path)).toEqual(
      expect.arrayContaining([world.projects.alpha, world.projects.beta, added])
    )
  })
})
