import { DEFAULT_SETTINGS, LOCAL_HOST_KEY } from '@helm/core/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach } from '../../../../../test/fake-connection'
import type { RemoteHostStates } from '../../../../shared/ipc'
import { bridge } from '../bridge.testkit'
import {
  SHELF_KEY,
  createConnectedHosts,
  createHostBridges,
  pickerOnThisPc,
  remoteOwn,
  shelfKeyFor
} from './hostBridges'
import type { PageLink } from './link'
import type { RemoteHostView } from './remoteHosts'
import { ownSettingsElsewhere } from './workspace'

const HOST_SETTINGS = { scanRoots: ['/srv'], pinnedProjects: [], firstRunCompletedAt: null }

/** A host that answers the few requests these tests make, and records every one. */
function host(): FakeConnection {
  return new FakeConnection()
    .answer('session:list', () => [])
    .answer('roots:suggest', () => [] as never)
    .answer('settings:read', () => HOST_SETTINGS as never)
    .answer('settings:write', (patch) => ({ ...HOST_SETTINGS, ...(patch as object) }) as never)
}

/** A page link to `connection`, with main's answer on whether sessions run in the local host. */
function linkTo(connection: FakeConnection, inHost = true): PageLink {
  return { ...fakeReach(connection), inHost: () => Promise.resolve(inHost) } as unknown as PageLink
}

