import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import type { HostConnection } from '../../shared/host/client'
import type * as P from '../../shared/host/protocol'
import { RECONNECT_MOST_MS } from '../../shared/host/reconnect'
import { HOST_RETRY_MS, LocalHostError } from './launcher'
import { HOST_STOP_DEADLINE_MS, createHostLink } from './link'
import { hostSettingsFor } from './sessions'

/** What a host says of itself, as `app:info` answers. */
const appInfo = (desktop: boolean): P.AppInfo =>
  ({
    version: '0.4.1',
    logFile: '/data/logs/host.log',
    desktop
  }) as unknown as P.AppInfo

/** Timers the test fires by hand. */
function steppedTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>()
  let next = 1
  return {
    setTimeout: (run: () => void, ms: number): unknown => {
      const id = next++
      pending.set(id, { run, ms })
      return id
    },
    clearTimeout: (timer: unknown) => {
      pending.delete(timer as number)
    },
    fireAll() {
      const due = [...pending.values()]
      pending.clear()
      for (const timer of due) timer.run()
    },
    pending: () => [...pending.values()].map((timer) => timer.ms)
  }
}

describe('the link to the local host', () => {
  it('writes Helm’s claude and shell on connect, before anything else uses the connection', async () => {
    const connection = new FakeConnection()
    const order: string[] = []
    const link = createHostLink({
      start: () => Promise.resolve(fakeLocalHost(connection)),
      settings: () => ({ backendPaths: { 'claude-code': '/bin/claude' }, terminalShell: '/bin/zsh' }),
      log: () => undefined,
      ...steppedTimers()
    })
    link.onConnected(() => {
      order.push(...connection.sent.map((request) => request.channel), 'listener')
    })
    await link.connection()

    expect(connection.payloads('settings:write')).toEqual([
      { backendPaths: { 'claude-code': '/bin/claude' }, terminalShell: '/bin/zsh' }
    ])
    expect(order).toEqual(['settings:write', 'listener'])
    expect(link.current()).toBe(connection.asConnection())
  })

  it('tries again after a connection that failed', async () => {
    const connection = new FakeConnection()
    let attempts = 0
    const link = createHostLink({
      start: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new LocalHostError('No local host answered on its socket; turn it off.'))
          : Promise.resolve(fakeLocalHost(connection))
      },
      settings: () => ({}),
      log: () => undefined,
      ...steppedTimers()
    })

    await expect(link.connection()).rejects.toThrow('No local host answered on its socket')
    await expect(link.settled()).resolves.toBeUndefined()
    await expect(link.connection()).resolves.toBe(connection.asConnection())
    expect(attempts).toBe(2)
  })

  it('S8: Reconnect now tries at once from a wait, resets the wait, and does nothing once the link has quit', async () => {
    const timers = steppedTimers()
    let attempts = 0
    const link = createHostLink({
      start: () => {
        attempts += 1
        return Promise.reject(new LocalHostError('ssh: connect to host build-box port 22: Connection timed out'))
      },
      name: 'build-box',
      log: () => undefined,
      ...timers
    })
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    link.keepConnected()
    await settle()
    timers.fireAll()
    await settle()
    timers.fireAll()
    await settle()
    expect(attempts).toBe(3)
    expect(timers.pending()).toEqual([HOST_RETRY_MS * 4])

    link.reconnectNow()
    expect(attempts).toBe(4)
    expect(timers.pending()).toEqual([])
    await settle()
    expect(timers.pending()).toEqual([HOST_RETRY_MS])

    await link.quit({ end: false })
    link.reconnectNow()
    expect(attempts).toBe(4)
  })

  it('tells the host a deliberate quit ends what this device started, never stops it, lets go and connects no more', async () => {
    const connection = new FakeConnection()
    const local = fakeLocalHost(connection, true)
    const link = createHostLink({
      start: () => Promise.resolve(local),
      settings: () => ({}),
      log: () => undefined,
      ...steppedTimers()
    })
    await link.connection()
    await link.quit({ end: true })

    expect(connection.payloads('host:quit')).toEqual([{ end: true }])
    expect(connection.payloads('host:stop')).toEqual([])
    expect(local.closed).toBe(true)
    await expect(link.connection()).rejects.toThrow('Helm is quitting.')
  })

  it('says the same to a host it did not start, and only lets go of the connection', async () => {
    const connection = new FakeConnection()
    const local = fakeLocalHost(connection, false)
    const link = createHostLink({
      start: () => Promise.resolve(local),
      settings: () => ({}),
      log: () => undefined,
      ...steppedTimers()
    })
    await link.connection()
    await link.quit({ end: false })

    expect(connection.payloads('host:quit')).toEqual([{ end: false }])
    expect(connection.payloads('host:stop')).toEqual([])
    expect(local.closed).toBe(true)
  })

  it('lets go of a host that does not answer its quit once the deadline passes', async () => {
    const connection = new FakeConnection()
    // Never answered.
    connection.answer('host:quit', () => new Promise<null>(() => undefined) as unknown as null)
    const local = fakeLocalHost(connection, true)
    const timers = steppedTimers()
    const link = createHostLink({
      start: () => Promise.resolve(local),
      settings: () => ({}),
      log: () => undefined,
      ...timers
    })
    await link.connection()

    const quitting = link.quit({ end: true })
    // The quit is waiting on the host's answer, bounded by the deadline.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(timers.pending()).toEqual([HOST_STOP_DEADLINE_MS])
    timers.fireAll()
    await quitting

    expect(local.closed).toBe(true)
  })

  it('stops the host the user asked to stop with the plain-stop reason, and the next request starts a fresh one', async () => {
    const first = new FakeConnection()
    // The host ends the connection once it has stopped.
    first.answer('host:stop', () => {
      first.close()
      return null
    })
    const second = new FakeConnection()
    const started = [fakeLocalHost(first, true), fakeLocalHost(second, true)]
    let starts = 0
    const link = createHostLink({
      start: () => Promise.resolve(started[starts++] as ReturnType<typeof fakeLocalHost>),
      settings: () => ({}),
      log: () => undefined,
      ...steppedTimers()
    })
    await link.connection()

    await link.stopHost()

    expect(first.payloads('host:stop')).toEqual([{ reason: 'stop' }])
    expect(first.payloads('host:quit')).toEqual([])
    expect(link.current()).toBeNull()
    await expect(link.connection()).resolves.toBe(second.asConnection())
    expect(starts).toBe(2)
  })

  describe('when the connection ends without a stop or a quit', () => {
    /** Lets every promise already settled run its callbacks. */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }

    /** A link over hosts the test hands out in turn, each start recording whether it may start a host. */
    function crashWorld(first: { startedHost: boolean; desktop?: boolean }) {
      const timers = steppedTimers()
      const firstConnection = new FakeConnection().answer('app:info', () => appInfo(first.desktop ?? false))
      const outcomes: Array<() => Promise<ReturnType<typeof fakeLocalHost>>> = [
        () => Promise.resolve(fakeLocalHost(firstConnection, first.startedHost))
      ]
      const starts: boolean[] = []
      const connected: HostConnection[] = []
      const link = createHostLink({
        start: (options) => {
          starts.push(options?.startHost ?? true)
          const next = outcomes.shift()
          return next === undefined ? Promise.reject(new LocalHostError('No local host answered.')) : next()
        },
        settings: () => ({}),
        log: () => undefined,
        ...timers
      })
      link.onConnected((connection) => {
        connected.push(connection)
      })
      return { timers, link, starts, connected, firstConnection, outcomes }
    }

    it('starts a new host when a desktop started the one that died, after waits that double up to two minutes, and runs every listener again', async () => {
      const w = crashWorld({ startedHost: true })
      await w.link.connection()
      expect(w.starts).toEqual([true])

      // Killed: no stop and no quit.
      w.firstConnection.close()
      await settle()
      expect(w.link.current()).toBeNull()
      expect(w.link.endedOnPurpose()).toBe(false)
      expect(w.link.restartsHost()).toBe(true)

      // Each try that fails waits twice as long before the next, never past two minutes.
      const waits: number[] = []
      for (let tries = 0; tries < 12; tries++) {
        expect(w.timers.pending()).toHaveLength(1)
        waits.push(w.timers.pending()[0]!)
        w.timers.fireAll()
        await settle()
      }
      expect(waits).toEqual([
        HOST_RETRY_MS,
        HOST_RETRY_MS * 2,
        HOST_RETRY_MS * 4,
        HOST_RETRY_MS * 8,
        HOST_RETRY_MS * 16,
        HOST_RETRY_MS * 32,
        HOST_RETRY_MS * 64,
        HOST_RETRY_MS * 128,
        HOST_RETRY_MS * 256,
        RECONNECT_MOST_MS,
        RECONNECT_MOST_MS,
        RECONNECT_MOST_MS
      ])
      // Every try may start a host: a desktop started the one that died.
      expect(w.starts.slice(1).every((start) => start)).toBe(true)

      const second = new FakeConnection()
      w.outcomes.push(() => Promise.resolve(fakeLocalHost(second, true)))
      w.timers.fireAll()
      await settle()

      expect(w.link.current()).toBe(second.asConnection())
      expect(w.connected).toEqual([w.firstConnection.asConnection(), second.asConnection()])
      // Helm's settings are written to the new host before anything else.
      expect(second.sent[0]?.channel).toBe('settings:write')
      // Connected: no more tries, and the next loss starts from the first wait again.
      expect(w.timers.pending()).toEqual([])
      second.close()
      await settle()
      expect(w.timers.pending()).toEqual([HOST_RETRY_MS])
    })

    it('starts a new host in place of one it found that a desktop started, as the host itself says', async () => {
      const w = crashWorld({ startedHost: false, desktop: true })
      await w.link.connection()
      await settle()
      w.firstConnection.close()
      await settle()
      expect(w.link.restartsHost()).toBe(true)
      w.timers.fireAll()
      await settle()
      expect(w.starts).toEqual([true, true])
    })

    it('only connects again to a host a desktop did not start, never starting one in its place', async () => {
      const w = crashWorld({ startedHost: false, desktop: false })
      await w.link.connection()
      await settle()
      expect(w.firstConnection.payloads('app:info')).toEqual([null])

      w.firstConnection.close()
      await settle()
      expect(w.link.restartsHost()).toBe(false)
      for (let tries = 0; tries < 3; tries++) {
        w.timers.fireAll()
        await settle()
      }
      expect(w.starts).toEqual([true, false, false, false])
      // A caller asking meanwhile does not start one either.
      await expect(w.link.connection()).rejects.toThrow('No local host answered.')
      expect(w.starts.at(-1)).toBe(false)

      const again = new FakeConnection()
      w.outcomes.push(() => Promise.resolve(fakeLocalHost(again, false)))
      w.timers.fireAll()
      await settle()
      expect(w.link.current()).toBe(again.asConnection())
    })

    it('does not connect again, nor start a host, after the user stopped the host', async () => {
      const w = crashWorld({ startedHost: true })
      w.firstConnection.answer('host:stop', () => {
        w.firstConnection.close()
        return null
      })
      await w.link.connection()
      await w.link.stopHost()
      await settle()

      expect(w.link.endedOnPurpose()).toBe(true)
      expect(w.timers.pending()).toEqual([])
      expect(w.starts).toEqual([true])
    })

    it('does not connect again after a quit', async () => {
      const w = crashWorld({ startedHost: true })
      await w.link.connection()
      await w.link.quit({ end: false })
      await settle()

      expect(w.link.endedOnPurpose()).toBe(true)
      expect(w.timers.pending()).toEqual([])
      expect(w.starts).toEqual([true])
    })

    it('stops trying once Helm quits while it waits to try again', async () => {
      const w = crashWorld({ startedHost: true })
      await w.link.connection()
      w.firstConnection.close()
      await settle()
      expect(w.timers.pending()).toEqual([HOST_RETRY_MS])

      await w.link.quit({ end: false })
      expect(w.timers.pending()).toEqual([])
      expect(w.starts).toEqual([true])
    })
  })

  it('sends the claude chosen in Settings, or the one Helm finds, and the terminal shell', () => {
    const base = { claudePath: null, terminalShell: null } as Parameters<typeof hostSettingsFor>[0]
    expect(hostSettingsFor({ ...base, claudePath: '/chosen/claude' }, '/found/claude')).toEqual({
      backendPaths: { 'claude-code': '/chosen/claude' },
      terminalShell: null
    })
    expect(hostSettingsFor({ ...base, terminalShell: 'pwsh.exe' }, '/found/claude')).toEqual({
      backendPaths: { 'claude-code': '/found/claude' },
      terminalShell: 'pwsh.exe'
    })
    expect(hostSettingsFor(base, null)).toEqual({ terminalShell: null })
  })
})
