import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Profile, ProfileDraft } from '@helm/core'
import { plantHarness, removeShims, type PlantedHarness } from '../../test/overlay-world'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import { appendPrompts, appendTranscript, claudeTree, sessionUuid, type ClaudeTree, type IpcHandler } from '../../test/history-fixture'
import type { HistoryIndex } from './history'
import type { IpcContext } from './ipc'
import type { SessionHost } from './sessions'
import type { Services } from './services'
import type { LaunchedSession, LaunchSessionRequest } from '../shared/ipc'

const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
vi.mock('electron', async () => (await import('../../test/history-fixture')).electronRecordingIpc(handlers))

/**
 * The new-session launcher's launch, through the `session:launch` handler the
 * window calls, against a real pty running the fake `claude`: a folder, a
 * profile made somewhere else, a permission mode, and a conversation to reopen.
 */
describe('launching from the new-session launcher', () => {
  const T0 = Date.UTC(2026, 9, 1, 9, 0, 0)
  let world: World
  let harness: PlantedHarness
  let tree: ClaudeTree
  let services: Services
  let host: SessionHost
  let index: HistoryIndex
  let profile: Profile

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']
    harness = plantHarness(world)

    const { createServices } = await import('./services')
    const { createSessionHost } = await import('./sessions')
    const { setClaudeOverride } = await import('./claude-cli')
    const { createHistoryIndex } = await import('./history')
    const { registerIpc } = await import('./ipc')
    const { saveProfile } = await import('./profiles')
    setClaudeOverride(world.claude)
    services = createServices()
    host = createSessionHost({ services, window: () => null, confirm: () => Promise.resolve(true) })
    index = createHistoryIndex({
      store: services.store,
      maxBytes: () => services.settings.transcriptArchiveMaxBytes,
      onHistoryChange: () => undefined,
      onArchiveChange: () => undefined
    })
    registerIpc({
      services,
      window: () => null,
      sessions: host,
      history: index.history,
      archive: index.archive,
      themes: { onChange: () => undefined }
    } as unknown as IpcContext)
    tree = claudeTree(world.claudeDir)

    // Made at the harness root and about its `tools` repository - the shape
    // most profiles on a real machine have.
    const draft: ProfileDraft = {
      name: 'hub tools',
      root: harness.root,
      overlays: [harness.overlay],
      access: [harness.overlay],
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'auto',
      agent: null,
      mcp: [],
      openingPrompt: '/recap',
      pinnedOrder: null
    }
    const saved = saveProfile(services, { draft })
    if (saved.profile === null) throw new Error(saved.problems.join(' '))
    profile = saved.profile
  })

  afterAll(async () => {
    for (const session of host.list()) {
      if (session.status === 'running') await host.close({ id: session.id, force: true })
    }
    await vi.waitFor(() => expect(host.list().filter((s) => s.status === 'running')).toEqual([]), {
      timeout: 10_000
    })
    host.shutdown()
    services.store.close()
    removeShims(join(world.dataDir, 'overlays'))
    disposeWorld(world)
  })

  const launch = (request: Partial<LaunchSessionRequest>): Promise<LaunchedSession> => {
    const handler = handlers.get('session:launch')
    if (handler === undefined) throw new Error('session:launch is not registered')
    return Promise.resolve(
      handler({
        cwd: world.projects.alpha,
        projectPath: world.projects.alpha,
        profileId: null,
        permissionMode: null,
        resume: null,
        cols: 100,
        rows: 30,
        ...request
      })
    ) as Promise<LaunchedSession>
  }

  /** The fake CLI's record of the run that registered under `sessionId`. */
  const runOf = async (sessionId: string | null): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.sessionId === sessionId)
      expect(found).toBeDefined()
    })
    return found as FakeClaudeLog
  }

  const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

  it('runs in the folder that was picked, with the profile composing everything but where', async () => {
    const launched = await launch({ profileId: profile.id, permissionMode: 'plan' })

    expect(launched.session).toMatchObject({
      cwd: world.projects.alpha,
      projectPath: world.projects.alpha,
      profileId: profile.id,
      name: 'alpha'
    })
    expect(launched.overlays).toEqual(['tools'])
    expect(launched.composedInstructions).toBe(true)
    expect(launched.warnings).toEqual([])

    const run = await runOf(launched.session.claudeSessionId)
    expect(run.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
    expect((after(run.argv, '--plugin-dir') ?? '').toLowerCase()).toContain(
      join(world.dataDir, 'overlays').toLowerCase()
    )
    expect(after(run.argv, '--add-dir')).toBe(harness.overlay)
    expect(after(run.argv, '--model')).toBe('sonnet')
    expect(after(run.argv, '--effort')).toBe('high')
    // The launcher's choice, over the profile's `auto`.
    expect(after(run.argv, '--permission-mode')).toBe('plan')
    expect(after(run.argv, '-n')).toBe('alpha')
    expect(run.argv.at(-1)).toBe('/recap')
  })

  it('passes no permission flag when none was chosen, whatever the profile says', async () => {
    const launched = await launch({
      cwd: world.projects.beta,
      projectPath: world.projects.beta,
      profileId: profile.id,
      permissionMode: null
    })
    const run = await runOf(launched.session.claudeSessionId)
    expect(run.argv).not.toContain('--permission-mode')
    expect(after(run.argv, '--model')).toBe('sonnet')
  })

  it('starts plain claude in the folder with no profile', async () => {
    const launched = await launch({ name: 'alpha' })
    expect(launched.session).toMatchObject({ profileId: null, name: 'alpha 2' })
    expect(launched.overlays).toEqual([])
    const run = await runOf(launched.session.claudeSessionId)
    for (const flag of ['--plugin-dir', '--model', '--permission-mode', '--add-dir']) {
      expect(run.argv).not.toContain(flag)
    }
  })

  it('reopens a conversation with the profile composed, in the folder history recorded', async () => {
    const id = sessionUuid(41)
    appendPrompts(tree, [{ sessionId: id, project: world.projects.beta, display: 'payroll export fix', at: T0 }])
    appendTranscript(tree, { sessionId: id, cwd: world.projects.beta }, [
      { role: 'user', text: 'payroll export fix', at: T0 },
      { role: 'assistant', text: 'Found it.', at: T0 + 1000 }
    ])
    index.history.refresh()

    // Sent with the wrong folder on purpose: the history row decides.
    const launched = await launch({ resume: id, profileId: profile.id, permissionMode: 'acceptEdits' })
    expect(launched.session).toMatchObject({
      cwd: world.projects.beta,
      projectPath: world.projects.beta,
      claudeSessionId: id,
      profileId: profile.id,
      name: 'payroll export fix'
    })

    const run = await runOf(id)
    expect(run.resumed).toBe(true)
    expect(run.cwd.toLowerCase()).toBe(world.projects.beta.toLowerCase())
    expect(after(run.argv, '--resume')).toBe(id)
    expect(run.argv).toContain('--plugin-dir')
    expect(after(run.argv, '--permission-mode')).toBe('acceptEdits')
    for (const flag of ['-n', '--name', '--session-id', '/recap']) expect(run.argv).not.toContain(flag)
  })

  it('refuses a profile that is gone, a mode the CLI does not take and a reaped conversation, and starts nothing', async () => {
    const before = fakeClaudeLogs(world).length
    const sessions = host.list().length
    const reaped = sessionUuid(42)
    appendPrompts(tree, [{ sessionId: reaped, project: world.projects.alpha, display: 'gone', at: T0 + 5000 }])
    index.history.refresh()

    await expect(launch({ profileId: 9999 })).rejects.toThrow('That profile no longer exists.')
    await expect(launch({ permissionMode: 'yolo' as never })).rejects.toThrow(
      'yolo is not a permission mode Claude Code accepts.'
    )
    await expect(launch({ resume: reaped })).rejects.toThrow(/removed this conversation.s transcript/)

    expect(host.list()).toHaveLength(sessions)
    expect(fakeClaudeLogs(world)).toHaveLength(before)
  })
})
