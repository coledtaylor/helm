import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RemoteHost } from '@helm/core/types'
import { FakeConnection } from '../../../../test/fake-connection'
import type { HostConnection } from '../../../shared/host/client'
import type * as P from '../../../shared/host/protocol'
import { createDevices } from './host/devices'
import { devicesHosts, mergeAuditHead, useDevicesSettings, type DevicesSettingsDeps } from './useDevicesSettings'
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

const ME: P.PairedDevice = {
  name: 'this laptop',
  role: 'admin',
  pairedAt: '2026-11-03T09:00:00Z',
  revokedAt: null,
  fingerprint: 'bbbb2222'
}
const PHONE: P.PairedDevice = { ...ME, name: 'phone', role: 'viewer', fingerprint: 'aaaa1111' }

/** An entry recording `phone` attaching, numbered `number`. */
const entry = (number: number): P.AuditEntry => ({
  number,
  at: `2026-11-03T10:${String(number).padStart(2, '0')}:00Z`,
  event: { kind: 'connected', device: { fingerprint: PHONE.fingerprint, name: 'phone', role: 'viewer' }, away: true }
})

describe('the hosts Settings > Devices lists', () => {
  it('S3: This PC first, then every connected host on another computer, whatever this device is there, in the order added', () => {
    const refs = devicesHosts(
      { localConnection: never, remoteConnection: never },
      [host('ops'), host('build'), host('down'), host('lab')],
      {
        ops: view({ state: 'connected', role: 'operator' }),
        build: view({ state: 'connected', role: 'admin' }),
        down: view({ state: 'retrying' }),
        lab: view({ state: 'connected', role: 'viewer' })
      }
    )
    expect(refs.map((ref) => ref.name)).toEqual(['This PC', 'ops', 'build', 'lab'])
  })
})

describe('a host’s audit log as read so far', () => {
  const page = (numbers: number[], more: boolean): P.AuditPage => ({ entries: numbers.map(entry), more })

  it('S14: the first page is the log as read', () => {
    expect(mergeAuditHead(undefined, page([12, 11], true))).toMatchObject({
      entries: [entry(12), entry(11)],
      more: true,
      loading: false
    })
  })

  it('S14: a newer page puts new entries on top and keeps the older pages read', () => {
    const read = { entries: [12, 11, 10].map(entry), more: false, loading: false, error: null }
    expect(mergeAuditHead(read, page([14, 13, 12], true)).entries.map((e) => e.number)).toEqual([14, 13, 12, 11, 10])
    expect(mergeAuditHead(read, page([14, 13, 12], true)).more).toBe(false)
  })

  it('S14: more new entries than a page holds start the log again from that page', () => {
    const read = { entries: [3, 2].map(entry), more: false, loading: false, error: null }
    expect(mergeAuditHead(read, page([9, 8], true))).toMatchObject({ entries: [entry(9), entry(8)], more: true })
  })
})

describe('Settings > Devices, wired', () => {
  function world() {
    let paired = [ME, PHONE]
    const local = new FakeConnection()
      .answer('devices:list', () => ({ paired, waiting: [] }))
      .answer('devices:audit', ({ before }) =>
        before === undefined ? { entries: [entry(12), entry(11)], more: true } : { entries: [entry(10)], more: false }
      )
      .answer('devices:role', ({ fingerprint, role }) => {
        paired = paired.map((device) => (device.fingerprint === fingerprint ? { ...device, role } : device))
        return paired.find((device) => device.fingerprint === fingerprint)!
      })
    Object.assign(local.welcome, { device: ME.fingerprint, role: 'admin' })
    const remote = new FakeConnection()
    Object.assign(remote.welcome, { device: 'eeee5555', role: 'operator' })
    const deps: DevicesSettingsDeps = {
      devices: createDevices({ confirmPresence: () => Promise.resolve('confirmed'), log: () => undefined }),
      localConnection: () => Promise.resolve(local.asConnection()),
      remoteConnection: () => Promise.resolve(remote.asConnection())
    }
    const hosts = [host('build')]
    const views = { build: view({ state: 'connected', role: 'operator' }) }
    const hook = renderHook(() => useDevicesSettings(deps, true, hosts, views))
    return { local, remote, hook }
  }

  it('S3: every connected host, with who is attached now; paired devices and the audit log only where this device is an admin', async () => {
    const { local, remote, hook } = world()
    await waitFor(() => expect(hook.result.current.hosts?.map((h) => h.name)).toEqual(['This PC', 'build']))
    await waitFor(() => expect(remote.subscriptions.has('devices:attached')).toBe(true))
    await waitFor(() => expect(local.subscriptions.has('devices:attached')).toBe(true))
    const attached: P.AttachedDevice = {
      fingerprint: 'eeee5555',
      name: 'this laptop',
      role: 'operator',
      away: true,
      since: '2026-11-03T08:00:00Z',
      connections: 2
    }
    act(() => remote.snapshot('devices:attached', { devices: [attached] }))
    const [pc, build] = hook.result.current.hosts!
    expect(build).toMatchObject({
      admin: false,
      thisComputer: false,
      thisDevice: 'eeee5555',
      paired: [],
      audit: null,
      attached: [{ fingerprint: 'eeee5555', name: 'this laptop', role: 'operator', away: true, since: '2026-11-03T08:00:00Z' }]
    })
    expect(remote.payloads('devices:list')).toEqual([])
    expect(remote.payloads('devices:audit')).toEqual([])
    expect(pc).toMatchObject({ admin: true, thisComputer: true, paired: [ME, PHONE] })
    // Live: the host's next list replaces the last, without asking again.
    act(() => remote.push('devices:attached', { devices: [] }))
    expect(hook.result.current.hosts![1]!.attached).toEqual([])
    hook.unmount()
    expect(remote.subscriptions.has('devices:attached')).toBe(false)
  })

  it('S14: the admin host’s audit log, newest first, and Show more reads the entries before the oldest shown', async () => {
    const { local, hook } = world()
    await waitFor(() =>
      expect(hook.result.current.hosts?.[0]?.audit?.entries.map((e) => e.number)).toEqual([12, 11])
    )
    expect(hook.result.current.hosts![0]!.audit).toMatchObject({ more: true, loading: false, error: null })
    expect(hook.result.current.hosts![0]!.audit!.entries[0]).toMatchObject({
      what: 'Attached',
      device: 'phone',
      fingerprint: PHONE.fingerprint,
      away: true
    })
    act(() => hook.result.current.onMoreAudit('local'))
    await waitFor(() =>
      expect(hook.result.current.hosts?.[0]?.audit?.entries.map((e) => e.number)).toEqual([12, 11, 10])
    )
    expect(hook.result.current.hosts![0]!.audit!.more).toBe(false)
    expect(local.payloads('devices:audit')).toContainEqual({ before: 11 })
    hook.unmount()
  })

  it('S15: a role change asks the host, and the row shows the role it answered with', async () => {
    const { local, hook } = world()
    await waitFor(() => expect(hook.result.current.hosts?.[0]?.paired).toEqual([ME, PHONE]))
    let said: string | null = 'not yet'
    await act(async () => {
      said = await hook.result.current.onRole('local', PHONE, 'operator')
    })
    expect(said).toBeNull()
    expect(local.payloads('devices:role')).toEqual([{ fingerprint: PHONE.fingerprint, role: 'operator' }])
    expect(hook.result.current.hosts![0]!.paired.find((d) => d.fingerprint === PHONE.fingerprint)?.role).toBe(
      'operator'
    )
    hook.unmount()
  })
})