/** This PC's host and two hosts on other computers, each reached over a link of its own. */
function world(inHost = true) {
  bridge.reset()
  bridge.answer('ownSettings:read', () => DEFAULT_SETTINGS)
  bridge.answer('ownSettings:write', (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
  const connections: Record<string, FakeConnection> = { [LOCAL_HOST_KEY]: host(), 'h-build': host(), 'h-lab': host() }
  const linked: string[] = []
  const storage = new Map<string, string>()
  const bridges = createHostBridges({
    own: bridge,
    localLink: linkTo(connections[LOCAL_HOST_KEY]!, inHost),
    remoteLink: (id) => {
      linked.push(id)
      const connection = connections[id]
      if (connection === undefined) throw new Error(`no host ${id} in this test`)
      return linkTo(connection)
    },
    front: { focused: () => true, onChange: () => undefined },
    storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => void storage.set(key, value) },
    nameOf: (id) => (id === 'h-build' ? 'build-box' : id),
    log: () => undefined
  })
  /** The requests each host was sent, by channel. */
  const asked = (id: string): string[] => connections[id]!.sent.map((request) => request.channel)
  return { bridges, connections, asked, linked, storage }
}

beforeEach(() => {
  bridge.reset()
})

describe('one bridge per host', () => {
  it('a request on build-box’s bridge reaches only build-box’s link', async () => {
    const w = world()
    await w.bridges.bridgeFor('h-build').invoke('roots:suggest')
    expect(w.asked('h-build')).toContain('roots:suggest')
    expect(w.asked('h-lab')).not.toContain('roots:suggest')
    expect(w.asked(LOCAL_HOST_KEY)).not.toContain('roots:suggest')
    // Nothing of it went to main either.
    expect(bridge.invoked('roots:suggest')).toEqual([])

    await w.bridges.bridgeFor(LOCAL_HOST_KEY).invoke('roots:suggest')
    expect(w.asked(LOCAL_HOST_KEY)).toContain('roots:suggest')
    expect(w.asked('h-build').filter((channel) => channel === 'roots:suggest')).toHaveLength(1)
  })

  it('makes one link and one bridge per host, the same each time it is asked', () => {
    const w = world()
    const first = w.bridges.hostBridge('h-build')
    expect(w.bridges.hostBridge('h-build')).toBe(first)
    expect(w.bridges.bridgeFor('h-build')).toBe(first.helm)
    expect(w.linked).toEqual(['h-build'])

    const seen: string[] = []
    w.bridges.each((made) => seen.push(made.host))
    w.bridges.hostBridge('h-lab')
    expect(seen).toEqual([LOCAL_HOST_KEY, 'h-build', 'h-lab'])
  })

  it('this device’s settings never go to a remote router: a write of them there is refused, and its host’s half goes to that host only', async () => {
    const w = world()
    const build = w.bridges.bridgeFor('h-build')

    await expect(build.invoke('settings:write', { theme: 'dark' })).rejects.toThrow(ownSettingsElsewhere('build-box'))
    await expect(build.invoke('settings:write', { scanRoots: ['/srv'], paneLayout: null })).rejects.toThrow(
      ownSettingsElsewhere('build-box')
    )
    expect(w.asked('h-build')).not.toContain('settings:write')
    expect(bridge.invoked('ownSettings:write')).toEqual([])

    const written = await build.invoke('settings:write', { scanRoots: ['/srv', '/opt'] })
    expect(w.connections['h-build']!.payloads('settings:write')).toEqual([{ scanRoots: ['/srv', '/opt'] }])
    expect(w.asked(LOCAL_HOST_KEY)).not.toContain('settings:write')
    expect(written.scanRoots).toEqual(['/srv', '/opt'])
    // The rest is this device's own, read from main and never from the host.
    expect(written.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(bridge.invoked('ownSettings:write')).toEqual([])

    // This PC's bridge writes this device's settings through main, as it always has.
    await w.bridges.bridgeFor(LOCAL_HOST_KEY).invoke('settings:write', { theme: 'dark' })
    expect(bridge.invoked('ownSettings:write')).toEqual([{ theme: 'dark' }])
    expect(w.asked('h-build').filter((channel) => channel === 'settings:write')).toHaveLength(1)
  })

  it('sends client-only channels on a remote router to the preload’s bridge, as this PC’s does', async () => {
    const w = world()
    bridge.answer('clipboard:read', () => ({ text: 'copied' }))
    expect(await w.bridges.bridgeFor('h-build').invoke('clipboard:read')).toEqual({ text: 'copied' })
    expect(w.asked('h-build')).not.toContain('clipboard:read')
  })

  it('with only this PC and sessions in Helm, every call goes where it goes today: the preload’s bridge', async () => {
    const w = world(false)
    bridge.answer('roots:suggest', () => [])
    await w.bridges.bridgeFor(LOCAL_HOST_KEY).invoke('roots:suggest')
    expect(bridge.invoked('roots:suggest')).toHaveLength(1)
    expect(w.asked(LOCAL_HOST_KEY)).toEqual([])
    // No remote link is made unless a host is asked for.
    expect(w.linked).toEqual([])
  })

  it('keeps each host’s terminal tabs under a key of its own, this PC’s where it always was', () => {
    expect(shelfKeyFor(LOCAL_HOST_KEY)).toBe(SHELF_KEY)
    expect(shelfKeyFor('h-build')).toBe(`${SHELF_KEY}.h-build`)
    expect(shelfKeyFor('h-lab')).not.toBe(shelfKeyFor('h-build'))
  })
})

describe('the preload’s bridge as a remote host’s adapters see it', () => {
  it('hears none of main’s word about this PC’s host, offers no picker of this PC’s folders, and passes the rest', async () => {
    const own = remoteOwn(bridge, () => 'build-box')
    const heard: string[] = []
    own.on('windowSessions:quitConfirm', () => heard.push('quit'))
    own.on('pluginBackground:changed', () => heard.push('background'))
    own.on('ownSettings:changed', () => heard.push('settings'))
    bridge.emit('windowSessions:quitConfirm', { id: 1 } as never)
    bridge.emit('pluginBackground:changed', [])
    bridge.emit('ownSettings:changed', DEFAULT_SETTINGS)
    // Main's background reports cover every host; the plugins adapter keeps its own host's.
    expect(heard).toEqual(['background', 'settings'])

    expect(await own.invoke('windowSessions:lostLayout')).toBeNull()
    await expect(own.invoke('path:chooseDirectory', { title: 'Add a plugin folder' })).rejects.toThrow(
      pickerOnThisPc('build-box')
    )
    await expect(own.invoke('ownSettings:write', { theme: 'dark' })).rejects.toThrow()
    own.send('windowSessions:notify', {} as never)
    expect(bridge.sent('windowSessions:notify')).toEqual([])
    expect(bridge.invocations.map((call) => call.channel)).toEqual([])
  })
})

describe('the hosts connected now', () => {
  it('lists the remote hosts main says are connected, and tells its listeners only when that list changes', () => {
    let view: Record<string, RemoteHostView> = {}
    let tell: () => void = () => undefined
    const connected = createConnectedHosts({
      get: () => view,
      subscribe: (listener) => {
        tell = listener
        return () => undefined
      }
    })
    let told = 0
    connected.subscribe(() => (told += 1))
    const states = (next: RemoteHostStates): void => {
      view = Object.fromEntries(Object.entries(next).map(([id, connection]) => [id, { connection, sessions: [] }]))
      tell()
    }

    states({ 'h-build': { state: 'connected' }, 'h-lab': { state: 'retrying' } })
    expect(connected.get()).toEqual(['h-build'])
    const first = connected.get()
    states({ 'h-build': { state: 'connected' }, 'h-lab': { state: 'retrying' } })
    expect(connected.get()).toBe(first)
    states({ 'h-build': { state: 'retrying' }, 'h-lab': { state: 'connected' } })
    expect(connected.get()).toEqual(['h-lab'])
    expect(told).toBe(2)
  })
})
