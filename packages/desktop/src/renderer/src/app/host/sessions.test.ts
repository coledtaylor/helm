import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../../test/fake-connection'
import { CLAUDE_CODE_BACKEND } from '../../../../shared/host/backend'
import { HostRefusedError, type HostConnection } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type {
  EventChannel,
  EventPayload,
  HelmBridge,
  RequestChannel,
  RequestPayload,
  RequestResult,
  SendChannel,
  SendPayload,
  SessionConfirmRequest
} from '../../../../shared/ipc'
import type { HostAdapter } from './router'
import { createSessionsAdapters } from './sessions'

const UNREACHABLE = 'No local host answered on its socket.'

const ROW: P.SessionRecord = {
  id: 7,
  name: 'app',
  label: null,
  cwd: '/work dir/app',
  branch: 'main',
  projectPath: '/work dir/app',
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

/** Lets every promise already settled run its callbacks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** The preload's bridge as main would answer it: what the window sent, and events main pushes. */
function ownBridge() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const own = {
    invoke: (channel: string) =>
      channel === 'windowSessions:lostLayout' ? Promise.resolve(null) : Promise.reject(new Error(`no ${channel}`)),
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set()
      set.add(listener)
      listeners.set(channel, set)
      return () => set.delete(listener)
    }
  } as unknown as HelmBridge
  const push = <K extends EventChannel>(channel: K, payload: EventPayload<K>): void => {
    for (const listener of listeners.get(channel) ?? []) listener(payload)
  }
  return { own, sent, push }
}

interface Shelf {
  text: string | null
}

function world(options: { connection?: FakeConnection | null; listed?: P.SessionRecord[]; shelf?: Shelf } = {}) {
  const connection = options.connection === undefined ? new FakeConnection() : options.connection
  connection?.answer('session:list', () => options.listed ?? []).answer('session:start', () => row())
  const link = fakeReach(connection, UNREACHABLE)
  const bridge = ownBridge()
  const front = { value: true, listeners: [] as Array<() => void> }
  const shelf = options.shelf ?? { text: null }
  const adapters = createSessionsAdapters({
    link,
    own: bridge.own,
    front: { focused: () => front.value, onChange: (listener) => front.listeners.push(listener) },
    shelf: {
      read: () => shelf.text,
      write: (text) => {
        shelf.text = text
      }
    }
  })
  const setFront = (value: boolean): void => {
    front.value = value
    for (const listener of front.listeners) listener()
  }
  return { connection: connection ?? new FakeConnection(), link, adapters, bridge, setFront, shelf }
}

function routeOf<T>(adapters: HostAdapter[], kind: 'requests' | 'sends' | 'events', channel: string): T {
  for (const adapter of adapters) {
    const route = (adapter[kind] as Record<string, unknown> | undefined)?.[channel]
    if (route !== undefined) return route as T
  }
  throw new Error(`no route for ${channel}`)
}

const ask = <K extends RequestChannel>(adapters: HostAdapter[], channel: K, payload?: RequestPayload<K>) =>
  routeOf<(payload: unknown) => Promise<RequestResult<K>>>(adapters, 'requests', channel)(payload)

const send = <K extends SendChannel>(adapters: HostAdapter[], channel: K, payload: SendPayload<K>): void => {
  routeOf<(payload: unknown) => void>(adapters, 'sends', channel)(payload)
}

function hear<K extends EventChannel>(adapters: HostAdapter[], channel: K): Array<EventPayload<K>> {
  const heard: Array<EventPayload<K>> = []
  routeOf<(listener: (payload: EventPayload<K>) => void) => () => void>(adapters, 'events', channel)((payload) =>
    heard.push(payload)
  )
  return heard
}

