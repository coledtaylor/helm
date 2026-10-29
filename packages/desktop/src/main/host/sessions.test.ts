import { describe, expect, it } from 'vitest'
import type { SessionRecord } from '@helm/core'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import type { ConfirmRequest } from '../sessions'
import type * as P from './protocol'
import { CLAUDE_CODE_BACKEND, PLUGIN_START_REFUSED, PROFILE_REFUSED, createHostSessions } from './sessions'
import { createTerminalStreams } from './streams'

const ROW: P.SessionRecord = {
  id: 7,
  name: 'app',
  label: null,
  cwd: '/work/app',
  branch: 'main',
  projectPath: '/work/app',
  profileId: null,
  argv: ['claude', '-n', 'app'],
  conversationId: 'c0ffee00-0000-4000-8000-000000000001',
  backend: CLAUDE_CODE_BACKEND,
  status: 'running',
  startedAt: '2026-10-29T10:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null
}

const row = (overrides: Partial<P.SessionRecord> = {}): P.SessionRecord => ({ ...ROW, ...overrides })

interface World {
  connection: FakeConnection
  host: ReturnType<typeof createHostSessions>
  emitted: Array<{ channel: string; payload: unknown }>
  asked: ConfirmRequest[]
  notified: SessionRecord[]
  connect(): Promise<void>
  focused: { value: boolean }
}

function world(
  options: { agree?: boolean; listed?: P.SessionRecord[]; connection?: FakeConnection | null } = {}
): World {
  const connection = options.connection === undefined ? new FakeConnection() : options.connection
  connection?.answer('session:list', () => options.listed ?? [])
  const link = fakeLink(connection, 'Helm could not find the local host program at /nowhere/floti; turn it off.')
  const emitted: World['emitted'] = []
  const asked: ConfirmRequest[] = []
  const notified: SessionRecord[] = []
  const focused = { value: true }
  const streams = createTerminalStreams({
    connection: () => link.current(),
    deliver: (channel, id, data) => emitted.push({ channel, payload: { id, data } }),
    log: () => undefined
  })
  const host = createHostSessions({
    link,
    streams,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    confirm: (request) => {
      asked.push(request)
      return Promise.resolve(options.agree ?? true)
    },
    notify: (record) => notified.push(record),
    windowFocused: () => focused.value,
    layout: null,
    history: () => null,
    log: () => undefined
  })
  return {
    connection: connection ?? new FakeConnection(),
    host,
    emitted,
    asked,
    notified,
    focused,
    connect: () => link.connect()
  }
}

