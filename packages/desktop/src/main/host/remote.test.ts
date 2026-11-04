import { NO_HOST_LINE, type RemoteHost } from '@helm/core/types'
import { describe, expect, it, vi } from 'vitest'
import { FakeConnection, fakeLocalHost } from '../../../test/host-connection'
import type { RemoteHostStates } from '../../shared/ipc'
import type { LocalHost, PageBridge } from './launcher'
import type { HelmPage } from './page-link'
import { createPageLinks, routePageLinks } from './page-link'
import { createRemoteHostLinks, type RemoteHostLinksDeps } from './remote'
import { RECONNECT_FIRST_MS, RECONNECT_MOST_MS } from '../../shared/host/reconnect'
import { KEY_CHANGED_LINE, RemoteHostError } from './remote-launcher'

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
  const recorded: string[][] = []
  const told: RemoteHostStates[] = []
  const log: string[] = []
  const timers = new Map<number, () => void>()
  const waits = new Map<number, number>()
  let nextTimer = 1
  let nextConnection = 1
  const deps: RemoteHostLinksDeps = {
    start: (host) =>
      new Promise<LocalHost>((resolve, reject) => {
        starts.push({ host, resolve, reject })
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
    hostsChanged: (hosts) => recorded.push(hosts.map((host) => host.name)),
    isHelmPage: () => true,
    appVersion: '2.4.0',
    nextConnection: () => nextConnection++,
    log: (line) => log.push(line),
    setTimeout: (run, ms) => {
      const id = nextTimer++
      timers.set(id, run)
      waits.set(id, ms)
      return id
    },
    clearTimeout: (timer) => {
      timers.delete(timer as number)
      waits.delete(timer as number)
    }
  }
  const links = createRemoteHostLinks(deps)
  return {
    links,
    starts,
    bridges,
    forgotten,
    recorded,
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
      waits.clear()
      for (const run of due) run()
    },
    waitingTimers: () => timers.size,
    /** How long each timer waiting now waits, oldest first. */
    waitsNow: () => [...waits.values()],
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
  it('S6: tells floti doctor the hosts this device added at the first sync and at each change, and not again for the same hosts', () => {
    const w = world()
    w.links.sync([])
    w.links.sync([BUILD])
    w.links.sync([BUILD])
    w.links.sync([BUILD, FAR])
    w.links.sync([FAR])
    expect(w.recorded).toEqual([[], ['build-box'], ['build-box', 'far-away'], ['far-away']])
  })

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
      'h-build': { state: 'connected', version: 'test' },
      'h-lab': { state: 'failed', lastLine: 'ssh: Could not resolve hostname lab: Name or service not known' }
    })
    // Each page reaches each host over a connection of its own, numbered from one counter.
    const window = page()
    const local = createPageLinks({
      appVersion: '2.4.0',
      isHelmPage: () => true,
      ready: () => Promise.resolve(),
      howEnded: () => ({ planned: false, restarts: false }),
      openBridge: () => ({ write: () => undefined, end: () => undefined, ended: new Promise(() => undefined) }),
      nextConnection: () => 100,
      log: () => undefined
    })
    const routed = routePageLinks(local, w.links)
    await expect(routed.open(window, 'h-build')).resolves.toEqual({ connection: 1, appVersion: '2.4.0' })
    await expect(routed.open(window, 'h-far')).resolves.toEqual({ unreachable: 'far-away is not connected.' })
    await expect(routed.open(window, null)).resolves.toEqual({ connection: 100, appVersion: '2.4.0' })
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
    expect(w.state(BUILD)).toEqual({ state: 'connected', version: 'test' })
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
    expect(w.state(BUILD)).toEqual({ state: 'connected', version: 'test' })
    expect(second.payloads('host:quit')).toEqual([])
  })

  it('S8: a host that cannot be reached is tried again after waits that start short and double up to two minutes, never longer, while another host keeps working', async () => {
    const w = world()
    w.links.sync([BUILD, LAB])
    const lab = hostWith()
    w.startFor(LAB).resolve(fakeLocalHost(lab, false))
    const unreachable = 'ssh: connect to host build-box port 22: Connection timed out'
    w.startFor(BUILD).reject(new RemoteHostError(unreachable))
    await settle()

    const waits: number[] = []
    for (let tries = 0; tries < 12; tries += 1) {
      expect(w.waitsNow()).toHaveLength(1)
      waits.push(w.waitsNow()[0]!)
      w.fireTimers()
      w.startFor(BUILD).reject(new RemoteHostError(unreachable))
      await settle()
    }
    expect(waits).toEqual([
      RECONNECT_FIRST_MS,
      RECONNECT_FIRST_MS * 2,
      RECONNECT_FIRST_MS * 4,
      RECONNECT_FIRST_MS * 8,
      RECONNECT_FIRST_MS * 16,
      RECONNECT_FIRST_MS * 32,
      RECONNECT_FIRST_MS * 64,
      RECONNECT_FIRST_MS * 128,
      RECONNECT_FIRST_MS * 256,
      RECONNECT_MOST_MS,
      RECONNECT_MOST_MS,
      RECONNECT_MOST_MS
    ])
    expect(Math.max(...waits)).toBe(120_000)
    // lab was connected the whole time, tried once and never again, and answers.
    expect(w.state(LAB)).toEqual({ state: 'connected', version: 'test' })
    expect(w.starts.filter((start) => start.host.id === LAB.id)).toHaveLength(1)
    expect(w.state(BUILD)).toEqual({ state: 'failed', lastLine: unreachable })
  })

  it('S8: Reconnect now drops the wait and tries at once, the next wait starting short again; a connected host is not tried again', async () => {
    const w = world()
    w.links.sync([BUILD, LAB])
    const lab = hostWith()
    w.startFor(LAB).resolve(fakeLocalHost(lab, false))
    const denied = 'me@build-box: Permission denied (publickey,password).'
    w.startFor(BUILD).reject(new RemoteHostError(denied))
    await settle()
    // Some tries in, the wait has grown.
    for (let tries = 0; tries < 4; tries += 1) {
      w.fireTimers()
      w.startFor(BUILD).reject(new RemoteHostError(denied))
      await settle()
    }
    expect(w.waitsNow()).toEqual([RECONNECT_FIRST_MS * 16])
    const startsBefore = w.starts.length

    w.links.reconnect(BUILD.id)
    // Tried at once, and no wait is left running beside the try.
    expect(w.starts).toHaveLength(startsBefore + 1)
    expect(w.startFor(BUILD).host.id).toBe(BUILD.id)
    expect(w.waitsNow()).toEqual([])
    w.startFor(BUILD).reject(new RemoteHostError(denied))
    await settle()
    expect(w.waitsNow()).toEqual([RECONNECT_FIRST_MS])

    // Pressed again while a try is in flight: one try, not two.
    w.links.reconnect(BUILD.id)
    w.links.reconnect(BUILD.id)
    expect(w.starts).toHaveLength(startsBefore + 2)
    const build = hostWith()
    w.startFor(BUILD).resolve(fakeLocalHost(build, false))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'connected', version: 'test' })

    // A connected host has nothing to reconnect: nothing is started or sent.
    w.links.reconnect(LAB.id)
    w.links.reconnect(BUILD.id)
    expect(w.starts).toHaveLength(startsBefore + 2)
    expect(build.sent.map((request) => request.channel)).toEqual(['app:info', 'host:deviceSessions'])
    expect(lab.sent.map((request) => request.channel)).toEqual(['app:info', 'host:deviceSessions'])
  })

  it('S4: a host added is connected at its first connection, with nothing shown or asked meanwhile', async () => {
    const w = world()
    w.links.sync([BUILD])
    // Nothing is heard while the first connection is made: no code, no approval.
    expect(w.state(BUILD)).toBeUndefined()
    expect(w.told).toEqual([])
    w.startFor(BUILD).resolve(fakeLocalHost(hostWith(), false))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'connected', version: 'test' })
    expect(w.told.at(-1)).toEqual({ 'h-build': { state: 'connected', version: 'test' } })
  })

  it('S7: a host that proves another key than the one pinned is keyChanged, and stays so while it keeps proving it', async () => {
    const w = world()
    w.links.sync([BUILD])
    w.startFor(BUILD).reject(new RemoteHostError(KEY_CHANGED_LINE, null, true))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'keyChanged' })
    w.fireTimers()
    w.startFor(BUILD).reject(new RemoteHostError(KEY_CHANGED_LINE, null, true))
    await settle()
    expect(w.state(BUILD)).toEqual({ state: 'keyChanged' })
    expect(w.forgotten).toEqual([])
  })

  it('S8: removing a host and adding the same target again starts from no pin, and pins what the host proves then', async () => {
    const w = world()
    w.links.sync([BUILD])
    w.startFor(BUILD).reject(new RemoteHostError(KEY_CHANGED_LINE, null, true))
    await settle()
    w.links.sync([])
    // Its client folder, which holds the key it pinned, is removed.
    await vi.waitFor(() => expect(w.forgotten).toEqual(['h-build']))
    const again: RemoteHost = { ...BUILD, id: 'h-build-again' }
    w.links.sync([again])
    w.startFor(again).resolve(fakeLocalHost(hostWith(), false))
    await settle()
    expect(w.state(again)).toEqual({ state: 'connected', version: 'test' })
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

  it('S18: a host whose floti is too old, or newer, says so with both protocol versions; one with no floti is missing', async () => {
    const w = world()
    w.links.sync([BUILD, LAB, FAR])
    w.startFor(BUILD).reject(
      new RemoteHostError('update floti there', { host: '0.9', client: '1.0', update: 'host' })
    )
    w.startFor(LAB).reject(new RemoteHostError('update Helm here', { host: '2.0', client: '1.0', update: 'client' }))
    w.startFor(FAR).reject(new RemoteHostError('bash: line 1: floti: command not found'))
    await settle()
    expect(w.links.states()).toEqual({
      'h-build': { state: 'tooOld', host: '0.9', client: '1.0' },
      'h-lab': { state: 'newer', host: '2.0', client: '1.0' },
      'h-far': { state: 'missing', lastLine: 'bash: line 1: floti: command not found' }
    })
  })

  it('S17: a host installed while nobody is signed in there starts at the next sign-in, not failed; once reached it is connected', async () => {
    const w = world()
    const placed = { ...BUILD, floti: '/home/me/.local/bin/floti' }
    w.links.sync([placed])
    w.startFor(placed).reject(new RemoteHostError(NO_HOST_LINE))
    await settle()
    expect(w.state(placed)).toEqual({ state: 'failed', lastLine: NO_HOST_LINE })

    // Installing at the path the host keeps links it again at once.
    w.links.installed(placed.id, placed.floti, true)
    expect(w.starts.length).toBe(2)
    w.startFor(placed).reject(new RemoteHostError(NO_HOST_LINE))
    await settle()
    expect(w.state(placed)).toEqual({ state: 'startsAtSignIn' })

    w.fireTimers()
    w.startFor(placed).resolve(fakeLocalHost(hostWith(), false))
    await settle()
    expect(w.state(placed)).toEqual({ state: 'connected', version: 'test' })
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

  it('S5: a host added by connecting keeps the connection the add made: no second start, connected with its floti version, kept by the sync that lists it', async () => {
    const w = world()
    const local = fakeLocalHost(hostWith())
    w.links.adopt(BUILD, local)
    await settle()
    expect(w.starts).toHaveLength(0)
    expect(w.state(BUILD)).toEqual({ state: 'connected', version: 'test' })
    w.links.sync([BUILD])
    await settle()
    expect(w.starts).toHaveLength(0)
    expect(local.closed).toBe(false)
    expect(w.forgotten).toEqual([])
    expect(w.links.pageLinks(BUILD.id)).not.toBeNull()
  })

  it('S2: a host added this way and then removed is let go of and its client folder removed', async () => {
    const w = world()
    const local = fakeLocalHost(hostWith())
    w.links.adopt(BUILD, local)
    w.links.sync([BUILD])
    await settle()
    w.links.sync([])
    await settle()
    await vi.waitFor(() => expect(w.forgotten).toEqual([BUILD.id]))
    expect(local.closed).toBe(true)
    expect(w.state(BUILD)).toBeUndefined()
  })
})
