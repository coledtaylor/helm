import type { RemoteHost } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLocalHost, reconnectingLink } from '../../../test/host-connection'
import type { LocalHost } from './launcher'
import type * as P from './protocol'
import { createRemoteHostLinks } from './remote'
import { createWslKeepAwake } from './wsl-awake'

/**
 * Keeping a WSL distro running while its host has sessions, on main's links:
 * this PC's own host link, and the links to the hosts this device added, each
 * played by the test.
 */

const DEBIAN: RemoteHost = { id: 'h-debian', name: 'Debian', transport: { kind: 'wsl', distro: 'Debian' } }
const WIN_BOX: RemoteHost = {
  id: 'h-win',
  name: 'win-box',
  transport: { kind: 'ssh', target: 'win-box' },
  system: { os: 'Windows', cpu: 'x86_64' }
}
const UBUNTU_THERE: RemoteHost = {
  id: 'h-ubuntu',
  name: 'Ubuntu on win-box',
  transport: { kind: 'wsl', distro: 'Ubuntu', through: 'win-box' },
  floti: '/home/me/.local/bin/floti'
}

const RUNNING: P.SessionActivityState[] = [{ id: 1, activity: null, waitingFor: null } as unknown as P.SessionActivityState]

/** Lets every promise already settled run its callbacks. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function world() {
  const local = new FakeConnection()
  const localLink = reconnectingLink(local)
  const starts = new Map<string, Array<(connected: LocalHost) => void>>()
  const log: string[] = []
  // eslint-disable-next-line prefer-const
  let links: ReturnType<typeof createRemoteHostLinks>
  const wsl = createWslKeepAwake({
    local: () => localLink.current(),
    reachedWithSsh: (target) => links.reachedWithSsh(target),
    log: (line) => log.push(line)
  })
  localLink.onConnected(() => wsl.localConnected())
  links = createRemoteHostLinks({
    start: (host) =>
      new Promise<LocalHost>((resolve) => {
        starts.set(host.id, [...(starts.get(host.id) ?? []), resolve])
      }),
    openBridge: () => {
      throw new Error('no page bridge in these tests')
    },
    forget: () => Promise.resolve(),
    changed: () => undefined,
    isHelmPage: () => true,
    appVersion: '3.0.0',
    nextConnection: () => 1,
    wsl,
    log: (line) => log.push(line),
    setTimeout: () => 0,
    clearTimeout: () => undefined
  })
  return {
    local,
    localLink,
    links,
    log,
    /** Connects `host` on a new connection the test plays. */
    async connect(host: RemoteHost): Promise<FakeConnection> {
      const connection = new FakeConnection().answer('host:deviceSessions', () => [])
      const waiting = starts.get(host.id)?.shift()
      if (waiting === undefined) throw new Error(`nothing started for ${host.name}`)
      waiting(fakeLocalHost(connection, false))
      await settle()
      return connection
    },
    /** What `connection` was asked to keep awake, in order. */
    asks: (connection: FakeConnection) => connection.payloads('wsl:keepAwake')
  }
}

describe('keeping a WSL distro awake while its host has sessions', () => {
  it('S6: a running session in a distro on this PC asks this PC’s host, at once', async () => {
    const w = world()
    await w.localLink.connection()
    w.links.sync([DEBIAN])
    const debian = await w.connect(DEBIAN)
    expect(w.asks(w.local)).toEqual([])
    debian.snapshot('session:activity', RUNNING)
    await settle()
    expect(w.asks(w.local)).toEqual([{ distro: 'Debian' }])
    // Another activity on the same connection asks nothing more.
    debian.push('session:activity', RUNNING)
    await settle()
    expect(w.asks(w.local)).toHaveLength(1)
  })

  it('S6: a distro through a Windows host is asked of that host’s link, with the floti there; never of this PC’s', async () => {
    const w = world()
    await w.localLink.connection()
    w.links.sync([WIN_BOX, UBUNTU_THERE])
    const win = await w.connect(WIN_BOX)
    const ubuntu = await w.connect(UBUNTU_THERE)
    ubuntu.snapshot('session:activity', RUNNING)
    await settle()
    expect(w.asks(win)).toEqual([{ distro: 'Ubuntu', floti: '/home/me/.local/bin/floti' }])
    expect(w.asks(w.local)).toEqual([])
  })

  it('S6: none is asked while no session runs, and a session ending stops the asks', async () => {
    const w = world()
    await w.localLink.connection()
    w.links.sync([DEBIAN])
    const debian = await w.connect(DEBIAN)
    debian.snapshot('session:activity', [])
    await settle()
    expect(w.asks(w.local)).toEqual([])
    // The local link coming back asks for nothing either.
    await w.localLink.reconnect(w.local)
    expect(w.asks(w.local)).toEqual([])
  })

  it('S6: asked again after this PC’s host link comes back, and after the WSL host’s link does', async () => {
    const w = world()
    await w.localLink.connection()
    w.links.sync([DEBIAN])
    const debian = await w.connect(DEBIAN)
    debian.snapshot('session:activity', RUNNING)
    await settle()
    expect(w.asks(w.local)).toHaveLength(1)

    // This PC's host restarted: its new connection is asked again.
    const again = new FakeConnection()
    await w.localLink.reconnect(again)
    expect(w.asks(again)).toEqual([{ distro: 'Debian' }])

    // The distro's link drops and comes back: its snapshot asks again.
    debian.close()
    await settle()
    // The link waits out a backoff before it tries; the test plays no timer,
    // so Reconnect now makes it try at once.
    w.links.reconnect(DEBIAN.id)
    await settle()
    const debianAgain = await w.connect(DEBIAN)
    debianAgain.snapshot('session:activity', RUNNING)
    await settle()
    expect(w.asks(again)).toHaveLength(2)
  })

  it('S6: a Windows host not connected yet is asked once its link connects', async () => {
    const w = world()
    await w.localLink.connection()
    w.links.sync([UBUNTU_THERE, WIN_BOX])
    const ubuntu = await w.connect(UBUNTU_THERE)
    ubuntu.snapshot('session:activity', RUNNING)
    await settle()
    const win = await w.connect(WIN_BOX)
    expect(w.asks(win)).toEqual([{ distro: 'Ubuntu', floti: '/home/me/.local/bin/floti' }])
  })

  it('a host that refuses says so in the log, and nothing else changes', async () => {
    const w = world()
    w.local.answer('wsl:keepAwake', () => {
      throw new Error('There is no WSL on this computer.')
    })
    await w.localLink.connection()
    w.links.sync([DEBIAN])
    const debian = await w.connect(DEBIAN)
    debian.snapshot('session:activity', RUNNING)
    await settle()
    expect(w.log.some((line) => line.includes('There is no WSL on this computer.'))).toBe(true)
  })
})
