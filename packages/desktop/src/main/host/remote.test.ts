import type { RemoteHost } from '@helm/core/types'
import { describe, expect, it, vi } from 'vitest'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import type { RemoteHostStates } from '../../shared/ipc'
import type { LocalHost, PageBridge } from './launcher'
import type { HelmPage } from './page-link'
import { createPageLinks, routePageLinks } from './page-link'
import { createRemoteHostLinks, type RemoteHostLinksDeps } from './remote'
import { RemoteHostError, type OnPairing } from './remote-launcher'

const BUILD: RemoteHost = { id: 'h-build', name: 'build-box', transport: { kind: 'ssh', target: 'me@build-box' } }
const LAB: RemoteHost = {
  id: 'h-lab',
  name: 'lab',
  transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] }
}
const FAR: RemoteHost = { id: 'h-far', name: 'far-away', transport: { kind: 'ssh', target: 'far' } }

/** A start the test settles by hand, as a bridge that is still reaching its host. */
interface PendingStart {
  host: RemoteHost
  pairing: OnPairing
  resolve: (local: LocalHost) => void
  reject: (error: Error) => void
}

/** A page bridge the test plays: it records what it was given and ends when told. */
interface FakeBridge extends PageBridge {
  host: RemoteHost
  written: Uint8Array[]
  ended: Promise<string | null>
  endWith(why: string | null): void
}

/** Main's links to remote hosts, with every bridge and timer played by the test. */
function world() {
  const starts: PendingStart[] = []
  const bridges: FakeBridge[] = []
  const forgotten: string[] = []
  const told: RemoteHostStates[] = []
  const log: string[] = []
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  let nextConnection = 1
  const deps: RemoteHostLinksDeps = {
    start: (host, pairing) =>
      new Promise<LocalHost>((resolve, reject) => {
        starts.push({ host, pairing, resolve, reject })
      }),
    openBridge: (host) => {
      let end: (why: string | null) => void = () => undefined
      const bridge: FakeBridge = {
        host,
        written: [],
        write(bytes) {
          bridge.written.push(bytes)
        },
        end: () => end(null),
        ended: new Promise((resolve) => {
          end = resolve
        }),
        endWith: (why) => end(why)
      }
      bridges.push(bridge)
      return bridge
    },
    forget: (host) => {
      forgotten.push(host.id)
      return Promise.resolve()
    },
    changed: (states) => told.push(states),
    isHelmPage: () => true,
    appVersion: '2.4.0',
    nextConnection: () => nextConnection++,
    log: (line) => log.push(line),
    setTimeout: (run) => {
      const id = nextTimer++
      timers.set(id, run)
      return id
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number)
    }
  }
  const links = createRemoteHostLinks(deps)
  return {
    links,
    starts,
    bridges,
    forgotten,
    told,
    log,
    /** The last start for `host`. */
    startFor(host: RemoteHost): PendingStart {
      const found = starts.filter((start) => start.host.id === host.id).at(-1)
      if (found === undefined) throw new Error(`nothing started for ${host.name}`)
      return found
    },
    /** Fires every waiting timer: the backoff before the next try. */
    fireTimers() {
      const due = [...timers.values()]
      timers.clear()
      for (const run of due) run()
    },
    waitingTimers: () => timers.size,
    /** Where `host` stands now. */
    state: (host: RemoteHost) => links.states()[host.id]
  }
}

/** Lets every promise already settled run its callbacks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

/** A host's connection that answers which sessions this device started there. */
function hostWith(own: Array<{ id: number; name: string }> = []): FakeConnection {
  return new FakeConnection().answer('host:deviceSessions', () => own)
}

function page(id = 1): HelmPage & { sent: Array<{ channel: string; payload: unknown }> } {
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    id,
    sent,
    send: (channel, payload) => sent.push({ channel, payload }),
    onGone: () => undefined
  }
}