describe('sessions over the window’s own connection', () => {
  it('starts a session on the host and carries its terminal both ways on a stream of the window’s own', async () => {
    const { adapters, connection } = world()
    const data = hear(adapters, 'session:data')
    const started = await ask(adapters, 'session:start', { cwd: '/work dir/app', projectPath: '/work dir/app', cols: 100, rows: 30 })
    expect(started).toMatchObject({ id: 7, status: 'running' })
    expect(connection.payloads('session:start')).toEqual([
      expect.objectContaining({ cwd: '/work dir/app', backend: CLAUDE_CODE_BACKEND, cols: 100, rows: 30 })
    ])
    const [stream] = connection.streamsFor('session:data', 7)
    stream?.send('hello ')
    stream?.send(new Uint8Array([0xe2, 0x9c]))
    stream?.send(new Uint8Array([0x93]))
    expect(data).toEqual([
      { id: 7, data: 'hello ' },
      { id: 7, data: '✓' }
    ])
    send(adapters, 'session:input', { id: 7, data: 'ls\r' })
    expect(stream?.text()).toBe('ls\r')
  })

  it('draws each running session with a tab in a page that has just loaded from a new stream, which starts with the host’s redraw', async () => {
    const { adapters, connection } = world({ listed: [row(), row({ id: 8, status: 'exited', exitCode: 0 })] })
    const data = hear(adapters, 'session:data')
    await expect(ask(adapters, 'session:list')).resolves.toEqual([
      expect.objectContaining({ id: 7, status: 'running' }),
      expect.objectContaining({ id: 8, status: 'exited' })
    ])
    adapters.show([7, 8])
    expect(connection.streamsFor('session:data', 7)).toHaveLength(1)
    expect(connection.streamsFor('session:data', 8)).toHaveLength(0)
    connection.streamsFor('session:data', 7)[0]?.send('\x1b[H\x1b[2Jscreen as it is')
    expect(data).toEqual([{ id: 7, data: '\x1b[H\x1b[2Jscreen as it is' }])
  })

  it('asks in the window before a running session’s tab closes, then tells the host to end it without asking again', async () => {
    const { adapters, connection } = world({ listed: [row()] })
    const questions = hear(adapters, 'session:confirm')
    await ask(adapters, 'session:list')
    adapters.show([7])
    const closing = ask(adapters, 'session:close', { id: 7 })
    await settle()
    expect(questions).toEqual([
      expect.objectContaining({
        kind: 'close-session',
        message: '“app” is still running on this PC’s host.',
        sessionNames: ['app']
      })
    ])
    expect(connection.payloads('session:close')).toEqual([])
    send(adapters, 'session:confirmed', { id: (questions[0] as SessionConfirmRequest).id, agreed: true })
    await expect(closing).resolves.toEqual({ closed: true })
    expect(connection.payloads('session:close')).toEqual([{ id: 7, force: true }])
    expect(connection.streamsFor('session:data', 7)[0]?.closed).toBe(true)
  })

  it('ends a session on a force close that keeps its record, asks nothing, and tells the window how it ended on the host’s exit', async () => {
    const { adapters, connection } = world({ listed: [row({ id: 8, name: 'reviewer', parentId: 7 })] })
    const questions = hear(adapters, 'session:confirm')
    const exits = hear(adapters, 'session:exit')
    await ask(adapters, 'session:list')
    adapters.show([8])
    await expect(ask(adapters, 'session:close', { id: 8, force: true, keep: true })).resolves.toEqual({ closed: true })
    expect(questions).toEqual([])
    expect(connection.payloads('session:close')).toEqual([{ id: 8, force: true }])

    // The record stays, and the host's finished row (which says it was stopped) replaces it.
    await expect(ask(adapters, 'session:list')).resolves.toEqual([expect.objectContaining({ id: 8, status: 'running' })])
    connection.push('session:exit', row({ id: 8, status: 'exited', exitCode: null, stopped: true, endedAt: '2026-10-29T10:05:00.000Z' }))
    expect(exits).toEqual([expect.objectContaining({ id: 8, status: 'exited', stopped: true })])
    await expect(ask(adapters, 'session:list')).resolves.toEqual([
      expect.objectContaining({ id: 8, status: 'exited', stopped: true })
    ])
  })

  it('keeps a session running when the user declines in the window, and tells the host nothing', async () => {
    const { adapters, connection } = world({ listed: [row()] })
    const questions = hear(adapters, 'session:confirm')
    await ask(adapters, 'session:list')
    const closing = ask(adapters, 'session:close', { id: 7 })
    await settle()
    send(adapters, 'session:confirmed', { id: (questions[0] as SessionConfirmRequest).id, agreed: false })
    await expect(closing).resolves.toEqual({ closed: false })
    expect(connection.payloads('session:close')).toEqual([])
    await expect(ask(adapters, 'session:list')).resolves.toHaveLength(1)
  })

  it('tells the host what is on screen only while the window is in front, and hands main the host’s word on an exit nobody saw', async () => {
    const { adapters, connection, setFront, bridge } = world({ listed: [row()] })
    const exits = hear(adapters, 'session:exit')
    await ask(adapters, 'session:list')
    adapters.show([7])
    send(adapters, 'session:focus', { ids: [7] })
    setFront(false)
    setFront(true)
    expect(connection.payloads('session:focus')).toEqual([{ ids: [] }, { ids: [7] }, { ids: [] }, { ids: [7] }])

    const ended = row({ status: 'exited', exitCode: 1, endedAt: '2026-10-29T10:05:00.000Z' })
    connection.push('session:exit', ended)
    connection.push('session:notify', ended)
    expect(exits).toEqual([expect.objectContaining({ id: 7, status: 'exited', exitCode: 1 })])
    expect(bridge.sent).toEqual([
      { channel: 'windowSessions:notify', payload: expect.objectContaining({ id: 7, exitCode: 1 }) }
    ])
    expect(connection.streamsFor('session:data', 7)[0]?.closed).toBe(true)
  })

  it('brings a session’s tab forward when its notification is clicked, and when the host says so', async () => {
    const { adapters, connection, bridge } = world()
    const activated = hear(adapters, 'session:activate')
    await ask(adapters, 'session:list')
    bridge.push('windowSessions:activate', { id: 7 })
    connection.push('session:activate', { id: 9 })
    expect(activated).toEqual([{ id: 7 }, { id: 9 }])
  })

  it('asks main’s question before quitting in the window, and gives main the answer', async () => {
    const { adapters, bridge } = world()
    const questions = hear(adapters, 'session:confirm')
    const quitQuestion = (id: number): SessionConfirmRequest => ({
      id,
      kind: 'quit',
      message: 'Quitting Helm ends 2 sessions on this PC’s host.',
      detail: 'End and quit stops them.',
      confirmLabel: 'End and quit',
      keepLabel: 'Keep running and quit',
      sessionNames: ['app', 'api']
    })
    bridge.push('windowSessions:quitConfirm', quitQuestion(41))
    bridge.push('windowSessions:quitConfirm', quitQuestion(42))
    bridge.push('windowSessions:quitConfirm', quitQuestion(43))
    expect(questions).toEqual([
      expect.objectContaining({ kind: 'quit', confirmLabel: 'End and quit', keepLabel: 'Keep running and quit' }),
      expect.anything(),
      expect.anything()
    ])
    const [end, keep, cancel] = questions as SessionConfirmRequest[]
    send(adapters, 'session:confirmed', { id: (end as SessionConfirmRequest).id, agreed: true })
    send(adapters, 'session:confirmed', { id: (keep as SessionConfirmRequest).id, agreed: false, keep: true })
    send(adapters, 'session:confirmed', { id: (cancel as SessionConfirmRequest).id, agreed: false })
    expect(bridge.sent).toEqual([
      { channel: 'windowSessions:quitConfirmed', payload: { id: 41, answer: 'end' } },
      { channel: 'windowSessions:quitConfirmed', payload: { id: 42, answer: 'keep' } },
      { channel: 'windowSessions:quitConfirmed', payload: { id: 43, answer: 'cancel' } }
    ])
  })

  it('lists a session started outside this window once the host’s activity moves, and carries none it has no tab for', async () => {
    const connection = new FakeConnection()
    const { adapters, bridge } = world({ connection })
    await ask(adapters, 'session:list')
    connection.answer('session:list', () => [row({ id: 12, name: 'from another device' })])
    connection.push('session:activity', [])
    await settle()
    await expect(ask(adapters, 'session:list')).resolves.toEqual([expect.objectContaining({ id: 12 })])
    expect(connection.streamsFor('session:data', 12)).toHaveLength(0)
    // Nobody here is watching it, so its exit is nobody's notification here.
    connection.push('session:notify', row({ id: 12, status: 'exited', exitCode: 0 }))
    expect(bridge.sent).toEqual([])
  })

  it('answers the window’s list with the session the host’s activity just named, however soon the window asks', async () => {
    const connection = new FakeConnection()
    const { adapters } = world({ connection })
    await ask(adapters, 'session:list')
    connection.answer('session:list', () => [row({ id: 12, name: 'mapper', parentId: 7, parentName: 'app' })])
    const heard = hear(adapters, 'session:activity')
    // The window asks as the push reaches it, before any pass of the event loop.
    const answered = new Promise<unknown>((resolve) => {
      routeOf<(listener: () => void) => () => void>(adapters, 'events', 'session:activity')(() => {
        resolve(ask(adapters, 'session:list'))
      })
    })
    connection.push('session:activity', [])
    await expect(answered).resolves.toEqual([expect.objectContaining({ id: 12, parentId: 7 })])
    expect(heard).toHaveLength(1)
  })

  it('takes a child’s report from the host’s listing as it comes and goes, and leaves the rest of its row as the window has it', async () => {
    const connection = new FakeConnection()
    const child = { id: 12, name: 'mapper', parentId: 7, parentName: 'app' }
    const { adapters } = world({ connection, listed: [row(child)] })
    const listed = async () => (await ask(adapters, 'session:list')).find((each) => each.id === 12)
    const relisted = async (rows: P.SessionRecord[]) => {
      connection.answer('session:list', () => rows)
      connection.push('session:activity', [])
      await settle()
    }
    expect(await listed()).not.toHaveProperty('lastReport')

    const lastReport = { state: 'done', text: 'Two bugs in ledger.rs.', at: '2026-11-06T10:00:00.000Z' }
    await relisted([row({ ...child, lastReport })])
    expect(await listed()).toMatchObject({ id: 12, name: 'mapper', parentId: 7, lastReport })

    // The child's next turn started: the host lists it without the report.
    await relisted([row(child)])
    expect(await listed()).not.toHaveProperty('lastReport')
  })

  it('opens a session it had no tab for on a new stream that starts with its screen, and lets it go again when its tab closes and it keeps running', async () => {
    const { adapters, connection } = world({ listed: [row(), row({ id: 9, name: 'api' })] })
    const data = hear(adapters, 'session:data')
    await ask(adapters, 'session:list')
    adapters.show([7])
    expect(connection.streamsFor('session:data', 7)).toHaveLength(1)
    expect(connection.streamsFor('session:data', 9)).toHaveLength(0)

    adapters.show([7, 9])
    adapters.show([7, 9])
    expect(connection.streamsFor('session:data', 7)).toHaveLength(1)
    expect(connection.streamsFor('session:data', 9)).toHaveLength(1)
    connection.streamsFor('session:data', 9)[0]?.send('\x1b[H\x1b[2Japi as it is')
    expect(data).toEqual([{ id: 9, data: '\x1b[H\x1b[2Japi as it is' }])

    send(adapters, 'session:focus', { ids: [9] })
    adapters.release(9)
    expect(connection.streamsFor('session:data', 9)[0]?.closed).toBe(true)
    // Kept running: the host is not asked to end it, and it is still listed.
    expect(connection.payloads('session:close')).toEqual([])
    expect(connection.payloads('session:focus').at(-1)).toEqual({ ids: [] })
    await expect(ask(adapters, 'session:list')).resolves.toEqual([
      expect.objectContaining({ id: 7 }),
      expect.objectContaining({ id: 9, status: 'running' })
    ])

    // Opened here again, it is drawn afresh from a new stream.
    adapters.show([7, 9])
    expect(connection.streamsFor('session:data', 9)).toHaveLength(2)
  })

  it('lets go of a session the last show named and this one leaves out, ending nothing on the host', async () => {
    const { adapters, connection } = world({ listed: [row(), row({ id: 9, name: 'api' }), row({ id: 10, name: 'docs' })] })
    await ask(adapters, 'session:list')
    adapters.show([7, 9])
    send(adapters, 'session:focus', { ids: [9] })
    adapters.show([7, 10])
    expect(connection.streamsFor('session:data', 9)[0]?.closed).toBe(true)
    expect(connection.payloads('session:focus').at(-1)).toEqual({ ids: [] })
    expect(connection.streamsFor('session:data', 7)[0]?.closed).toBe(false)
    expect(connection.streamsFor('session:data', 10)).toHaveLength(1)

    // Shown again, it is drawn afresh from a new stream.
    adapters.show([7, 9])
    expect(connection.streamsFor('session:data', 9)).toHaveLength(2)
    expect(connection.streamsFor('session:data', 10)[0]?.closed).toBe(true)

    adapters.show([])
    expect(connection.streamsFor('session:data', 7)[0]?.closed).toBe(true)
    expect(connection.streamsFor('session:data', 9)[1]?.closed).toBe(true)
    expect(connection.payloads('session:close')).toEqual([])
  })

  it('carries a session this window started from the start, before the window has said it has a tab', async () => {
    const { adapters, connection } = world()
    await ask(adapters, 'session:start', { cwd: '/work dir/app', projectPath: '/work dir/app', cols: 100, rows: 30 })
    expect(connection.streamsFor('session:data', 7)).toHaveLength(1)
  })

  it('says the link’s sentence when the host cannot be reached, never no sessions or no processes', async () => {
    const { adapters } = world({ connection: null })
    await expect(ask(adapters, 'session:list')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapters, 'sessions:resources')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapters, 'session:activity')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapters, 'session:restorable')).resolves.toBeNull()
  })

  it('opens each running session’s stream again on a new connection, so its screen is drawn afresh', async () => {
    const first = new FakeConnection().answer('session:list', () => [row()])
    const link = reconnectingReach(first)
    const { own } = ownBridge()
    const adapters = createSessionsAdapters({ link, own, front: { focused: () => true, onChange: () => undefined }, shelf: null })
    await ask(adapters, 'session:list')
    adapters.show([7])
    expect(first.streamsFor('session:data', 7)).toHaveLength(1)
    const second = new FakeConnection().answer('session:list', () => [row()])
    first.streamsFor('session:data', 7)[0]?.end('The connection to the local host was closed.')
    await link.reconnect(second)
    await settle()
    expect(second.streamsFor('session:data', 7)).toHaveLength(1)
  })

  it('S9: a remote host’s link that drops while typing, starting a session and answering a prompt sends none of it again once it is back, and acts on nothing by itself', async () => {
    const first = new FakeConnection()
      .answer('session:list', () => [row({ id: 7 })])
      // A start the host has not answered when the link drops.
      .answer('session:start', () => new Promise<P.SessionRecord>(() => undefined) as unknown as P.SessionRecord)
    const link = reconnectingReach(first)
    const { own } = ownBridge()
    const adapters = createSessionsAdapters({
      link,
      own,
      front: { focused: () => true, onChange: () => undefined },
      shelf: null,
      hostName: () => 'build-box'
    })
    const questions = hear(adapters, 'session:confirm')
    await ask(adapters, 'session:list')
    adapters.show([7])
    const [before] = first.streamsFor('session:data', 7)
    send(adapters, 'session:input', { id: 7, data: 'ls' })
    void ask(adapters, 'session:start', { cwd: '/work dir/app', projectPath: '/work dir/app', cols: 100, rows: 30 }).catch(
      () => undefined
    )
    // The host asks; the user has not answered when the link drops.
    first.push('session:confirm', {
      id: 31,
      kind: 'close-session',
      message: '“app” is still running on build-box.',
      detail: 'Ending it stops the Claude Code session in /work dir/app.',
      confirmLabel: 'End session',
      sessionNames: ['app']
    })
    expect(questions).toHaveLength(1)

    link.lose({ planned: false, restarts: false })
    await settle()
    // Typed while the link is down: it reaches nothing and is not kept.
    send(adapters, 'session:input', { id: 7, data: 'rm -rf build\r' })
    expect(before!.text()).toBe('ls')

    const second = new FakeConnection().answer('session:list', () => [row({ id: 7 })])
    await link.reconnect(second)
    await settle()
    const [after] = second.streamsFor('session:data', 7)
    expect(after).toBeDefined()
    expect(after!.text()).toBe('')

    // The question asked over the dropped link is answered late: nothing reaches the host there now.
    send(adapters, 'session:confirmed', { id: questions[0]!.id, agreed: true })
    await settle()
    const acting = [
      'session:start',
      'session:launch',
      'profile:launch',
      'history:resume',
      'session:restore',
      'session:close',
      'session:confirmed',
      'host:stop',
      'host:quit'
    ]
    expect(second.sent.filter((request) => acting.includes(request.channel))).toEqual([])
    // Only what the window reads to show the host again went out.
    expect([...new Set(second.sent.map((request) => request.channel))].sort()).toEqual(['session:focus', 'session:list'])

    send(adapters, 'session:input', { id: 7, data: 'y' })
    expect(after!.text()).toBe('y')
  })

  describe('when the host connection ends', () => {
    /** The window shows 7 and 9 running and 8 that ended, over a link the test ends. */
    async function shownWorld() {
      const first = new FakeConnection().answer('session:list', () => [
        row({ id: 7 }),
        row({
          id: 8,
          status: 'exited',
          exitCode: 0,
          endedAt: '2026-10-29T10:05:00.000Z',
          durationMs: 300_000
        }),
        row({ id: 9, cwd: '/work dir/api' })
      ])
      const link = reconnectingReach(first)
      const { own } = ownBridge()
      const adapters = createSessionsAdapters({
        link,
        own,
        front: { focused: () => true, onChange: () => undefined },
        shelf: null
      })
      const exits = hear(adapters, 'session:exit')
      await ask(adapters, 'session:list')
      adapters.show([7, 8, 9])
      const streams = [first.streamsFor('session:data', 7)[0]!, first.streamsFor('session:data', 9)[0]!]
      return { first, link, adapters, exits, streams }
    }

    it('keeps every session running with its keys going nowhere while the host is gone, and tells the window nothing yet', async () => {
      const w = await shownWorld()

      w.link.lose({ planned: false, restarts: true })
      await settle()

      // They may be running on in the session keeper: the next host says.
      expect(w.exits).toEqual([])
      const listed = await ask(w.adapters, 'session:list').catch(() => null)
      expect(listed?.map((record) => [record.id, record.status]) ?? null).toEqual([
        [7, 'running'],
        [8, 'exited'],
        [9, 'running']
      ])
      // Keys pressed meanwhile reach no session.
      send(w.adapters, 'session:input', { id: 7, data: 'yes\r' })
      expect(w.streams[0]!.text()).toBe('')
    })

    it('takes back each session the new host lists running, on a new stream that starts with its screen and takes keys, and resumes nothing, when the killed host’s sessions survived', async () => {
      const w = await shownWorld()
      w.link.lose({ planned: false, restarts: true })
      await settle()

      // The new host took the keeper's sessions back with the same ids, and offers none of them.
      const second = new FakeConnection()
        .answer('session:list', () => [
          row({ id: 7 }),
          row({ id: 8, status: 'exited', exitCode: 0 }),
          row({ id: 9, cwd: '/work dir/api' })
        ])
        .answer('session:restorable', () => null)
      const data = hear(w.adapters, 'session:data')
      await w.link.reconnect(second)
      await settle()

      expect(w.exits).toEqual([])
      const listed = await ask(w.adapters, 'session:list')
      expect(listed.map((record) => [record.id, record.status])).toEqual([
        [7, 'running'],
        [8, 'exited'],
        [9, 'running']
      ])
      const seven = second.streamsFor('session:data', 7)
      expect(seven).toHaveLength(1)
      expect(second.streamsFor('session:data', 9)).toHaveLength(1)
      expect(second.streamsFor('session:data', 8)).toEqual([])
      // The host's redraw draws the screen as it is now, written while no host ran included.
      seven[0]!.send('\x1bcYou said: sketch\r\ntick 12')
      expect(data).toEqual([{ id: 7, data: '\x1bcYou said: sketch\r\ntick 12' }])
      send(w.adapters, 'session:input', { id: 7, data: 'carry on\r' })
      expect(seven[0]!.text()).toBe('carry on\r')
      // Nothing was resumed: the host offers nothing back, so the window has nothing to restore.
      await expect(ask(w.adapters, 'session:restorable')).resolves.toBeNull()
      expect(second.payloads('session:restore')).toEqual([])
      expect(second.payloads('session:launch')).toEqual([])
      expect(second.payloads('history:resume')).toEqual([])
    })

    it('tells the window each session the new host lists ended, and one it does not list at all as lost', async () => {
      const w = await shownWorld()
      w.link.lose({ planned: false, restarts: true })
      await settle()

      // 7 exited while no host ran; 9 went with a keeper the new host could not use.
      const second = new FakeConnection().answer('session:list', () => [
        row({ id: 7, status: 'exited', exitCode: 5, endedAt: '2026-10-29T10:06:00.000Z', durationMs: 360_000 }),
        row({ id: 8, status: 'exited', exitCode: 0 })
      ])
      await w.link.reconnect(second)
      await settle()

      expect(w.exits.map((record) => [record.id, record.status, record.exitCode])).toEqual([
        [7, 'exited', 5],
        [9, 'lost', null]
      ])
      expect(second.streams).toEqual([])
    })

    it('shows a session lost when the host says so while it stays connected, its keeper gone', async () => {
      const w = await shownWorld()

      w.first.push('session:exit', row({ id: 9, cwd: '/work dir/api', status: 'lost' }))

      expect(w.exits.map((record) => [record.id, record.status, record.cwd])).toEqual([[9, 'lost', '/work dir/api']])
      expect(w.streams[1]!.closed).toBe(true)
      const listed = await ask(w.adapters, 'session:list')
      expect(listed.find((record) => record.id === 9)?.status).toBe('lost')
    })

    it('marks nothing lost when the host was stopped on purpose', async () => {
      const w = await shownWorld()

      w.link.lose({ planned: true, restarts: false })
      await settle()

      expect(w.exits).toEqual([])
      const listed = await ask(w.adapters, 'session:list')
      expect(listed.filter((record) => record.status === 'lost')).toEqual([])
    })

    /** How main's link says a Restart host to update ended the connection (`desktop.ts` `howEnded`). */
    const RESTART_END = { planned: true, restarts: true, restarting: true }

    it('S12: after Restart host to update, keeps every session running in its tab and takes it back from the new host on a new stream that starts with its screen, resuming nothing', async () => {
      const w = await shownWorld()
      w.link.lose(RESTART_END)
      await settle()
      // While the old host exits and the new one starts, nothing is said to have ended.
      expect(w.exits).toEqual([])

      // The carried floti's host took the keeper back: the same ids, still running.
      const second = new FakeConnection()
        .answer('session:list', () => [
          row({ id: 7 }),
          row({ id: 8, status: 'exited', exitCode: 0 }),
          row({ id: 9, cwd: '/work dir/api' })
        ])
        .answer('session:restorable', () => null)
      const data = hear(w.adapters, 'session:data')
      await w.link.reconnect(second)
      await settle()

      expect(w.exits).toEqual([])
      const seven = second.streamsFor('session:data', 7)
      const nine = second.streamsFor('session:data', 9)
      expect([seven.length, nine.length]).toEqual([1, 1])
      seven[0]!.send('\x1bcYou said: sketch\r\ntick 12')
      nine[0]!.send('\x1bcapi ready')
      expect(data).toEqual([
        { id: 7, data: '\x1bcYou said: sketch\r\ntick 12' },
        { id: 9, data: '\x1bcapi ready' }
      ])
      send(w.adapters, 'session:input', { id: 9, data: 'go\r' })
      expect(nine[0]!.text()).toBe('go\r')
      await expect(ask(w.adapters, 'session:restorable')).resolves.toBeNull()
      expect(second.payloads('session:restore')).toEqual([])
      expect(second.payloads('session:launch')).toEqual([])
      expect(second.payloads('history:resume')).toEqual([])
    })

    it('S13: after a confirmed Restart host to update whose keeper the new host could not take back, says each session ended as lost and hands the window the new host’s offer of them', async () => {
      const w = await shownWorld()
      w.link.lose(RESTART_END)
      await settle()

      // The new host ended the keeper it does not speak to, and offers its sessions back once.
      const lost = (id: number, cwd: string) => row({ id, cwd, status: 'lost' })
      const offered = (id: number, name: string, cwd: string): P.RestoreOffer['sessions'][number] => ({
        id,
        name,
        cwd,
        branch: 'main',
        profile: null,
        profileGone: false,
        lastAt: null,
        blocked: null
      })
      const second = new FakeConnection()
        .answer('session:list', () => [lost(7, '/work dir/app'), row({ id: 8, status: 'exited', exitCode: 0 }), lost(9, '/work dir/api')])
        .answer('session:restorable', () => ({
          sessions: [offered(7, 'app', '/work dir/app'), offered(9, 'app', '/work dir/api')],
          elsewhere: 0
        }))
      await w.link.reconnect(second)
      await settle()

      expect(w.exits.map((record) => [record.id, record.status])).toEqual([
        [7, 'lost'],
        [9, 'lost']
      ])
      expect(second.streams).toEqual([])
      const offer = await ask(w.adapters, 'session:restorable')
      expect(offer?.sessions.map((session) => [session.id, session.cwd])).toEqual([
        [7, '/work dir/app'],
        [9, '/work dir/api']
      ])
      // Offered, not reopened: the user answers the offer.
      expect(second.payloads('session:restore')).toEqual([])
    })
  })

  describe('when this PC’s host refused the window and Restart host to update replaced it', () => {
    /**
     * A window that opened while a protocol-1.x host refused it, its saved
     * layout naming 7 and 9, and the link that connects once `carried` is
     * set: the carried floti's host, after the old one was ended.
     */
    function refusedWorld() {
      let carried: FakeConnection | null = null
      let attempt: Promise<HostConnection> | null = null
      const listeners: Array<(connection: HostConnection) => void> = []
      const link = {
        connection(): Promise<HostConnection> {
          const reached = carried
          if (reached === null) {
            return Promise.reject(
              new HostRefusedError('This client speaks Floti protocol 2.0 and the host speaks 1.4.', {
                host: { major: 1, minor: 4 },
                client: { major: 2, minor: 0 },
                update: 'host'
              })
            )
          }
          attempt ??= Promise.resolve().then(() => {
            for (const listener of listeners) listener(reached.asConnection())
            return reached.asConnection()
          })
          return attempt
        },
        onConnected: (listener: (connection: HostConnection) => void) => {
          listeners.push(listener)
        },
        onEnded: () => undefined
      }
      const { own } = ownBridge()
      const adapters = createSessionsAdapters({
        link,
        own,
        front: { focused: () => true, onChange: () => undefined },
        shelf: null
      })
      return {
        adapters,
        link,
        replace: async (next: FakeConnection) => {
          carried = next
          await link.connection()
          await settle()
        }
      }
    }

    it('S15: carries the terminal of each session its layout names on the carried host, with its screen, and resumes nothing, when that host took the keeper back', async () => {
      const w = refusedWorld()
      await expect(ask(w.adapters, 'session:list')).rejects.toThrow(/1\.4/)
      w.adapters.show([7, 9])
      await expect(ask(w.adapters, 'session:restorable')).resolves.toBeNull()

      const carried = new FakeConnection()
        .answer('session:list', () => [row({ id: 7 }), row({ id: 9, cwd: '/work dir/api' })])
        .answer('session:restorable', () => null)
      const data = hear(w.adapters, 'session:data')
      await w.replace(carried)

      const listed = await ask(w.adapters, 'session:list')
      expect(listed.map((record) => [record.id, record.status])).toEqual([
        [7, 'running'],
        [9, 'running']
      ])
      const seven = carried.streamsFor('session:data', 7)
      expect([seven.length, carried.streamsFor('session:data', 9).length]).toEqual([1, 1])
      seven[0]!.send('\x1bcYou said: sketch\r\ntick 12')
      expect(data).toEqual([{ id: 7, data: '\x1bcYou said: sketch\r\ntick 12' }])
      send(w.adapters, 'session:input', { id: 7, data: 'carry on\r' })
      expect(seven[0]!.text()).toBe('carry on\r')
      await expect(ask(w.adapters, 'session:restorable')).resolves.toBeNull()
      expect(carried.payloads('session:restore')).toEqual([])
      expect(carried.payloads('history:resume')).toEqual([])
    })

    it('S15: opens each shell its tabs asked for while refused on the carried host once it connects, with the screen the keeper kept', async () => {
      const w = refusedWorld()
      const data = hear(w.adapters, 'pterm:data')
      // A folder's shell and a terminal tab's, mounted while the 1.x host refused the window.
      const folder = ask(w.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24 })
      const tab = ask(w.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })
      await settle()

      let next = 3
      const carried = new FakeConnection()
        .answer('session:list', () => [])
        .answer('pterm:open', () => ({ id: next++, shell: 'pwsh', requested: null, problem: null }))
      await w.replace(carried)

      await expect(folder).resolves.toEqual({ id: 3, shell: 'pwsh', requested: null, problem: null })
      await expect(tab).resolves.toEqual({ id: 4, shell: 'pwsh', requested: null, problem: null })
      expect(carried.payloads('pterm:open')).toEqual([
        { path: '/work dir/app', cols: 80, rows: 24, shell: null, separate: false },
        { path: '/work dir/app', cols: 80, rows: 24, shell: null, separate: true }
      ])
      const three = carried.streamsFor('pterm:data', 3)
      expect([three.length, carried.streamsFor('pterm:data', 4).length]).toEqual([1, 1])
      // The folder's shell is the one the keeper kept running: its redraw comes, then it takes keys.
      three[0]!.send('\x1bcPS> npm test')
      expect(data).toEqual([{ id: 3, data: '\x1bcPS> npm test' }])
      send(w.adapters, 'pterm:input', { id: 3, data: '\r' })
      expect(three[0]!.text()).toBe('\r')
    })

    it('S15: hands the window the carried host’s offer of each session whose keeper it could not take back, and carries none of them', async () => {
      const w = refusedWorld()
      await expect(ask(w.adapters, 'session:list')).rejects.toThrow(/1\.4/)
      w.adapters.show([7, 9])

      const offered = (id: number, cwd: string): P.RestoreOffer['sessions'][number] => ({
        id,
        name: 'app',
        cwd,
        branch: 'main',
        profile: null,
        profileGone: false,
        lastAt: null,
        blocked: null
      })
      const carried = new FakeConnection()
        .answer('session:list', () => [
          row({ id: 7, status: 'lost' }),
          row({ id: 9, cwd: '/work dir/api', status: 'lost' })
        ])
        .answer('session:restorable', () => ({
          sessions: [offered(7, '/work dir/app'), offered(9, '/work dir/api')],
          elsewhere: 0
        }))
      await w.replace(carried)

      expect(carried.streams).toEqual([])
      const offer = await ask(w.adapters, 'session:restorable')
      expect(offer?.sessions.map((session) => [session.id, session.cwd])).toEqual([
        [7, '/work dir/app'],
        [9, '/work dir/api']
      ])
      // Offered, each to come back in its own tab when the user answers; never through History.
      expect(carried.payloads('session:restore')).toEqual([])
      expect(carried.payloads('history:resume')).toEqual([])
    })
  })
})

