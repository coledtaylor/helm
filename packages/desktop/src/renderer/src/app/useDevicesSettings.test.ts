import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RemoteHost } from '@helm/core/types'
import type { HostConnection } from '../../../shared/host/client'
import type * as P from '../../../shared/host/protocol'
import { devicesHosts, useDevicesSettings, type DevicesSettingsDeps } from './useDevicesSettings'
import type { AttachedUpdate, Devices, DevicesHostRef } from './host/devices'
import type { RemoteHostView } from './host/remoteHosts'

const host = (id: string): RemoteHost => ({
  id,
  name: id,
  transport: { kind: 'ssh', target: id }
})
const view = (connection: RemoteHostView['connection']): RemoteHostView => ({
  connection,
  sessions: []
})
const never = (): Promise<HostConnection> => new Promise(() => undefined)

const device = (name: string, fingerprint: string, away = false): P.AttachedDevice => ({
  fingerprint,
  name,
  away,
  since: '2026-11-03T09:00:00Z',
  connections: 1
})

/** A Devices whose watches the test speaks into, by host id. */
function fakeDevices(): Devices & {
  tell: (id: string, update: AttachedUpdate) => void
  watching: () => string[]
  disconnected: Array<[string, string]>
} {
  const listeners = new Map<string, (update: AttachedUpdate) => void>()
  const disconnected: Array<[string, string]> = []
  return {
    watchAttached(ref: DevicesHostRef, listener) {
      listeners.set(ref.id, listener)
      return () => listeners.delete(ref.id)
    },
    disconnect(ref, fingerprint) {
      disconnected.push([ref.id, fingerprint])
      return Promise.resolve({ ok: true })
    },
    tell: (id, update) => listeners.get(id)?.(update),
    watching: () => [...listeners.keys()],
    disconnected
  }
}

describe('the hosts Settings > Devices lists', () => {
  it('S12: This PC first, then each host on another computer that is connected now, in the order added', () => {
    const refs = devicesHosts(
      { localConnection: never, remoteConnection: never },
      [host('ops'), host('down'), host('lab')],
      {
        ops: view({ state: 'connected' }),
        down: view({ state: 'retrying' }),
        lab: view({ state: 'connected' })
      }
    )
    expect(refs.map((ref) => ref.name)).toEqual(['This PC', 'ops', 'lab'])
  })

  it('S12: a host not connected is not listed, whether retrying, its key changed or it failed', () => {
    const refs = devicesHosts({ localConnection: never, remoteConnection: never }, [host('a'), host('b'), host('c')], {
      a: view({ state: 'retrying' }),
      b: view({ state: 'keyChanged' }),
      c: view({
        state: 'failed',
        lastLine: 'ssh: connect to host c port 22: Connection refused'
      })
    })
    expect(refs.map((ref) => ref.name)).toEqual(['This PC'])
  })
})

describe('Settings > Devices, wired', () => {
  const deps = (devices: Devices): DevicesSettingsDeps => ({
    devices,
    localConnection: never,
    remoteConnection: never
  })

  it('S13: rows appear and leave as each host says, live, and each device is one row', () => {
    const devices = fakeDevices()
    const hosts = [host('lab')]
    const views = { lab: view({ state: 'connected' }) }
    const { result } = renderHook(() => useDevicesSettings(deps(devices), true, hosts, views))
    expect(devices.watching()).toEqual(['local', 'lab'])
    // Nothing heard yet: each host is still being looked at.
    expect(result.current.hosts.map((entry) => entry.attached)).toEqual([null, null])

    act(() =>
      devices.tell('local', {
        ok: true,
        devices: [device('desk', 'f1')],
        thisDevice: 'f1'
      })
    )
    act(() =>
      devices.tell('lab', {
        ok: true,
        devices: [device('desk', 'f1', true), device('phone', 'f2', true)],
        thisDevice: 'f1'
      })
    )
    expect(result.current.hosts).toEqual([
      {
        id: 'local',
        name: 'This PC',
        thisComputer: true,
        thisDevice: 'f1',
        attached: [
          {
            fingerprint: 'f1',
            name: 'desk',
            away: false,
            since: '2026-11-03T09:00:00Z'
          }
        ],
        error: null
      },
      {
        id: 'lab',
        name: 'lab',
        thisComputer: false,
        thisDevice: 'f1',
        attached: [
          {
            fingerprint: 'f1',
            name: 'desk',
            away: true,
            since: '2026-11-03T09:00:00Z'
          },
          {
            fingerprint: 'f2',
            name: 'phone',
            away: true,
            since: '2026-11-03T09:00:00Z'
          }
        ],
        error: null
      }
    ])

    act(() =>
      devices.tell('lab', {
        ok: true,
        devices: [device('desk', 'f1', true)],
        thisDevice: 'f1'
      })
    )
    expect(result.current.hosts[1]?.attached?.map((row) => row.name)).toEqual(['desk'])
  })

  it('S13: watches only while the section is on screen, and lets go when a host stops being connected', () => {
    const devices = fakeDevices()
    const hosts = [host('lab')]
    const { rerender } = renderHook(
      ({ shown, views }: { shown: boolean; views: Record<string, RemoteHostView> }) =>
        useDevicesSettings(deps(devices), shown, hosts, views),
      {
        initialProps: {
          shown: false,
          views: { lab: view({ state: 'connected' }) }
        }
      }
    )
    expect(devices.watching()).toEqual([])
    rerender({ shown: true, views: { lab: view({ state: 'connected' }) } })
    expect(devices.watching()).toEqual(['local', 'lab'])
    rerender({ shown: true, views: { lab: view({ state: 'retrying' }) } })
    expect(devices.watching()).toEqual(['local'])
    rerender({ shown: false, views: { lab: view({ state: 'retrying' }) } })
    expect(devices.watching()).toEqual([])
  })

  it('S14: Disconnect goes to the host the row is under, naming the device', async () => {
    const devices = fakeDevices()
    const hosts = [host('lab')]
    const views = { lab: view({ state: 'connected' }) }
    const { result } = renderHook(() => useDevicesSettings(deps(devices), true, hosts, views))
    const phone = {
      fingerprint: 'f2',
      name: 'phone',
      away: true,
      since: '2026-11-03T09:00:00Z'
    }
    expect(await result.current.onDisconnect('lab', phone)).toBeNull()
    expect(devices.disconnected).toEqual([['lab', 'f2']])
    expect(await result.current.onDisconnect('gone', phone)).toBe('That host is no longer connected.')
  })
})
