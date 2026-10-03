import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createProfile,
  deleteProfile,
  noteConversation,
  openStore,
  readSessionRegistry,
  readSessions,
  sessionRegistryDir,
  startSession,
  writeSettings,
  type RestoreOffer,
  type SavedPaneLayout
} from '@helm/core'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import { appendPrompts, appendTranscript, claudeTree, sessionUuid, type IpcHandler } from '../../test/history-fixture'
import type { HistoryIndex } from './history'
import type { IpcContext } from './ipc'
import type { SessionHost } from './sessions'
import type { Services } from './services'
import type { RestoreSessionsRequest, RestoreSessionsResult } from '../shared/ipc'

const handlers = vi.hoisted(() => new Map<string, IpcHandler>())
vi.mock('electron', async () => (await import('../../test/history-fixture')).electronRecordingIpc(handlers))

/**
 * After a crash, through the two channels the window calls. The database is
 * left the way a run that died leaves it - rows still claiming to be running,
 * and the panes it last wrote naming them - and the app is then started over it
 * against the fake `claude`.
 */
describe('restoring what a crash took', () => {
  const T0 = Date.UTC(2026, 9, 2, 9, 0, 0)
  const STARTED = sessionUuid(1)
  const CLEARED_TO = sessionUuid(2)
  const PLAIN = sessionUuid(3)
  const QUIET = sessionUuid(4)
  const ELSEWHERE = sessionUuid(5)

  let world: World
  let services: Services
  let host: SessionHost
  let index: HistoryIndex
  let layout: SavedPaneLayout
  const ids = { cleared: 0, plain: 0, quiet: 0, elsewhere: 0 }

  beforeAll(async () => {
    world = createWorld()
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']
    const { alpha, beta } = world.projects
    const tree = claudeTree(world.claudeDir)

    // The run that died.
    const store = openStore({ file: join(world.dataDir, 'helm.db') })
    try {
      const kit = createProfile(store, {
        name: 'kit',
        root: alpha,
        overlays: [],
        access: [],
        model: 'sonnet',
        effort: null,
        permissionMode: 'auto',
        agent: null,
        mcp: [],
        openingPrompt: null,
        pinnedOrder: null
      })
      const gone = createProfile(store, { ...kit, name: 'gone', pinnedOrder: null })
      const cleared = startSession(store, {
        name: 'alpha',
        cwd: alpha,
        branch: 'main',
        projectPath: alpha,
        profileId: kit.id,
        claudeSessionId: STARTED,
        permissionMode: 'plan'
      })
      // Somebody typed /clear in it, and the poller wrote down where it went.
      noteConversation(store, cleared.id, CLEARED_TO)
      const plain = startSession(store, { name: 'beta', cwd: beta, projectPath: beta, profileId: gone.id, claudeSessionId: PLAIN })
      const quiet = startSession(store, { name: 'alpha 2', cwd: alpha, projectPath: alpha, claudeSessionId: QUIET })
      const elsewhere = startSession(store, { name: 'beta 2', cwd: beta, projectPath: beta, claudeSessionId: ELSEWHERE })
      deleteProfile(store, gone.id)
      store.raw.prepare("UPDATE sessions SET label = 'schema work' WHERE id = ?").run(cleared.id)
      Object.assign(ids, { cleared: cleared.id, plain: plain.id, quiet: quiet.id, elsewhere: elsewhere.id })

      layout = {
        groups: [
          { panes: [{ kind: 'session', id: cleared.id }, { kind: 'history' }], activeId: 'history' },
          {
            panes: [
              { kind: 'session', id: quiet.id },
              { kind: 'session', id: plain.id },
              { kind: 'session', id: elsewhere.id }
            ],
            activeId: `session:${String(plain.id)}`
          }
        ],
        focused: 1
      }
      writeSettings(store, {
        scanRoots: [world.projectsDir],
        claudePath: world.claude,
        updateCheck: false,
        firstRunCompletedAt: new Date(T0).toISOString(),
        paneLayout: layout
      })
    } finally {
      store.close()
    }

    // What Claude Code had recorded. Nothing was ever said in the quiet one.
    appendPrompts(tree, [
      { sessionId: STARTED, project: alpha, display: 'draft the schema', at: T0 },
      { sessionId: CLEARED_TO, project: alpha, display: 'now the migration', at: T0 + 60_000 },
      { sessionId: PLAIN, project: beta, display: 'fix the export', at: T0 + 30_000 },
      { sessionId: ELSEWHERE, project: beta, display: 'still going', at: T0 + 90_000 }
    ])
    for (const [sessionId, cwd] of [
      [STARTED, alpha],
      [CLEARED_TO, alpha],
      [PLAIN, beta],
      [ELSEWHERE, beta]
    ] as const) {
      appendTranscript(tree, { sessionId, cwd }, [{ role: 'user', text: 'hello', at: T0 }])
    }
    // One of them is still running - in a terminal, or another Helm.
    mkdirSync(join(world.claudeDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(world.claudeDir, 'sessions', `${String(process.pid)}.json`),
      JSON.stringify({ pid: process.pid, sessionId: ELSEWHERE, cwd: beta, startedAt: Date.now() - 5_000, status: 'idle' })
    )

    // The next start.
    const { createServices } = await import('./services')
    const { createSessionHost } = await import('./sessions')
    const { setClaudeOverride } = await import('./claude-cli')
    const { createHistoryIndex } = await import('./history')
    const { createRestoreService } = await import('./restore')
    const { registerIpc } = await import('./ipc')
    setClaudeOverride(world.claude)
    services = createServices()
    host = createSessionHost({ services, window: () => null, confirm: () => Promise.resolve(true) })
    index = createHistoryIndex({
      store: services.store,
      maxBytes: () => services.settings.transcriptArchiveMaxBytes,
      onHistoryChange: () => undefined,
      onArchiveChange: () => undefined
    })
    const restore = createRestoreService({
      lost: services.lost,
      store: services.store,
      sessions: host,
      refreshHistory: () => {
        index.history.refresh()
      },
      liveConversations: () =>
        new Set(readSessionRegistry(sessionRegistryDir(world.claudeDir)).flatMap((e) => (e.sessionId === null ? [] : [e.sessionId])))
    })
    registerIpc({
      services,
      window: () => null,
      sessions: host,
      restore,
      history: index.history,
      archive: index.archive,
      themes: { onChange: () => undefined }
    } as unknown as IpcContext)
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
    await vi.waitFor(() => disposeWorld(world), { timeout: 15_000, interval: 250 })
  })

  const call = async <T>(channel: string, payload?: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`${channel} is not registered`)
    return (await handler(payload)) as T
  }

  const runIn = async (sessionId: string): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.sessionId === sessionId)
      expect(found).toBeDefined()
    }, { timeout: 10_000 })
    return found as FakeClaudeLog
  }

  const after = (argv: readonly string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

  it('marks what was running lost on the way in, with the panes that run last wrote', () => {
    expect(services.lost.sessions.map((lost) => [lost.record.id, lost.conversationId, lost.permissionMode])).toEqual([
      [ids.cleared, CLEARED_TO, 'plan'],
      [ids.plain, PLAIN, null],
      [ids.quiet, QUIET, null],
      [ids.elsewhere, ELSEWHERE, null]
    ])
    expect(services.lost.layout).toEqual(layout)
    expect(readSessions(services.store, { status: 'running' })).toEqual([])
  })

  it('offers them in tab order, says why one cannot come back, and leaves a running one alone', async () => {
    const offer = await call<RestoreOffer | null>('session:restorable')
    expect(offer).toEqual({
      sessions: [
        {
          id: ids.cleared,
          name: 'schema work',
          cwd: world.projects.alpha,
          branch: 'main',
          profile: 'kit',
          profileGone: false,
          // The conversation it was in at the end, not the one it began.
          lastAt: T0 + 60_000,
          blocked: null
        },
        expect.objectContaining({ id: ids.quiet, name: 'alpha 2', blocked: 'Claude Code has no record of a conversation in it to reopen.' }),
        expect.objectContaining({ id: ids.plain, name: 'beta', profile: null, profileGone: true, lastAt: T0 + 30_000, blocked: null })
      ],
      elsewhere: 1,
      layout
    })
  })

  it('reopens each in its own folder, profile and mode, under its tab’s name, and answers the offer', async () => {
    const request: RestoreSessionsRequest = {
      sessions: [
        { id: ids.cleared, cols: 100, rows: 30 },
        { id: ids.quiet, cols: 90, rows: 30 },
        { id: ids.plain, cols: 90, rows: 30 },
        { id: ids.elsewhere, cols: 90, rows: 30 }
      ]
    }
    const result = await call<RestoreSessionsResult>('session:restore', request)

    expect(result.restored.map((r) => [r.from, r.launched.session.name, r.launched.session.claudeSessionId])).toEqual([
      [ids.cleared, 'schema work', CLEARED_TO],
      [ids.plain, 'beta', PLAIN]
    ])
    expect(result.failed).toEqual([
      { id: ids.quiet, name: 'alpha 2', reason: 'Claude Code has no record of a conversation in it to reopen.' },
      { id: ids.elsewhere, name: `Session ${String(ids.elsewhere)}`, reason: 'It was not one of the sessions offered.' }
    ])
    expect(result.restored[1]?.launched.warnings).toEqual([
      'The profile beta was started with no longer exists, so it reopened without one.'
    ])

    const cleared = await runIn(CLEARED_TO)
    expect(cleared.resumed).toBe(true)
    expect(cleared.cwd.toLowerCase()).toBe(world.projects.alpha.toLowerCase())
    expect(after(cleared.argv, '--resume')).toBe(CLEARED_TO)
    expect(after(cleared.argv, '--permission-mode')).toBe('plan')
    expect(after(cleared.argv, '--model')).toBe('sonnet')
    for (const flag of ['-n', '--session-id']) expect(cleared.argv).not.toContain(flag)

    const plain = await runIn(PLAIN)
    expect(plain.cwd.toLowerCase()).toBe(world.projects.beta.toLowerCase())
    expect(plain.argv).not.toContain('--permission-mode')
    expect(plain.argv).not.toContain('--model')

    // The reopened rows carry what the next crash would need.
    expect(result.restored[0]?.launched.session).toMatchObject({ profileId: expect.any(Number), cwd: world.projects.alpha })
    const mode = services.store.raw
      .prepare('SELECT permission_mode AS mode FROM sessions WHERE id = ?')
      .get(result.restored[0]?.launched.session.id) as { mode: string | null }
    expect(mode.mode).toBe('plan')

    expect(await call('session:restorable')).toBeNull()
    await expect(call('session:restore', { sessions: [] })).rejects.toThrow('already been answered')
  })

  it('takes "not now" as an answer, and offers nothing after it', async () => {
    const { createRestoreService } = await import('./restore')
    const restore = vi.fn()
    const offerOnce = createRestoreService({
      lost: services.lost,
      store: services.store,
      sessions: { restore },
      refreshHistory: () => undefined,
      liveConversations: () => new Set()
    })
    expect(offerOnce.offer()?.sessions).toHaveLength(4)
    expect(await offerOnce.restore({ sessions: [] })).toEqual({ restored: [], failed: [] })
    expect(offerOnce.offer()).toBeNull()
    expect(restore).not.toHaveBeenCalled()
  })
})