describe('sessions through the local host', () => {
  it('starts a session on the Claude Code backend in its folder and carries its terminal from the start', async () => {
    const w = world()
    w.connection.answer('session:start', () => row())
    const record = await w.host.sessions.start({ cwd: '/work/app', projectPath: '/work/app', cols: 100, rows: 30 })

    expect(w.connection.payloads('session:start')).toEqual([
      expect.objectContaining({
        cwd: '/work/app',
        projectPath: '/work/app',
        backend: CLAUDE_CODE_BACKEND,
        profileId: null,
        cols: 100,
        rows: 30
      })
    ])
    expect(record).toMatchObject({ id: 7, cwd: '/work/app', claudeSessionId: ROW.conversationId, status: 'running' })
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([7])

    const [stream] = w.connection.streamsFor('session:data', 7)
    expect(stream).toBeDefined()
    stream?.send('\x1b[1mhello\x1b[0m')
    expect(w.emitted).toContainEqual({ channel: 'session:data', payload: { id: 7, data: '\x1b[1mhello\x1b[0m' } })
  })

  it('types into a session in order and gives the host the pane size', async () => {
    const w = world()
    w.connection.answer('session:start', () => row())
    await w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })
    for (const key of ['h', 'i', '\r']) w.host.sessions.input(7, key)
    w.host.sessions.resize(7, 132, 40)

    expect(w.connection.streamsFor('session:data', 7)[0]?.text()).toBe('hi\r')
    expect(w.connection.payloads('session:resize')).toEqual([{ id: 7, cols: 132, rows: 40 }])
    expect(w.host.sessions.grid(7)).toEqual({ cols: 132, rows: 40 })
  })

  it('launches from the launcher with a folder, a permission mode and a conversation to reopen', async () => {
    const w = world()
    w.connection.answer('session:launch', () => ({
      session: row({ id: 8 }),
      overlays: [],
      composedInstructions: false,
      warnings: ['a warning'],
      notTaken: []
    }))
    const launched = await w.host.sessions.launch({
      cwd: '/work/app',
      profileId: null,
      permissionMode: 'plan',
      resume: 'c0ffee00-0000-4000-8000-000000000002',
      cols: 90,
      rows: 20
    })

    expect(w.connection.payloads('session:launch')).toEqual([
      {
        cwd: '/work/app',
        projectPath: null,
        name: null,
        profileId: null,
        permissionMode: 'plan',
        resume: 'c0ffee00-0000-4000-8000-000000000002',
        backend: CLAUDE_CODE_BACKEND,
        cols: 90,
        rows: 20
      }
    ])
    expect(launched).toEqual({
      session: expect.objectContaining({ id: 8 }),
      overlays: [],
      composedInstructions: false,
      warnings: ['a warning']
    })
    expect(w.connection.streamsFor('session:data', 8)).toHaveLength(1)
  })

  it('resumes a conversation from history through the host', async () => {
    const w = world()
    w.connection.answer('history:resume', () => ({
      session: row({ id: 9 }),
      history: { sessionId: 'c0ffee00-0000-4000-8000-000000000003' } as P.HistorySession
    }))
    const resumed = await w.host.sessions.resume({
      sessionId: 'c0ffee00-0000-4000-8000-000000000003',
      cols: 80,
      rows: 24
    })

    expect(w.connection.payloads('history:resume')).toEqual([
      { sessionId: 'c0ffee00-0000-4000-8000-000000000003', cols: 80, rows: 24 }
    ])
    expect(resumed.session.id).toBe(9)
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([9])
  })

  it('refuses a launch with a saved profile and a plugin starting a session, with one sentence each, and asks the host nothing', async () => {
    const w = world()
    await expect(
      w.host.sessions.launch({ cwd: '/work/app', profileId: 3, permissionMode: null, resume: null, cols: 80, rows: 24 })
    ).rejects.toThrow(PROFILE_REFUSED)
    await expect(w.host.sessions.launchProfile({ profileId: 3, cols: 80, rows: 24 })).rejects.toThrow(PROFILE_REFUSED)
    await expect(
      w.host.sessions.startWithPrompt({ cwd: '/work/app', name: 'x', prompt: 'hi', cols: 80, rows: 24 })
    ).rejects.toThrow(PLUGIN_START_REFUSED)
    expect(PROFILE_REFUSED).toMatch(/not available through the local host yet/)
    expect(PROFILE_REFUSED).toMatch(/Run sessions in the local host/)
    expect(w.connection.sent).toEqual([])
    expect(w.host.sessions.list()).toEqual([])
  })

  it('ends a session only once the user agrees, and then tells the host not to ask again', async () => {
    const w = world({ agree: true })
    w.connection.answer('session:start', () => row())
    w.connection.answer('session:close', () => ({ closed: true }))
    await w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })

    await expect(w.host.sessions.close({ id: 7 })).resolves.toEqual({ closed: true })
    expect(w.asked).toEqual([expect.objectContaining({ kind: 'close-session', confirmLabel: 'End session' })])
    expect(w.connection.payloads('session:close')).toEqual([{ id: 7, force: true }])
    expect(w.host.sessions.list()).toEqual([])
    expect(w.connection.streamsFor('session:data', 7)[0]?.closed).toBe(true)
  })

  it('keeps a session running when the user declines to end it', async () => {
    const w = world({ agree: false })
    w.connection.answer('session:start', () => row())
    await w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })

    await expect(w.host.sessions.close({ id: 7 })).resolves.toEqual({ closed: false })
    expect(w.connection.payloads('session:close')).toEqual([])
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([7])
    expect(w.host.sessions.runningCount()).toBe(1)
  })

  it('keeps an exited session’s tab until it is closed, and tells the window it exited', async () => {
    const w = world()
    w.connection.answer('session:start', () => row())
    await w.connect()
    await w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })
    w.connection.push('session:exit', row({ status: 'exited', exitCode: 0, endedAt: '2026-10-29T10:05:00.000Z' }))

    expect(w.emitted).toContainEqual({
      channel: 'session:exit',
      payload: expect.objectContaining({ id: 7, status: 'exited' })
    })
    expect(w.host.sessions.list()).toEqual([expect.objectContaining({ id: 7, status: 'exited' })])
    expect(w.host.sessions.runningCount()).toBe(0)

    // Closing an ended session's tab asks nobody and tells the host nothing.
    await w.host.sessions.close({ id: 7 })
    expect(w.asked).toEqual([])
    expect(w.connection.payloads('session:close')).toEqual([])
    expect(w.host.sessions.list()).toEqual([])
  })

  it('lists the host’s sessions when it connects and carries each running one’s terminal', async () => {
    const w = world({ listed: [row(), row({ id: 8, status: 'exited', exitCode: 1 })] })
    await w.connect()

    expect(w.host.sessions.list().map((session) => [session.id, session.status])).toEqual([
      [7, 'running'],
      [8, 'exited']
    ])
    expect(w.connection.streamsFor('session:data', 7)).toHaveLength(1)
    expect(w.connection.streamsFor('session:data', 8)).toHaveLength(0)
  })

  it('shows the notification the host sends for an exit nobody saw, and says what the window shows', async () => {
    const w = world({ listed: [row()] })
    await w.connect()
    w.host.sessions.setFocus([7])
    w.focused.value = false
    w.host.refocus()
    w.connection.push('session:notify', row({ status: 'exited', exitCode: 0 }))

    expect(w.connection.payloads('session:focus')).toEqual([{ ids: [] }, { ids: [7] }, { ids: [] }])
    expect(w.notified).toEqual([expect.objectContaining({ id: 7, status: 'exited' })])
  })

  it('passes the host’s activity and overview to the window in its own words', async () => {
    const w = world({ listed: [row()] })
    await w.connect()
    w.connection.snapshot('session:activity', [
      { id: 7, activity: 'busy', waitingFor: null, conversationId: ROW.conversationId }
    ])

    expect(w.host.activity.states()).toEqual([
      { id: 7, activity: 'busy', waitingFor: null, claudeSessionId: ROW.conversationId }
    ])
    expect(w.emitted).toContainEqual({ channel: 'session:activity', payload: w.host.activity.states() })
  })

  it('renames a tab at once and sends the host the trimmed label', async () => {
    const w = world({ listed: [row()] })
    await w.connect()
    w.connection.answer('session:rename', (request) => row({ label: request.label }))

    expect(w.host.sessions.rename({ id: 7, label: '  review  ' })).toMatchObject({ id: 7, label: 'review' })
    expect(w.connection.payloads('session:rename')).toEqual([{ id: 7, label: 'review' }])
  })

  it('offers back what the host lost and adopts what it reopens', async () => {
    const w = world()
    w.connection.answer('session:restorable', () => ({
      sessions: [
        {
          id: 7,
          name: 'app',
          cwd: '/work/app',
          branch: 'main',
          profile: null,
          profileGone: false,
          lastAt: 1,
          blocked: null
        }
      ],
      elsewhere: 0
    }))
    w.connection.answer('session:restore', () => ({
      restored: [
        {
          from: 7,
          launched: { session: row({ id: 12 }), overlays: [], composedInstructions: false, warnings: [], notTaken: [] }
        }
      ],
      failed: []
    }))

    await expect(w.host.restore.offer()).resolves.toMatchObject({
      sessions: [{ id: 7, cwd: '/work/app' }],
      layout: null
    })
    const result = await w.host.restore.restore({ sessions: [{ id: 7, cols: 80, rows: 24 }] })

    expect(w.connection.payloads('session:restore')).toEqual([{ sessions: [{ id: 7, cols: 80, rows: 24 }] }])
    expect(result.restored).toEqual([
      { from: 7, launched: expect.objectContaining({ session: expect.objectContaining({ id: 12 }) }) }
    ])
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([12])
    expect(w.connection.streamsFor('session:data', 12)).toHaveLength(1)
  })

  it('fails a start with the launcher’s sentence when there is no host program, and the rest keeps working', async () => {
    const w = world({ connection: null })

    await expect(w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })).rejects.toThrow(
      'Helm could not find the local host program at /nowhere/floti'
    )
    expect(w.host.sessions.list()).toEqual([])
    expect(w.host.sessions.runningCount()).toBe(0)
    await expect(w.host.sessions.settled()).resolves.toBeUndefined()
    await expect(w.host.restore.offer()).resolves.toBeNull()
    await expect(w.host.sessions.confirmCloseAll()).resolves.toBe(true)
  })
})
