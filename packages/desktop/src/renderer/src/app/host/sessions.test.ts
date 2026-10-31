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

  it('draws each running session in a page that has just loaded from a new stream, which starts with the host’s redraw', async () => {
    const { adapters, connection } = world({ listed: [row(), row({ id: 8, status: 'exited', exitCode: 0 })] })
    const data = hear(adapters, 'session:data')
    await expect(ask(adapters, 'session:list')).resolves.toEqual([
      expect.objectContaining({ id: 7, status: 'running' }),
      expect.objectContaining({ id: 8, status: 'exited' })
    ])
    expect(connection.streamsFor('session:data', 7)).toHaveLength(1)
    expect(connection.streamsFor('session:data', 8)).toHaveLength(0)
    connection.streamsFor('session:data', 7)[0]?.send('\x1b[H\x1b[2Jscreen as it is')
    expect(data).toEqual([{ id: 7, data: '\x1b[H\x1b[2Jscreen as it is' }])
  })

  it('asks in the window before a running session’s tab closes, then tells the host to end it without asking again', async () => {
    const { adapters, connection } = world({ listed: [row()] })
    const questions = hear(adapters, 'session:confirm')
    await ask(adapters, 'session:list')
    const closing = ask(adapters, 'session:close', { id: 7 })
    await settle()
    expect(questions).toEqual([
      expect.objectContaining({ kind: 'close-session', message: '“app” is still running.', sessionNames: ['app'] })
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
    bridge.push('windowSessions:quitConfirm', {
      id: 41,
      kind: 'quit',
      message: '2 Claude Code sessions are still running.',
      detail: 'Quitting Helm ends them.',
      confirmLabel: 'End 2 sessions',
      sessionNames: ['app', 'api']
    })
    expect(questions).toEqual([expect.objectContaining({ kind: 'quit', confirmLabel: 'End 2 sessions' })])
    send(adapters, 'session:confirmed', { id: (questions[0] as SessionConfirmRequest).id, agreed: true })
    expect(bridge.sent).toEqual([{ channel: 'windowSessions:quitConfirmed', payload: { id: 41, agreed: true } }])
  })

  it('adopts and carries a session started outside this window once the host’s activity moves', async () => {
    const connection = new FakeConnection()
    const { adapters } = world({ connection })
    await ask(adapters, 'session:list')
    connection.answer('session:list', () => [row({ id: 12, name: 'from a plugin' })])
    connection.push('session:activity', [])
    await settle()
    expect(connection.streamsFor('session:data', 12)).toHaveLength(1)
    await expect(ask(adapters, 'session:list')).resolves.toEqual([expect.objectContaining({ id: 12 })])
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
    expect(first.streamsFor('session:data', 7)).toHaveLength(1)
    const second = new FakeConnection().answer('session:list', () => [row()])
    first.streamsFor('session:data', 7)[0]?.end('The connection to the local host was closed.')
    await link.reconnect(second)
    await settle()
    expect(second.streamsFor('session:data', 7)).toHaveLength(1)
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
})
