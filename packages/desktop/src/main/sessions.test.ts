import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import type { SessionHost } from './sessions'
import type { Services } from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The session host against a real pty running the fake `claude`: what goes in
 * and out of a session, and what is recorded about it.
 */
describe('session host', () => {
  let world: World
  let services: Services
  let host: SessionHost
  const output = new Map<number, string>()

  beforeAll(async () => {
    world = createWorld()
    // The data directory and Claude's home are read when the modules load,
    // so the world is in place before they are imported.
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']

    const { createServices } = await import('./services')
    const { createSessionHost } = await import('./sessions')
    const { setClaudeOverride } = await import('./claude-cli')
    setClaudeOverride(world.claude)
    services = createServices()
    host = createSessionHost({
      services,
      window: () => null,
      observer: { onOutput: (id, chunk) => output.set(id, (output.get(id) ?? '') + chunk) },
      confirm: () => Promise.resolve(true)
    })
  })

  afterAll(async () => {
    for (const session of host.list()) {
      if (session.status === 'running') await host.close({ id: session.id, force: true })
    }
    // A pty reports its exit after it has been killed, and the host records it.
    await vi.waitFor(() => expect(host.list().filter((s) => s.status === 'running')).toEqual([]), {
      timeout: 10_000
    })
    services.store.close()
    disposeWorld(world)
  })

  const runIn = async (cwd: string): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.cwd.toLowerCase() === cwd.toLowerCase())
      expect(found).toBeDefined()
    })
    return found as FakeClaudeLog
  }

  it('starts claude in the folder, under a session id it chose, and streams its screen', async () => {
    const record = await host.start({ cwd: world.projects.alpha, projectPath: world.projects.alpha, name: 'alpha', cols: 100, rows: 30 })

    expect(record.status).toBe('running')
    expect(record.branch).toBe('main')
    await vi.waitFor(() => expect(output.get(record.id)).toContain('Claude Code v2.1.999 (fake)'))

    const run = await runIn(world.projects.alpha)
    const sessionId = run.argv[run.argv.indexOf('--session-id') + 1]
    expect(sessionId).toBe(record.claudeSessionId)
    expect(host.pid(record.id)).not.toBeNull()
  })

  it('passes keystrokes to the session and a resize to its pty', async () => {
    const record = await host.start({ cwd: world.projects.beta, projectPath: world.projects.beta, name: 'beta', cols: 100, rows: 30 })
    await vi.waitFor(() => expect(output.get(record.id)).toContain('? for shortcuts'))

    host.input(record.id, 'hello\r')
    await vi.waitFor(() => expect(output.get(record.id)).toContain('You said: hello'))
    host.resize(record.id, 120, 40)

    await vi.waitFor(async () => {
      const run = await runIn(world.projects.beta)
      expect(run.received).toEqual(['hello'])
      expect(run.resized).toContainEqual({ cols: 120, rows: 40 })
    })
    expect(host.grid(record.id)).toEqual({ cols: 120, rows: 40 })
  })

  it('records how a session ended, with its exit code and how long it ran', async () => {
    const record = await host.start({ cwd: world.projects.alpha, projectPath: world.projects.alpha, name: 'alpha', cols: 80, rows: 24 })
    await vi.waitFor(() => expect(output.get(record.id)).toContain('? for shortcuts'))

    host.input(record.id, '/crash\r')
    await vi.waitFor(() => {
      const ended = host.list().find((s) => s.id === record.id)
      expect(ended?.status).toBe('exited')
      expect(ended?.exitCode).toBe(3)
      expect(ended?.durationMs).toBeGreaterThan(0)
    }, { timeout: 10_000 })
  })
})
