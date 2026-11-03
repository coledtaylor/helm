import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../../test/fake-connection'
import { CLAUDE_CODE_BACKEND } from '../../../../shared/host/backend'
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

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

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

    it('marks every session the window shows running lost, closes its terminal and tells the window, when the host went without a stop', async () => {
      const w = await shownWorld()

      w.link.lose({ planned: false, restarts: true })
      await settle()

      expect(w.exits.map((record) => [record.id, record.status, record.exitCode])).toEqual([
        [7, 'lost', null],
        [9, 'lost', null]
      ])
      expect(w.streams.every((stream) => stream.closed)).toBe(true)
      const listed = await ask(w.adapters, 'session:list')
      expect(listed.map((record) => [record.id, record.status])).toEqual([
        [7, 'lost'],
        [8, 'exited'],
        [9, 'lost']
      ])
      // Keys pressed meanwhile reach no session.
      send(w.adapters, 'session:input', { id: 7, data: 'yes\r' })
      expect(w.streams[0]!.text()).toBe('')
    })

    it('takes the new host’s word for its sessions once reconnected, carrying only those that run', async () => {
      const w = await shownWorld()
      w.link.lose({ planned: false, restarts: true })
      await settle()

      // The new host reconciled what the dead one left running to lost.
      const second = new FakeConnection().answer('session:list', () => [
        row({ id: 7, status: 'lost' }),
        row({ id: 8, status: 'exited', exitCode: 0 }),
        row({ id: 9, status: 'lost' })
      ])
      await w.link.reconnect(second)
      await settle()

      const listed = await ask(w.adapters, 'session:list')
      expect(listed.map((record) => [record.id, record.status])).toEqual([
        [7, 'lost'],
        [8, 'exited'],
        [9, 'lost']
      ])
      expect(second.streams).toEqual([])
    })

    it('marks nothing lost when the host was stopped on purpose', async () => {
      const w = await shownWorld()

      w.link.lose({ planned: true, restarts: false })
      await settle()

      expect(w.exits).toEqual([])
      const listed = await ask(w.adapters, 'session:list')
      expect(listed.filter((record) => record.status === 'lost')).toEqual([])
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

    it('ends every shell the window shows as lost, closes its terminal and keeps none for a reload, when the host went without a stop', async () => {
      const w = await shellWorld()

      w.link.lose({ planned: false, restarts: true })
      await settle()

      expect(w.exits).toEqual([
        { id: 3, exitCode: null, lost: true },
        { id: 4, exitCode: null, lost: true }
      ])
      expect(w.streams.every((stream) => stream.closed)).toBe(true)
      // The shells went with the host: a reload asks the new host for new ones.
      expect(JSON.parse(w.shelf.text ?? '{}')).toEqual({ version: 1, shells: [] })
      // Keys pressed meanwhile reach no shell.
      send(w.adapters, 'pterm:input', { id: 3, data: 'ls\r' })
      expect(w.streams[0]!.text()).toBe('')
    })

    it('ends no shell when the host was stopped on purpose', async () => {
      const w = await shellWorld()

      w.link.lose({ planned: true, restarts: false })
      await settle()

      expect(w.exits).toEqual([])
    })
  })
})
