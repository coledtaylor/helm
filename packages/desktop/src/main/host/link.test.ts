import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@helm/core'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import type { HostConnection } from '../../shared/host/client'
import type * as P from '../../shared/host/protocol'
import { RECONNECT_MOST_MS } from '../../shared/host/reconnect'
import { HOST_RETRY_MS, LocalHostError, LocalHostRefusedError } from './launcher'
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

  describe('Restart host to update', () => {
    it('S12: restarts the host, holds every connect until it has gone, plans the end, and connects to the new host', async () => {
      const first = new FakeConnection()
      const second = new FakeConnection()
      const started = [fakeLocalHost(first, true), fakeLocalHost(second, true)]
      const starts: boolean[] = []
      let gone: () => void = () => undefined
      const timers = steppedTimers()
      const link = createHostLink({
        start: ({ startHost }) => {
          starts.push(startHost)
          return Promise.resolve(started[starts.length - 1] as ReturnType<typeof fakeLocalHost>)
        },
        // The host closes the connection once it answered, then is gone.
        restart: () =>
          new Promise<void>((resolve) => {
            first.close()
            gone = resolve
          }),
        log: () => undefined,
        ...timers
      })
      const connected: HostConnection[] = []
      link.onConnected((connection) => {
        connected.push(connection)
      })
      await link.connection()

      const restarting = link.restartHost()
      expect(link.restarting()).toBe(true)
      expect(link.endedOnPurpose()).toBe(true)
      // A page asking now waits for the new host, never the one exiting.
      const asked = link.connection()
      await Promise.resolve()
      expect(starts).toEqual([true])
      gone()
      await restarting
      await expect(asked).resolves.toBe(second.asConnection())

      expect(starts).toEqual([true, true])
      expect(connected).toEqual([first.asConnection(), second.asConnection()])
      expect(link.restarting()).toBe(false)
      // Nothing was retried as after a crash.
      expect(timers.pending()).toEqual([])
    })

    it('S11: changes nothing and stays connected when the host could not be asked', async () => {
      const first = new FakeConnection()
      const link = createHostLink({
        start: () => Promise.resolve(fakeLocalHost(first, true)),
        restart: () => Promise.reject(new LocalHostError('No local host answered on its socket')),
        log: () => undefined,
        ...steppedTimers()
      })
      await link.connection()

      await expect(link.restartHost()).rejects.toThrow('No local host answered')
      expect(link.restarting()).toBe(false)
      expect(link.current()).toBe(first.asConnection())
    })

    it('S15: a host on protocol 1.x that refuses is tried again with the backoff and never ended unasked; Restart host to update ends it, then the carried floti is started and connected', async () => {
      const timers = steppedTimers()
      const carried = new FakeConnection()
      const starts: boolean[] = []
      let oldHostRunning = true
      let restarts = 0
      const link = createHostLink({
        start: ({ startHost }) => {
          starts.push(startHost)
          // While the 1.x host runs it answers and refuses; once Restart host
          // to update ended its process, the launcher starts the floti Helm carries.
          return oldHostRunning
            ? Promise.reject(
                new LocalHostRefusedError(
                  'This PC’s host speaks Floti protocol 1.4, older than this Helm’s 2.0.',
                  { host: { major: 1, minor: 4 }, client: { major: 2, minor: 0 }, update: 'host' }
                )
              )
            : Promise.resolve(fakeLocalHost(carried, true))
        },
        // `restartLocalHost` with the 1.x refusal: `floti end-old-host` ends its process alone.
        restart: () => {
          restarts += 1
          oldHostRunning = false
          return Promise.resolve(null)
        },
        log: () => undefined,
        ...timers
      })
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 20; i++) await Promise.resolve()
      }
      link.keepConnected()
      await settle()
      expect(timers.pending()).toEqual([HOST_RETRY_MS])
      timers.fireAll()
      await settle()
      expect(timers.pending()).toEqual([HOST_RETRY_MS * 2])
      expect(link.current()).toBeNull()
      // Without the user's click nothing ends it.
      expect(restarts).toBe(0)

      await link.restartHost()

      expect(restarts).toBe(1)
      expect(link.current()).toBe(carried.asConnection())
      expect(starts).toEqual([true, true, true])
      expect(link.restarting()).toBe(false)
      // The carried host is never asked to stop.
      expect(carried.payloads('host:stop')).toEqual([])
      // The retry still pending finds the carried host connected and does nothing.
      timers.fireAll()
      await settle()
      expect(starts).toEqual([true, true, true])
      expect(link.current()).toBe(carried.asConnection())
    })

    it('S11: a link with no restart never restarts its host', async () => {
      const link = createHostLink({
        start: () => Promise.resolve(fakeLocalHost(new FakeConnection(), true)),
        log: () => undefined,
        ...steppedTimers()
      })
      await expect(link.restartHost()).rejects.toThrow('Helm does not restart the local host.')
    })
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

    it('tells the new host whether sessions can start agents and the limits as they are now, not as they were when the old one connected', async () => {
      let settings = { ...DEFAULT_SETTINGS }
      const timers = steppedTimers()
      const first = new FakeConnection()
      const second = new FakeConnection()
      const outcomes = [first, second]
      const link = createHostLink({
        start: () => Promise.resolve(fakeLocalHost(outcomes.shift() as FakeConnection, true)),
        settings: () => hostSettingsFor(settings, null),
        log: () => undefined,
        ...timers
      })
      await link.connection()
      expect(first.payloads('settings:write')).toEqual([
        expect.objectContaining({
          sessionAgents: true,
          agentChildrenPerParent: 4,
          agentSessionsPerHost: 8,
          agentDepth: 2,
          agentStartsPerParent: 16,
          agentCommandsPerParent: 4
        })
      ])

      // Changed while the host was away, then the host came back.
      settings = { ...settings, sessionAgents: false, agentChildrenPerParent: 2, agentDepth: 1 }
      first.close()
      await settle()
      timers.fireAll()
      await settle()

      expect(link.current()).toBe(second.asConnection())
      expect(second.payloads('settings:write')).toEqual([
        expect.objectContaining({
          sessionAgents: false,
          agentChildrenPerParent: 2,
          agentSessionsPerHost: 8,
          agentDepth: 1,
          agentStartsPerParent: 16
        })
      ])
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