describe('the links to hosts on other computers', () => {
  it('S8: links each host over its own connection, and one that cannot be reached holds up none of the others', async () => {
    const w = world()
    w.links.sync([BUILD, LAB, FAR])
    expect(w.starts.map((start) => start.host.name)).toEqual(['build-box', 'lab', 'far-away'])

    // far-away never answers; lab's ssh fails; build-box connects.
    w.startFor(LAB).reject(new RemoteHostError('ssh: Could not resolve hostname lab: Name or service not known'))
    const build = hostWith()
    w.startFor(BUILD).resolve(fakeLocalHost(build, false))
    await settle()

    expect(w.links.states()).toEqual({
      'h-build': { state: 'connected' },
      'h-lab': { state: 'failed', lastLine: 'ssh: Could not resolve hostname lab: Name or service not known' }
    })
    // Each page reaches each host over a connection of its own, numbered from one counter.
    const window = page()
    const local = createPageLinks({
      inHost: true,
      appVersion: '2.4.0',
      isHelmPage: () => true,
      ready: () => Promise.resolve(),
      howEnded: () => ({ planned: false, restarts: false }),
      openBridge: () => ({ write: () => undefined, end: () => undefined, ended: new Promise(() => undefined) }),
      nextConnection: () => 100,
      log: () => undefined
    })
    const routed = routePageLinks(local, w.links)
    await expect(routed.open(window, 'h-build')).resolves.toEqual({ inHost: true, connection: 1, appVersion: '2.4.0' })
    await expect(routed.open(window, 'h-far')).resolves.toEqual({ inHost: true, unreachable: 'far-away is not connected.' })
    await expect(routed.open(window, null)).resolves.toEqual({ inHost: true, connection: 100, appVersion: '2.4.0' })
    expect(w.bridges.map((bridge) => bridge.host.name)).toEqual(['build-box'])

    // Bytes go to the one bridge whose connection they name.
    routed.send(window.id, 1, new Uint8Array([1, 2, 3]))
    expect(w.bridges[0]?.written).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('S9: a host whose connection drops is retrying, nothing is sent to end a session, and it comes back by itself', async () => {
    const w = world()
    w.links.sync([BUILD])
    const first = hostWith([{ id: 4, name: 'deploy' }])
    w.startFor(BUILD).resolve(fakeLocalHost(first, false))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'connected' })
    const window = page()
    await w.links.pageLinks(BUILD.id)?.open(window)

    // The ssh process ends: main's connection and the page's bridge with it.
    first.close()
    w.bridges[0]?.endWith('Connection to build-box closed by remote host.')
    await settle()

    expect(w.state(BUILD)).toEqual({ state: 'retrying' })
    expect(first.sent.map((request) => request.channel)).toEqual(['app:info', 'host:deviceSessions'])
    // The page hears an end that is no stop, and nothing restarts that host.
    expect(window.sent.at(-1)).toEqual({
      channel: 'hostLink:ended',
      payload: { connection: 1, why: 'Connection to build-box closed by remote host.', planned: false, restarts: false }
    })

    // The backoff passes; the next try reaches it, and it is connected again.
    expect(w.waitingTimers()).toBe(1)
    w.fireTimers()
    const second = hostWith([{ id: 4, name: 'deploy' }])
    w.startFor(BUILD).resolve(fakeLocalHost(second, false))
    await settle()
    expect(w.starts).toHaveLength(2)
    expect(w.state(BUILD)).toEqual({ state: 'connected' })
    expect(second.payloads('host:quit')).toEqual([])
  })

  it('S10: shows the pairing code while this device waits to be approved there, then connected', async () => {
    const w = world()
    w.links.sync([BUILD])
    w.startFor(BUILD).pairing('7Q2K-9XZD', null)
    expect(w.state(BUILD)).toEqual({ state: 'pairing', code: '7Q2K-9XZD' })
    expect(w.told.at(-1)).toEqual({ 'h-build': { state: 'pairing', code: '7Q2K-9XZD' } })

    // Someone ran `floti devices approve 7Q2K-9XZD` there.
    w.startFor(BUILD).resolve(fakeLocalHost(hostWith(), false))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'connected' })
    // The code went to the window only.
    expect(w.log.join('\n')).not.toContain('7Q2K-9XZD')
  })

  it('S6: shows why the one-step approval failed beside the code, and the role the host says once connected', async () => {
    const w = world()
    w.links.sync([{ ...BUILD, role: 'admin' }])
    w.startFor(BUILD).pairing('7Q2K-9XZD', 'floti devices: permission denied')
    expect(w.state(BUILD)).toEqual({
      state: 'pairing',
      code: '7Q2K-9XZD',
      approvalFailed: 'floti devices: permission denied'
    })
    const build = hostWith()
    Object.assign(build.welcome, { role: 'admin' })
    w.startFor(BUILD).resolve(fakeLocalHost(build, false))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'connected', role: 'admin' })
  })

  it('S10: Remove lets go of the host without a word to it, ends its page bridges and removes its client folder', async () => {
    const w = world()
    w.links.sync([BUILD, LAB])
    const build = hostWith([{ id: 4, name: 'deploy' }])
    const local = fakeLocalHost(build, false)
    w.startFor(BUILD).resolve(local)
    await settle()
    await w.links.pageLinks(BUILD.id)?.open(page())

    w.links.sync([LAB])
    await vi.waitFor(() => expect(w.forgotten).toEqual(['h-build']))

    expect(build.payloads('host:quit')).toEqual([])
    expect(build.payloads('host:stop')).toEqual([])
    expect(local.closed).toBe(true)
    expect(w.links.states()).toEqual({})
    expect(w.links.pageLinks(BUILD.id)).toBeNull()
    await expect(w.bridges[0]?.ended).resolves.toBeNull()
    // It is tried no more.
    w.fireTimers()
    expect(w.starts.filter((start) => start.host.id === BUILD.id)).toHaveLength(1)
  })

  it('S6: a transport that could not get in shows its last line, unedited, and is tried again', async () => {
    const w = world()
    w.links.sync([BUILD])
    w.startFor(BUILD).reject(new RemoteHostError('me@build-box: Permission denied (publickey,password).'))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'failed', lastLine: 'me@build-box: Permission denied (publickey,password).' })
    expect(w.waitingTimers()).toBe(1)
  })

  it('S13: names only what a quit would end per host, and tells each host its own choice; one not connected is told nothing', async () => {
    const w = world()
    w.links.sync([BUILD, LAB, FAR])
    const build = hostWith([{ id: 4, name: 'deploy' }, { id: 5, name: 'tests' }])
    const lab = hostWith([{ id: 9, name: 'notebook' }])
    w.startFor(BUILD).resolve(fakeLocalHost(build, false))
    w.startFor(LAB).resolve(fakeLocalHost(lab, false))
    await settle()

    // build-box is set to End, lab keeps them (the default).
    const endsOn = (id: string): boolean => id === BUILD.id
    expect(w.links.quitParts(endsOn)).toEqual([
      { id: 'h-build', name: 'build-box', sessions: [{ id: 4, name: 'deploy' }, { id: 5, name: 'tests' }] }
    ])

    // A session ends there: the count follows.
    build.answer('host:deviceSessions', () => [{ id: 5, name: 'tests' }])
    build.push('session:exit', { id: 4 } as never)
    await settle()
    expect(w.links.quitParts(endsOn)[0]?.sessions).toEqual([{ id: 5, name: 'tests' }])

    const quitting = w.links.quit(endsOn)
    await settle()
    w.fireTimers()
    await quitting
    expect(build.payloads('host:quit')).toEqual([{ end: true }])
    expect(lab.payloads('host:quit')).toEqual([{ end: false }])
  })
})
