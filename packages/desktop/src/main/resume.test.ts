import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import { appendPrompts, appendTranscript, claudeTree, sessionUuid, type ClaudeTree, type IpcHandler } from '../../test/history-fixture'
import type { HistoryIndex } from './history'
import type { IpcContext } from './ipc'
import type { SessionHost } from './sessions'
import type { Services } from './services'

const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
vi.mock('electron', async () => (await import('../../test/history-fixture')).electronRecordingIpc(handlers))

/**
 * Reopening a conversation from the history pane, through the `history:resume`
 * handler the window calls, against a real pty running the fake `claude`.
 */
describe('resuming a session from history', () => {
  const T0 = Date.UTC(2026, 8, 1, 9, 0, 0)
  let world: World
  let tree: ClaudeTree
  let services: Services
  let host: SessionHost
  let index: HistoryIndex

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
    const { createHistoryIndex } = await import('./history')
    const { registerIpc } = await import('./ipc')
    setClaudeOverride(world.claude)
    services = createServices()
    host = createSessionHost({ services, window: () => null, observer: { onOutput: () => undefined }, confirm: () => Promise.resolve(true) })
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
    disposeWorld(world)
  })

  const resume = (sessionId: string): Promise<unknown> => {
    const handler = handlers.get('history:resume')
    if (handler === undefined) throw new Error('history:resume is not registered')
    return Promise.resolve(handler({ sessionId, cols: 100, rows: 30 }))
  }

  it('refuses a session whose transcript was reaped, or whose folder is gone, and starts nothing', async () => {
    const reaped = sessionUuid(1)
    const moved = sessionUuid(2)
    const gone = join(world.root, 'deleted project')
    mkdirSync(gone)
    appendPrompts(tree, [
      { sessionId: reaped, project: world.projects.alpha, display: 'a conversation Claude Code reaped', at: T0 },
      { sessionId: moved, project: gone, display: 'a conversation in a deleted folder', at: T0 + 1000 }
    ])
    appendTranscript(tree, { sessionId: moved, cwd: gone }, [{ role: 'user', text: 'a conversation in a deleted folder', at: T0 }])
    rmSync(gone, { recursive: true })
    index.history.refresh()

    await expect(resume(reaped)).rejects.toThrow(/removed this conversation.s transcript/)
    await expect(resume(moved)).rejects.toThrow(/is no longer on disk/)
    await expect(resume(sessionUuid(99))).rejects.toThrow(/not in the history index/)

    expect(host.list()).toEqual([])
    expect(fakeClaudeLogs(world)).toEqual([])
  })

  it('runs claude --resume <id> with no -n, in the directory history recorded', async () => {
    const id = sessionUuid(3)
    appendPrompts(tree, [{ sessionId: id, project: world.projects.beta, display: 'sketch the migration', at: T0 + 2000 }])
    appendTranscript(tree, { sessionId: id, cwd: world.projects.beta }, [
      { role: 'user', text: 'sketch the migration', at: T0 + 2000 },
      { role: 'assistant', text: 'Three steps.', at: T0 + 3000 }
    ])
    index.history.refresh()

    const resumed = (await resume(id)) as { session: { claudeSessionId: string | null; label: string | null; name: string } }
    expect(resumed.session.claudeSessionId).toBe(id)

    let run: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      run = fakeClaudeLogs(world).find((log) => log.resumed)
      expect(run).toBeDefined()
    })
    const argv = (run as FakeClaudeLog).argv
    expect(argv[argv.indexOf('--resume') + 1]).toBe(id)
    for (const flag of ['-n', '--name', '--session-id']) expect(argv).not.toContain(flag)
    expect((run as FakeClaudeLog).cwd.toLowerCase()).toBe(world.projects.beta.toLowerCase())
    expect((run as FakeClaudeLog).sessionId).toBe(id)
  })
})
