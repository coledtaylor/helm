import { describe, expect, it } from 'vitest'
import { FakeConnection } from '../../../../../test/fake-connection'
import { HostRequestError } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type { PresenceAnswer } from '../../../../shared/ipc'
import { PRESENCE_DECLINED, createDevices, presenceUnavailable, type DevicesHostRef } from './devices'

const PHONE: P.PairedDevice = {
  name: 'phone',
  role: 'viewer',
  pairedAt: '2026-11-03T09:00:00Z',
  revokedAt: null,
  fingerprint: 'aaaa1111'
}
const ME: P.PairedDevice = {
  ...PHONE,
  name: 'this laptop',
  role: 'admin',
  fingerprint: 'bbbb2222'
}

const AUDIT_ENTRY: P.AuditEntry = {
  number: 7,
  at: '2026-11-03T10:00:00Z',
  event: { kind: 'connected', device: { fingerprint: PHONE.fingerprint, name: 'phone', role: 'viewer' }, away: true }
}

function hostRef(id: string, name: string, connection: FakeConnection): DevicesHostRef {
  return {
    id,
    name,
    connection: () => Promise.resolve(connection.asConnection())
  }
}

/** A host that wants presence before its first admin action from this device, and not after. */
function presenceHost(): FakeConnection {
  let present = false
  const host = new FakeConnection()
  host.answer('devices:presence', () => {
    present = true
    return null
  })
  host.answer('devices:revoke', ({ fingerprint }) => {
    if (!present) throw new HostRequestError('devices:revoke', 'presenceNeeded', 'This admin action needs presence.')
    return { ...PHONE, fingerprint, revokedAt: '2026-11-03T10:00:00Z' }
  })
  host.answer('devices:role', ({ fingerprint, role }) => {
    if (!present) throw new HostRequestError('devices:role', 'presenceNeeded', 'This admin action needs presence.')
    return { ...PHONE, fingerprint, role }
  })
  host.answer('devices:audit', () => {
    if (!present) throw new HostRequestError('devices:audit', 'presenceNeeded', 'This admin action needs presence.')
    return { entries: [AUDIT_ENTRY], more: false }
  })
  host.answer('devices:approve', ({ role }) => {
    if (!present) throw new HostRequestError('devices:approve', 'presenceNeeded', 'This admin action needs presence.')
    return { ...PHONE, role }
  })
  return host
}

function devices(answer: PresenceAnswer) {
  const asked: string[] = []
  const store = createDevices({
    confirmPresence: (reason) => {
      asked.push(reason)
      return Promise.resolve(answer)
    },
    log: () => undefined
  })
  return { store, asked }
}

