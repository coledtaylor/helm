import type { HostAddRequest, RemoteHost } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import type { LocalHost } from './launcher'
import { createRemoteHostAdder } from './remote-add'
import { RemoteHostError, STOPPED_LINE } from './remote-launcher'

const REQUEST: HostAddRequest = {
  attempt: 'attempt-1',
  name: 'build-box',
  transport: { kind: 'ssh', target: 'build-box' },
  system: { os: 'Linux', cpu: 'x86_64' }
}

const SIGNED_IN = {
  'claude-code': {
    installed: true,
    path: '/home/me/.local/bin/claude',
    source: 'discovered' as const,
    version: '2.1.241 (Claude Code)',
    semver: '2.1.241',
    tested: true,
    testedRange: { min: '2.0.0', max: '2.9.9' },
    configDir: '/home/me/.claude',
    configDirExists: true,
    signedIn: { state: 'known' as const, value: true },
    signInSignal: 'credentials file',
    error: null
  }
}

/** The adder, with a first connection the test settles and the folders it removed. */
function world(hosts: RemoteHost[] = []) {
  const forgotten: string[] = []
  const kept: { host: RemoteHost; connected: LocalHost }[] = []
  let settle: { resolve: (local: LocalHost) => void; reject: (error: Error) => void; signal: AbortSignal } | null = null
  const adder = createRemoteHostAdder({
    hosts: () => hosts,
    connect: (_host, signal) =>
      new Promise<LocalHost>((resolve, reject) => {
        settle = { resolve, reject, signal }
        signal.addEventListener('abort', () => reject(new RemoteHostError(STOPPED_LINE)))
      }),
    forget: (host) => {
      forgotten.push(host.id)
      return Promise.resolve()
    },
    newId: () => 'h-new',
    log: () => undefined
  })
  const keep = (host: RemoteHost, connected: LocalHost): void => {
    kept.push({ host, connected })
  }
  const connecting = async () => {
    for (let i = 0; i < 10 && settle === null; i += 1) await Promise.resolve()
    if (settle === null) throw new Error('nothing connecting')
    return settle
  }
  return { adder, forgotten, kept, keep, connecting }
}

describe('adding a host by connecting to it', () => {
  it('S5, S22: adds only once it connected, with the key pinned by that connection, its floti version and its agents', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    const pending = await w.connecting()
    expect(w.kept).toEqual([])
    const connection = new FakeConnection().answer('setup:status', () => ({ backends: SIGNED_IN }))
    pending.resolve(fakeLocalHost(connection))
    const outcome = await adding
    expect(outcome).toEqual({
      kind: 'added',
      host: { id: 'h-new', name: 'build-box', transport: REQUEST.transport, system: REQUEST.system },
      version: 'test',
      agents: SIGNED_IN
    })
    expect(w.kept.map((each) => each.host.id)).toEqual(['h-new'])
    expect(w.forgotten).toEqual([])
    // Nothing but the agents' status is asked of it; nothing is approved.
    expect(connection.sent.map((each) => each.channel)).toEqual(['setup:status'])
  })

  it('S19: a connection that fails adds nothing and removes its client folder, with floti’s or the transport’s last line', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    ;(await w.connecting()).reject(new RemoteHostError('floti connect: no Floti host is running there.'))
    expect(await adding).toEqual({ kind: 'failed', lastLine: 'floti connect: no Floti host is running there.' })
    expect(w.kept).toEqual([])
    expect(w.forgotten).toEqual(['h-new'])
  })

  it('S18: a host whose floti refused this Helm’s hello as newer says so with both versions', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    ;(await w.connecting()).reject(
      new RemoteHostError('The host speaks protocol 2.0.', { host: '2.0', client: '1.2', update: 'client' })
    )
    expect(await adding).toMatchObject({
      kind: 'failed',
      cause: { kind: 'newer', host: '2.0', ours: '1.2', by: 'protocol' }
    })
    expect(w.forgotten).toEqual(['h-new'])
  })

  it('S8: Cancel while it connects stops the connection, adds nothing and leaves no folder', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    const pending = await w.connecting()
    w.adder.cancel(REQUEST.attempt)
    expect(pending.signal.aborted).toBe(true)
    expect(await adding).toEqual({ kind: 'cancelled' })
    expect(w.kept).toEqual([])
    expect(w.forgotten).toEqual(['h-new'])
  })

  it('S8: Cancel after it connected but before it was added closes that connection and leaves nothing', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    const pending = await w.connecting()
    let answer: (value: { backends: typeof SIGNED_IN }) => void = () => undefined
    const connection = new FakeConnection()
    const local = fakeLocalHost(connection)
    local.connection.request = (() =>
      new Promise((resolve) => {
        answer = resolve as typeof answer
      })) as typeof local.connection.request
    pending.resolve(local)
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    w.adder.cancel(REQUEST.attempt)
    answer({ backends: SIGNED_IN })
    expect(await adding).toEqual({ kind: 'cancelled' })
    expect(local.closed).toBe(true)
    expect(w.kept).toEqual([])
    expect(w.forgotten).toEqual(['h-new'])
  })

  it('S23: a host whose agents cannot be told is added all the same, saying why', async () => {
    const w = world()
    const adding = w.adder.add(REQUEST, w.keep)
    const connection = new FakeConnection().answer('setup:status', () => {
      throw new Error('setup:status is not served')
    })
    ;(await w.connecting()).resolve(fakeLocalHost(connection))
    expect(await adding).toMatchObject({ kind: 'added', agents: null, agentsError: 'setup:status is not served' })
  })

  it('refuses a name another host has, before anything is run', async () => {
    const w = world([{ id: 'h-old', name: 'build-box', transport: { kind: 'ssh', target: 'other' } }])
    await expect(w.adder.add(REQUEST, w.keep)).rejects.toThrow(/build-box/)
    expect(w.forgotten).toEqual([])
  })

  it('S8: a check under the same attempt is stopped by its Cancel', async () => {
    const w = world()
    let seen: AbortSignal | null = null
    const checking = w.adder.during('attempt-2', (signal) => {
      seen = signal
      return new Promise<string>((resolve) => signal.addEventListener('abort', () => resolve('stopped')))
    })
    w.adder.cancel('attempt-2')
    expect(await checking).toBe('stopped')
    expect((seen as AbortSignal | null)?.aborted).toBe(true)
  })
})
