import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import { LocalHostError } from './launcher'
import { HOST_STOP_DEADLINE_MS, createHostLink } from './link'
import { hostSettingsFor } from './sessions'

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
