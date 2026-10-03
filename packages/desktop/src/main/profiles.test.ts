import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { readSessions, type ProfileDraft } from '@helm/core'
import { plantHarness, removeShims, type PlantedHarness } from '../../test/overlay-world'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import type * as profilesModule from './profiles'
import type { SessionHost } from './sessions'
import type * as servicesModule from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * Profiles through the main process: the projects the form is offered, saving
 * one, and launching it against a real pty running the fake `claude`.
 */
describe('profiles', () => {
  let world: World
  let harness: PlantedHarness
  let services: servicesModule.Services
  let host: SessionHost
  let main: typeof servicesModule & typeof profilesModule

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, { PORTABLE_EXECUTABLE_DIR: world.portableDir, USERPROFILE: world.home, HOME: world.home })
    delete process.env['CLAUDE_CONFIG_DIR']
    harness = plantHarness(world)

    main = { ...(await import('./services')), ...(await import('./profiles')) }
    const { createSessionHost } = await import('./sessions')
    const { setClaudeOverride } = await import('./claude-cli')
    setClaudeOverride(world.claude)
    services = main.createServices()
    host = createSessionHost({ services, window: () => null, confirm: () => Promise.resolve(true) })
  })

  afterAll(async () => {
    for (const session of host.list()) {
      if (session.status === 'running') await host.close({ id: session.id, force: true })
    }
    await vi.waitFor(() => expect(host.list().filter((s) => s.status === 'running')).toEqual([]), {
      timeout: 10_000
    })
    // As before-quit does: a killed pty can report its exit after this, and
    // the host must not write it to a store that has been closed.
    host.shutdown()
    services.store.close()
    removeShims(join(world.dataDir, 'overlays'))
    disposeWorld(world)
  })

  const draft = (patch: Partial<ProfileDraft> = {}): ProfileDraft => ({
    name: 'hub dev',
    root: harness.root,
    overlays: [harness.overlay],
    access: [harness.overlay],
    model: 'sonnet',
    effort: null,
    permissionMode: null,
    agent: null,
    mcp: [],
    openingPrompt: '/recap',
    pinnedOrder: null,
    ...patch
  })

  /** The value after a flag in an argv, or undefined. */
  const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

  const runIn = async (cwd: string): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.cwd.toLowerCase() === cwd.toLowerCase())
      expect(found).toBeDefined()
    })
    return found as FakeClaudeLog
  }

  it('discovers a harness added as a scan root with its repositories, which is what the form offers', async () => {
    main.updateSettings(services, { scanRoots: [harness.root] })
    const result = await main.runScan(services, { includeGit: false })

    expect(result.harnesses.map((h) => ({ path: h.path, repos: h.repoPaths }))).toEqual([
      { path: harness.root, repos: [harness.overlay] }
    ])
    expect(result.projects.map((p) => ({ path: p.path, kind: p.kind, harness: p.harnessPath }))).toEqual([
      { path: harness.root, kind: 'harness', harness: harness.root },
      { path: harness.overlay, kind: 'repo', harness: harness.root }
    ])
  })

  it('saves a profile and lists it, and refuses a second one by the same name', () => {
    const saved = main.saveProfile(services, { draft: draft({ name: '  hub dev  ' }) })
    expect(saved.problems).toEqual([])
    expect(main.profiles(services)).toEqual([expect.objectContaining({ ...draft(), id: saved.profile?.id })])

    const clash = main.saveProfile(services, { draft: draft({ name: 'HUB DEV' }) })
    expect(clash.profile).toBeNull()
    expect(clash.problems).toEqual(['A profile named “hub dev” already exists.'])
    expect(main.profiles(services)).toHaveLength(1)
  })

  it('launches one session at the root, composed from its overlay and recorded against the profile', async () => {
    const profile = main.profiles(services).find((p) => p.name === 'hub dev')
    if (profile === undefined) throw new Error('the saved profile is missing')

    const launched = await host.launchProfile({ profileId: profile.id, cols: 100, rows: 30 })

    expect(launched.session).toMatchObject({ cwd: harness.root, profileId: profile.id, name: 'hub dev' })
    expect(launched.overlays).toEqual(['tools'])
    expect(launched.composedInstructions).toBe(true)
    expect(readSessions(services.store).filter((s) => s.profileId === profile.id)).toHaveLength(1)

    const run = await runIn(harness.root)
    const overlays = join(world.dataDir, 'overlays').toLowerCase()
    const pluginDir = after(run.argv, '--plugin-dir') ?? ''
    expect(pluginDir.toLowerCase().startsWith(overlays)).toBe(true)
    // The plugin directory is the overlay's skills, read through the shim.
    expect(readFileSync(join(pluginDir, 'skills', harness.skill, 'SKILL.md'), 'utf8')).toContain('# think')
    const memory = after(run.argv, '--append-system-prompt-file') ?? ''
    expect(memory.toLowerCase().startsWith(overlays)).toBe(true)
    expect(readFileSync(memory, 'utf8')).toContain('The tools repository.')
    expect(after(run.argv, '--add-dir')).toBe(harness.overlay)
    expect(after(run.argv, '--model')).toBe('sonnet')
    expect(run.argv.at(-1)).toBe('/recap')
  })
})
