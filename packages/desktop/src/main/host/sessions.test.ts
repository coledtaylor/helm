import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type SessionRecord } from '@helm/core'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import type { ConfirmRequest } from '../sessions'
import type * as P from './protocol'
import { HostRequestError } from './client'
import { CLAUDE_CODE_BACKEND, createHostSessions, hostSettingsFor } from './sessions'
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
  /** Whether Helm's browser tools are on in Settings. */
  browserTools: { value: boolean }
  /** The browser tool identities that ended, by key, in order. */
  identitiesEnded: string[]
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
  const browserTools = { value: true }
  const identitiesEnded: string[] = []
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
    // Helm knows one project, at /work/app.
    knownProject: (cwd) => (cwd.toLowerCase() === '/work/app' ? '/work/app' : null),
    history: () => null,
    browserTools: () => browserTools.value,
    browserIdentityEnded: (key) => identitiesEnded.push(key),
    log: () => undefined
  })
  return {
    connection: connection ?? new FakeConnection(),
    host,
    emitted,
    asked,
    notified,
    focused,
    browserTools,
    identitiesEnded,
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

  const PROFILE: P.Profile = {
    id: 3,
    name: 'hub dev',
    root: '/work/hub',
    overlays: ['/work/tools'],
    access: ['/work/tools'],
    model: 'sonnet',
    effort: 'high',
    permissionMode: 'acceptEdits',
    agent: 'reviewer',
    mcp: [],
    openingPrompt: '/recap',
    pinnedOrder: 0,
    createdAt: '2026-10-29T09:00:00.000Z',
    updatedAt: '2026-10-29T09:00:00.000Z'
  }

  /** The host's error reply, as the connection hands it to the caller. */
  const refusal = (channel: string, sentence: string): HostRequestError =>
    new HostRequestError(channel, 'failed', sentence)

  it('launches a saved profile in the host, which composes it, and reports what it composed', async () => {
    const w = world()
    w.connection.answer('profile:launch', () => ({
      session: row({ id: 11, name: 'hub dev', cwd: '/work/hub', profileId: 3 }),
      profile: PROFILE,
      overlays: ['tools'],
      composedInstructions: true,
      warnings: ['an overlay has no .claude folder']
    }))
    const launched = await w.host.sessions.launchProfile({ profileId: 3, cols: 100, rows: 30 })

    expect(w.connection.payloads('profile:launch')).toEqual([{ profileId: 3, cols: 100, rows: 30 }])
    expect(launched).toEqual({
      session: expect.objectContaining({ id: 11, name: 'hub dev', cwd: '/work/hub', profileId: 3 }),
      profile: { ...PROFILE },
      overlays: ['tools'],
      composedInstructions: true,
      warnings: ['an overlay has no .claude folder']
    })
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([11])
    expect(w.connection.streamsFor('session:data', 11)).toHaveLength(1)
  })

  it('launches from the launcher with a saved profile and the launcher’s permission mode, or none, in its folder', async () => {
    const w = world()
    w.connection.answer('session:launch', (request) => ({
      session: row({ id: request.permissionMode === null ? 13 : 12, profileId: request.profileId }),
      overlays: ['tools'],
      composedInstructions: true,
      warnings: [],
      notTaken: []
    }))
    await w.host.sessions.launch({ cwd: '/work/app', profileId: 3, permissionMode: 'plan', resume: null, cols: 80, rows: 24 })
    const unmoded = await w.host.sessions.launch({
      cwd: '/work/app',
      profileId: 3,
      permissionMode: null,
      resume: null,
      cols: 80,
      rows: 24
    })

    expect(w.connection.payloads('session:launch')).toEqual([
      expect.objectContaining({ cwd: '/work/app', profileId: 3, permissionMode: 'plan', resume: null }),
      expect.objectContaining({ cwd: '/work/app', profileId: 3, permissionMode: null, resume: null })
    ])
    expect(unmoded).toMatchObject({ session: { id: 13, profileId: 3 }, overlays: ['tools'], composedInstructions: true })
  })

  it('says the host’s sentence when the profile is gone, and nothing starts', async () => {
    const w = world()
    const gone = (channel: string) => () => {
      throw refusal(channel, 'That profile no longer exists.')
    }
    w.connection.answer('profile:launch', gone('profile:launch')).answer('session:launch', gone('session:launch'))

    await expect(w.host.sessions.launchProfile({ profileId: 3, cols: 80, rows: 24 })).rejects.toThrow(
      'That profile no longer exists.'
    )
    await expect(
      w.host.sessions.launch({ cwd: '/work/app', profileId: 3, permissionMode: null, resume: null, cols: 80, rows: 24 })
    ).rejects.toThrow('That profile no longer exists.')
    expect(w.host.sessions.list()).toEqual([])
    expect(w.connection.streams).toEqual([])
  })

  it('starts a plugin’s session in the host with the folder, name and first message the dialog showed, recorded as the project Helm knows there', async () => {
    const w = world()
    w.connection.answer('session:start', (request) => row({ id: 14, name: `${request.name ?? ''}-2`, cwd: request.cwd }))
    const record = await w.host.sessions.startWithPrompt({
      cwd: '/WORK/APP',
      name: 'review',
      prompt: 'Review the open pull request',
      cols: 120,
      rows: 40
    })
    await w.host.sessions.startWithPrompt({ cwd: '/work/elsewhere', name: 'notes', prompt: 'hi', cols: 80, rows: 24 })

    expect(w.connection.payloads('session:start')).toEqual([
      {
        cwd: '/WORK/APP',
        projectPath: '/work/app',
        name: 'review',
        backend: CLAUDE_CODE_BACKEND,
        profileId: null,
        overlays: null,
        extraFolders: null,
        model: null,
        effort: null,
        agent: null,
        permissionMode: null,
        openingPrompt: 'Review the open pull request',
        cols: 120,
        rows: 40
      },
      expect.objectContaining({ cwd: '/work/elsewhere', projectPath: null, name: 'notes', openingPrompt: 'hi' })
    ])
    // The name the host made unique is the one the tab shows.
    expect(record).toMatchObject({ id: 14, name: 'review-2', cwd: '/WORK/APP' })
    expect(w.host.sessions.list().map((session) => session.id)).toEqual([14])
  })

  it('fails a plugin’s session with the host’s sentence when the host cannot start it, and no tab appears', async () => {
    const w = world()
    w.connection.answer('session:start', () => {
      throw refusal('session:start', 'The folder /work/gone does not exist.')
    })
    await expect(
      w.host.sessions.startWithPrompt({ cwd: '/work/gone', name: 'x', prompt: 'hi', cols: 80, rows: 24 })
    ).rejects.toThrow('The folder /work/gone does not exist.')
    expect(w.host.sessions.list()).toEqual([])

    const hostless = world({ connection: null })
    await expect(
      hostless.host.sessions.startWithPrompt({ cwd: '/work/app', name: 'x', prompt: 'hi', cols: 80, rows: 24 })
    ).rejects.toThrow('Helm could not find the local host program at /nowhere/floti; turn it off.')
    expect(hostless.host.sessions.list()).toEqual([])
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

  it('counts nothing as running once Helm is quitting, so closing the window asks nothing more', async () => {
    const w = world()
    w.connection.answer('session:start', () => row())
    await w.connect()
    await w.host.sessions.start({ cwd: '/work/app', cols: 80, rows: 24 })
    w.host.sessions.shutdown()

    expect(w.host.sessions.runningCount()).toBe(0)
    expect(w.host.sessions.list()).toEqual([])
    await expect(w.host.sessions.confirmCloseAll()).resolves.toBe(true)
    expect(w.asked).toEqual([])
    expect(w.connection.streamsFor('session:data', 7)[0]?.closed).toBe(true)
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

  describe('the browser tools', () => {
    it('gives each running session an identity of its own while they are on: a key kept until it ends, and its label', async () => {
      const w = world({ listed: [row(), row({ id: 8, name: 'api', cwd: '/work/api' }), row({ id: 9, status: 'exited' })] })
      await w.connect()

      const app = w.host.sessions.browserOpener(7)
      const api = w.host.sessions.browserOpener(8)
      expect(app).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) as string, name: 'app' })
      expect(api?.name).toBe('api')
      expect(api?.key).not.toBe(app?.key)
      // Asked again, the same identity: a tab it opened stays its own.
      expect(w.host.sessions.browserOpener(7)).toEqual(app)
      // An ended session, and one the window does not know, have none.
      expect(w.host.sessions.browserOpener(9)).toBeNull()
      expect(w.host.sessions.browserOpener(10)).toBeNull()

      // The label is the tab's name now; the key does not move with it.
      w.connection.answer('session:rename', ({ id, label }) => row({ id, label }))
      w.host.sessions.rename({ id: 7, label: 'frontend' })
      expect(w.host.sessions.browserOpener(7)).toEqual({ key: app?.key, name: 'frontend' })

      // The share menu: every running session, by id and label.
      expect(w.host.sessions.browserSessions()).toEqual([
        { session: 7, name: 'frontend' },
        { session: 8, name: 'api' }
      ])
      // The host holds the token; no token answers here.
      expect(w.host.sessions.tokenHolder(app?.key ?? '')).toBeNull()
    })

    it('answers for no session and offers none to share with while the browser tools are off', async () => {
      const w = world({ listed: [row()] })
      await w.connect()
      w.browserTools.value = false
      expect(w.host.sessions.browserOpener(7)).toBeNull()
      expect(w.host.sessions.browserSessions()).toEqual([])

      w.browserTools.value = true
      expect(w.host.sessions.browserOpener(7)).not.toBeNull()
      expect(w.host.sessions.browserSessions()).toEqual([{ session: 7, name: 'app' }])
    })

    it('ends a session’s identity, and so its shares, when it exits, when its tab is closed and when Helm quits', async () => {
      const w = world({
        listed: [row(), row({ id: 8, name: 'api' }), row({ id: 9, name: 'docs' })]
      })
      await w.connect()
      const keyOf = (id: number): string => w.host.sessions.browserOpener(id)?.key ?? ''
      const [app, api, docs] = [keyOf(7), keyOf(8), keyOf(9)]

      w.connection.push('session:exit', row({ status: 'exited', exitCode: 0 }))
      expect(w.identitiesEnded).toEqual([app])
      expect(w.host.sessions.browserOpener(7)).toBeNull()
      expect(w.host.sessions.browserSessions().map((share) => share.session)).toEqual([8, 9])

      await w.host.sessions.close({ id: 8 })
      expect(w.identitiesEnded).toEqual([app, api])
      expect(w.host.sessions.browserOpener(8)).toBeNull()

      w.host.sessions.shutdown()
      expect(w.identitiesEnded).toEqual([app, api, docs])
    })

    it('mints nothing for a session that was never asked about, and ends nothing for it', async () => {
      const w = world({ listed: [row()] })
      await w.connect()
      w.connection.push('session:exit', row({ status: 'exited', exitCode: 0 }))
      expect(w.identitiesEnded).toEqual([])
    })
  })

  describe('the plugins’ tools', () => {
    it('gives each running session an id of its own for plugins, apart from its browser key, with its label and folder', async () => {
      const w = world({ listed: [row(), row({ id: 8, name: 'api', cwd: '/work/api' }), row({ id: 9, status: 'exited' })] })
      await w.connect()

      const app = w.host.pluginCaller(7)
      const api = w.host.pluginCaller(8)
      expect(app).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) as string, name: 'app', cwd: '/work/app' })
      expect(api).toMatchObject({ name: 'api', cwd: '/work/api' })
      expect(api?.id).not.toBe(app?.id)
      // Not the host's row id, and not the session's browser identity.
      expect(app?.id).not.toBe('7')
      expect(app?.id).not.toBe(w.host.sessions.browserOpener(7)?.key)
      // Asked again, the same id: a plugin can tell its calls apart by session.
      expect(w.host.pluginCaller(7)).toEqual(app)
      // An ended session, and one the window does not know, are nobody.
      expect(w.host.pluginCaller(9)).toBeNull()
      expect(w.host.pluginCaller(10)).toBeNull()
    })

    it('drops a session’s id when it exits, when its tab is closed and when Helm quits', async () => {
      const w = world({ listed: [row(), row({ id: 8, name: 'api' }), row({ id: 9, name: 'docs' })] })
      await w.connect()
      const before = [7, 8, 9].map((id) => w.host.pluginCaller(id)?.id)

      w.connection.push('session:exit', row({ status: 'exited', exitCode: 0 }))
      expect(w.host.pluginCaller(7)).toBeNull()
      await w.host.sessions.close({ id: 8 })
      expect(w.host.pluginCaller(8)).toBeNull()
      // A session still running keeps its id until Helm quits.
      expect(w.host.pluginCaller(9)?.id).toBe(before[2])
      w.host.sessions.shutdown()
      expect(w.host.pluginCaller(9)).toBeNull()
    })
  })

  describe('the settings the host is given', () => {
    it('writes the claude, the shell, whether the browser tools are on and held to this machine, and whether the session tools are on', () => {
      expect(
        hostSettingsFor(
          {
            ...DEFAULT_SETTINGS,
            claudePath: null,
            terminalShell: 'pwsh',
            browserMcp: false,
            browserMcpLocalOnly: true,
            sessionMcp: false
          },
          '/bin/claude'
        )
      ).toEqual({
        backendPaths: { [CLAUDE_CODE_BACKEND]: '/bin/claude' },
        terminalShell: 'pwsh',
        browserMcp: false,
        browserMcpLocalOnly: true,
        sessionMcp: false
      })
      expect(
        hostSettingsFor({ ...DEFAULT_SETTINGS, browserMcp: true, browserMcpLocalOnly: false, sessionMcp: true }, null)
      ).toMatchObject({ browserMcp: true, browserMcpLocalOnly: false, sessionMcp: true })
    })
  })
})