describe('Settings > Devices, over each host', () => {
  it('S3: lists every host in the order given, an admin host with its paired and waiting devices, and marks this device by the welcome', async () => {
    const local = new FakeConnection().answer('devices:list', () => ({
      paired: [ME, PHONE],
      waiting: [
        {
          name: 'tablet',
          kind: 'desktop',
          fingerprint: 'cccc3333',
          secondsLeft: 540
        }
      ]
    }))
    Object.assign(local.welcome, { device: ME.fingerprint, role: 'admin' })
    const remote = new FakeConnection().answer('devices:list', () => {
      throw new HostRequestError('devices:list', 'notPermitted', 'Only an admin may list devices.')
    })
    // A host that says this device is an operator there is listed, but never asked for its paired devices.
    const operated = new FakeConnection().answer('devices:list', () => ({ paired: [ME], waiting: [] }))
    Object.assign(operated.welcome, { role: 'operator' })
    const { store } = devices('confirmed')
    const listed = await store.list([
      hostRef('local', 'This PC', local),
      hostRef('o', 'lab', operated),
      hostRef('b', 'build-box', remote)
    ])
    expect(listed.map((host) => host.name)).toEqual(['This PC', 'lab', 'build-box'])
    expect(listed[1]).toMatchObject({ admin: false, paired: [], waiting: [], error: null })
    expect(operated.sent).toEqual([])
    expect(listed[0]).toMatchObject({
      admin: true,
      thisDevice: ME.fingerprint,
      paired: [ME, PHONE],
      error: null
    })
    expect(listed[0]?.waiting.map((device) => device.name)).toEqual(['tablet'])
    expect(listed[2]).toMatchObject({
      paired: [],
      waiting: [],
      error: 'Only an admin may list devices.'
    })
  })

  it('S7: approves a code with the role picked, and says the host’s refusal of a code nobody waits under', async () => {
    const host = new FakeConnection().answer('devices:approve', ({ code, role }) => {
      if (code !== 'K7Q-2MX')
        throw new HostRequestError('devices:approve', 'failed', 'No device is waiting to pair with that code.')
      return { ...PHONE, role }
    })
    const { store, asked } = devices('confirmed')
    const ref = hostRef('local', 'This PC', host)
    expect(await store.approve(ref, 'K7Q-2MX', 'operator')).toEqual({
      ok: true
    })
    expect(host.payloads('devices:approve')).toEqual([{ code: 'K7Q-2MX', role: 'operator' }])
    expect(await store.approve(ref, 'NOPE', 'operator')).toEqual({
      ok: false,
      message: 'No device is waiting to pair with that code.'
    })
    expect(asked).toEqual([])
  })

  it('S13: on presenceNeeded, confirms on this computer, tells the host and tries the action once more', async () => {
    const host = presenceHost()
    const { store, asked } = devices('confirmed')
    expect(await store.revoke(hostRef('b', 'build-box', host), PHONE)).toEqual({
      ok: true
    })
    expect(asked).toEqual(['Revoke phone on build-box'])
    expect(host.sent.map((request) => request.channel)).toEqual([
      'devices:revoke',
      'devices:presence',
      'devices:revoke'
    ])
  })

  it('S13: a cancelled check says nothing changed and asks the host nothing more', async () => {
    const host = presenceHost()
    const { store } = devices('declined')
    expect(await store.approve(hostRef('b', 'build-box', host), 'K7Q-2MX', 'operator')).toEqual({
      ok: false,
      message: PRESENCE_DECLINED
    })
    expect(PRESENCE_DECLINED).toContain('nothing changed')
    expect(host.sent.map((request) => request.channel)).toEqual(['devices:approve'])
  })

  it('S13: where no check is available, says so and names floti devices over ssh on that host', async () => {
    const host = presenceHost()
    const { store } = devices('unavailable')
    const done = await store.revoke(hostRef('b', 'build-box', host), PHONE)
    expect(done).toEqual({
      ok: false,
      message: presenceUnavailable('build-box')
    })
    expect(presenceUnavailable('build-box')).toBe(
      'Presence cannot be confirmed on this computer, so nothing changed. Run floti devices over ssh on build-box instead.'
    )
    expect(host.sent.map((request) => request.channel)).toEqual(['devices:revoke'])
  })

  it('S13: tries once more only once: a second refusal is said as it is', async () => {
    const host = new FakeConnection()
      .answer('devices:presence', () => null)
      .answer('devices:revoke', () => {
        throw new HostRequestError('devices:revoke', 'presenceNeeded', 'Still needs presence.')
      })
    const { store, asked } = devices('confirmed')
    expect(await store.revoke(hostRef('b', 'build-box', host), PHONE)).toEqual({
      ok: false,
      message: 'Still needs presence.'
    })
    expect(asked).toHaveLength(1)
  })

  it('S15: changes a device’s role on the host and answers the device as the host now holds it', async () => {
    const host = new FakeConnection().answer('devices:role', ({ fingerprint, role }) => ({ ...PHONE, fingerprint, role }))
    const { store, asked } = devices('confirmed')
    expect(await store.changeRole(hostRef('local', 'This PC', host), PHONE, 'operator')).toEqual({
      ok: true,
      device: { ...PHONE, role: 'operator' }
    })
    expect(host.payloads('devices:role')).toEqual([{ fingerprint: PHONE.fingerprint, role: 'operator' }])
    expect(asked).toEqual([])
  })

  it('S15: says the host’s refusal of a role change as it is', async () => {
    const refusal = 'A host keeps at least one admin, so its last admin keeps that role.'
    const host = new FakeConnection().answer('devices:role', () => {
      throw new HostRequestError('devices:role', 'failed', refusal)
    })
    const { store } = devices('confirmed')
    expect(await store.changeRole(hostRef('local', 'This PC', host), ME, 'viewer')).toEqual({ ok: false, message: refusal })
  })

  it('S15: a role change a remote host refuses for presence confirms on this computer, then asks once more', async () => {
    const host = presenceHost()
    const { store, asked } = devices('confirmed')
    const done = await store.changeRole(hostRef('b', 'build-box', host), PHONE, 'operator')
    expect(done).toEqual({ ok: true, device: { ...PHONE, role: 'operator' } })
    expect(asked).toEqual(['Change the role of phone on build-box'])
    expect(host.sent.map((request) => request.channel)).toEqual(['devices:role', 'devices:presence', 'devices:role'])
  })

  it('S14: reads a page of the audit log, asking for presence only when it may', async () => {
    const quiet = presenceHost()
    const { store, asked } = devices('confirmed')
    expect(await store.audit(hostRef('b', 'build-box', quiet), {})).toEqual({
      ok: false,
      message: 'This admin action needs presence.'
    })
    expect(asked).toEqual([])

    const host = presenceHost()
    expect(await store.audit(hostRef('b', 'build-box', host), { before: 9 }, { ask: true })).toEqual({
      ok: true,
      page: { entries: [AUDIT_ENTRY], more: false }
    })
    expect(asked).toEqual(['Read the audit log of build-box'])
    expect(host.sent.map((request) => request.channel)).toEqual(['devices:audit', 'devices:presence', 'devices:audit'])
    expect(host.payloads('devices:audit')).toEqual([{ before: 9 }, { before: 9 }])
  })

  it('S3: watches who is attached: the whole list first and after every change, until stopped', async () => {
    const host = new FakeConnection()
    const { store } = devices('confirmed')
    const heard: unknown[] = []
    const stop = store.watchAttached(hostRef('local', 'This PC', host), (update) => heard.push(update))
    await Promise.resolve()
    const phone: P.AttachedDevice = {
      fingerprint: PHONE.fingerprint,
      name: 'phone',
      role: 'viewer',
      away: true,
      since: '2026-11-03T10:00:00Z',
      connections: 1
    }
    host.snapshot('devices:attached', { devices: [phone] })
    host.push('devices:attached', { devices: [phone, { ...phone, fingerprint: 'cccc3333', name: 'tablet' }] })
    expect(heard).toEqual([
      { ok: true, devices: [phone] },
      { ok: true, devices: [phone, { ...phone, fingerprint: 'cccc3333', name: 'tablet' }] }
    ])
    stop()
    expect(host.subscriptions.has('devices:attached')).toBe(false)
  })

  it('S3: says why who is attached cannot be watched when the host cannot be reached', async () => {
    const { store } = devices('confirmed')
    const heard = await new Promise((resolve) =>
      store.watchAttached(
        { id: 'b', name: 'build-box', connection: () => Promise.reject(new Error('build-box cannot be reached.')) },
        resolve
      )
    )
    expect(heard).toEqual({ ok: false, message: 'build-box cannot be reached.' })
  })
})