describe('plain terminals over the window’s own connection', () => {
  it('opens a folder’s shell on the host, carries it, resizes it and closes it there', async () => {
    const connection = new FakeConnection().answer('pterm:open', () => ({ id: 3, shell: 'pwsh', requested: null, problem: null }))
    const { adapters } = world({ connection })
    const data = hear(adapters, 'pterm:data')
    await expect(ask(adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24 })).resolves.toEqual({
      id: 3,
      shell: 'pwsh',
      requested: null,
      problem: null
    })
    expect(connection.payloads('pterm:open')).toEqual([
      { path: '/work dir/app', cols: 80, rows: 24, shell: null, separate: false }
    ])
    connection.streamsFor('pterm:data', 3)[0]?.send('PS> ')
    expect(data).toEqual([{ id: 3, data: 'PS> ' }])
    send(adapters, 'pterm:resize', { id: 3, cols: 90, rows: 20 })
    await ask(adapters, 'pterm:close', { id: 3 })
    expect(connection.payloads('pterm:resize')).toEqual([{ id: 3, cols: 90, rows: 20 }])
    expect(connection.payloads('pterm:close')).toEqual([{ id: 3 }])
  })

  it('asks the host whether a typed shell path is a shell, and answers what it says', async () => {
    const alias = 'C:\\Users\\someone\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
    const kept = { path: alias, name: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'] }
    const connection = new FakeConnection().answer('pterm:checkShell', ({ path }: { path: string }) =>
      path === alias ? { shell: kept, problem: null } : { shell: null, problem: `Nothing is at ${path}.` }
    )
    const { adapters } = world({ connection })

    await expect(ask(adapters, 'pterm:checkShell', { path: alias })).resolves.toEqual({ shell: kept, problem: null })
    await expect(ask(adapters, 'pterm:checkShell', { path: 'D:\\gone\\nu.exe' })).resolves.toEqual({
      shell: null,
      problem: 'Nothing is at D:\\gone\\nu.exe.'
    })
    expect(connection.payloads('pterm:checkShell')).toEqual([{ path: alias }, { path: 'D:\\gone\\nu.exe' }])
  })

  it('gives a page that has just loaded its terminal tabs’ shells back, one each, then opens new ones', async () => {
    let next = 20
    const opening = () => new FakeConnection().answer('pterm:open', () => ({ id: next++, shell: 'bash', requested: null, problem: null }))
    const shelf: Shelf = { text: null }
    const before = world({ connection: opening(), shelf })
    await ask(before.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })
    await ask(before.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })

    // The page reloads: a new adapter on a new connection, the same session storage.
    const after = world({ connection: opening(), shelf })
    const first = await ask(after.adapters, 'pterm:open', { path: '/WORK DIR/app', cols: 80, rows: 24, separate: true })
    const second = await ask(after.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })
    const third = await ask(after.adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })
    expect([first.id, second.id, third.id]).toEqual([20, 21, 22])
    expect(after.connection.payloads('pterm:open')).toHaveLength(1)
    expect(after.connection.streamsFor('pterm:data', 20)).toHaveLength(1)
  })

  it('tells the window when the host’s shell exits, and forgets it', async () => {
    const connection = new FakeConnection().answer('pterm:open', () => ({ id: 3, shell: 'pwsh', requested: null, problem: null }))
    const { adapters } = world({ connection })
    const exits = hear(adapters, 'pterm:exit')
    await ask(adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24 })
    connection.push('pterm:exit', { id: 3, exitCode: 0 })
    connection.push('pterm:exit', { id: 3, exitCode: 0 })
    expect(exits).toEqual([{ id: 3, exitCode: 0 }])
    expect(connection.streamsFor('pterm:data', 3)[0]?.closed).toBe(true)
  })

  describe('when the host connection ends', () => {
    /** A folder's shell and a terminal tab's shell, open over a link the test ends. */
    async function shellWorld() {
      let next = 3
      const first = new FakeConnection()
        .answer('session:list', () => [])
        .answer('pterm:open', () => ({ id: next++, shell: 'pwsh', requested: null, problem: null }))
      const link = reconnectingReach(first)
      const { own } = ownBridge()
      const shelf: Shelf = { text: null }
      const adapters = createSessionsAdapters({
        link,
        own,
        front: { focused: () => true, onChange: () => undefined },
        shelf: {
          read: () => shelf.text,
          write: (text) => {
            shelf.text = text
          }
        }
      })
      const exits = hear(adapters, 'pterm:exit')
      await ask(adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24 })
      await ask(adapters, 'pterm:open', { path: '/work dir/app', cols: 80, rows: 24, separate: true })
      const streams = [first.streamsFor('pterm:data', 3)[0]!, first.streamsFor('pterm:data', 4)[0]!]
      return { first, link, adapters, exits, streams, shelf }
    }

    it('keeps every shell, and the terminal tab’s for a reload, with keys going nowhere while the host is gone', async () => {
      const w = await shellWorld()

      w.link.lose({ planned: false, restarts: true })
      await settle()

      expect(w.exits).toEqual([])
      expect(JSON.parse(w.shelf.text ?? '{}')).toEqual({
        version: 1,
        shells: [{ id: 4, path: '/work dir/app', shell: 'pwsh' }]
      })
      send(w.adapters, 'pterm:input', { id: 3, data: 'ls\r' })
      expect(w.streams[0]!.text()).toBe('')
    })

    it('reattaches each shell the new host still has, typed into and closed there, and says lost only of one it does not have', async () => {
      const w = await shellWorld()
      w.link.lose({ planned: false, restarts: true })
      await settle()

      const second = new FakeConnection().answer('session:list', () => [])
      await w.link.reconnect(second)
      await settle()

      const three = second.streamsFor('pterm:data', 3)
      const four = second.streamsFor('pterm:data', 4)
      expect([three.length, four.length]).toEqual([1, 1])
      // 3 is still running in the keeper: its redraw comes, then it takes keys.
      three[0]!.send('\x1bcPS> ')
      send(w.adapters, 'pterm:input', { id: 3, data: 'ls\r' })
      expect(three[0]!.text()).toBe('ls\r')
      // 4 is not on the new host: it refuses the stream, and the shell is lost.
      four[0]!.end('Terminal 4 is not open on this Floti host.')
      expect(w.exits).toEqual([{ id: 4, exitCode: null, lost: true }])
      expect(JSON.parse(w.shelf.text ?? '{}')).toEqual({ version: 1, shells: [] })

      await ask(w.adapters, 'pterm:close', { id: 3 })
      expect(second.payloads('pterm:close')).toEqual([{ id: 3 }])
      expect(second.payloads('pterm:open')).toEqual([])
    })

    it('ends no shell when the host was stopped on purpose', async () => {
      const w = await shellWorld()

      w.link.lose({ planned: true, restarts: false })
      await settle()

      expect(w.exits).toEqual([])
    })

    it('S12: after Restart host to update, reattaches each shell the new host took back from the keeper, with its screen, and ends none', async () => {
      const w = await shellWorld()
      w.link.lose({ planned: true, restarts: true, restarting: true })
      await settle()
      expect(w.exits).toEqual([])

      const second = new FakeConnection().answer('session:list', () => [])
      const data = hear(w.adapters, 'pterm:data')
      await w.link.reconnect(second)
      await settle()

      const three = second.streamsFor('pterm:data', 3)
      const four = second.streamsFor('pterm:data', 4)
      expect([three.length, four.length]).toEqual([1, 1])
      three[0]!.send('\x1bcPS> ls')
      four[0]!.send('\x1bcPS> ')
      expect(data).toEqual([
        { id: 3, data: '\x1bcPS> ls' },
        { id: 4, data: '\x1bcPS> ' }
      ])
      send(w.adapters, 'pterm:input', { id: 4, data: 'git status\r' })
      expect(four[0]!.text()).toBe('git status\r')
      expect(w.exits).toEqual([])
      expect(JSON.parse(w.shelf.text ?? '{}')).toEqual({
        version: 1,
        shells: [{ id: 4, path: '/work dir/app', shell: 'pwsh' }]
      })
      expect(second.payloads('pterm:open')).toEqual([])
    })
  })
})
