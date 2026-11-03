import { describe, expect, it } from 'vitest'
import { FakeConnection } from '../../../../../test/fake-connection'
import { HostRequestError } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import { createDevices, type AttachedUpdate, type DevicesHostRef } from './devices'

const ME: P.AttachedDevice = {
  fingerprint: 'bbbb2222',
  name: 'this laptop',
  away: false,
  since: '2026-11-03T09:00:00Z',
  connections: 2
}
const PHONE: P.AttachedDevice = {
  fingerprint: 'aaaa1111',
  name: 'phone',
  away: true,
  since: '2026-11-03T09:30:00Z',
  connections: 1
}

function hostRef(id: string, name: string, connection: FakeConnection): DevicesHostRef {
  return {
    id,
    name,
    connection: () => Promise.resolve(connection.asConnection())
  }
}

function watch(host: FakeConnection): {
  heard: AttachedUpdate[]
  stop: () => void
  subscribed: Promise<void>
} {
  const heard: AttachedUpdate[] = []
  const store = createDevices({ log: () => undefined })
  const stop = store.watchAttached(hostRef('local', 'This PC', host), (update) => heard.push(update))
  const subscribed = (async () => {
    // The connection is reached asynchronously; the subscription follows it.
    for (let turn = 0; turn < 10 && !host.subscriptions.has('devices:attached'); turn++) await Promise.resolve()
  })()
  return { heard, stop, subscribed }
}

describe('Settings > Devices, over each host', () => {
  it('S12: lists who is attached to a host, marking this device by its welcome', async () => {
    const host = new FakeConnection()
    Object.assign(host.welcome, { device: ME.fingerprint })
    const { heard, subscribed } = watch(host)
    await subscribed
    host.snapshot('devices:attached', { devices: [ME, PHONE] })
    expect(heard).toEqual([{ ok: true, devices: [ME, PHONE], thisDevice: ME.fingerprint }])
  })

  it('S13: hears each device that attaches or leaves without asking again, one entry per device', async () => {
    const host = new FakeConnection()
    const { heard, stop, subscribed } = watch(host)
    await subscribed
    host.snapshot('devices:attached', { devices: [ME] })
    host.push('devices:attached', { devices: [ME, PHONE] })
    host.push('devices:attached', { devices: [ME] })
    expect(heard.map((update) => (update.ok ? update.devices.map((device) => device.name) : update.message))).toEqual([
      ['this laptop'],
      ['this laptop', 'phone'],
      ['this laptop']
    ])
    expect(host.sent).toEqual([])
    // Stopped, it hears nothing more and lets the subscription go.
    stop()
    expect(host.subscriptions.has('devices:attached')).toBe(false)
  })

  it('S12: says why a host’s attached devices cannot be watched, and hears nothing after', async () => {
    const host = new FakeConnection()
    const { heard, subscribed } = watch(host)
    await subscribed
    host.subscriptions
      .get('devices:attached')
      ?.error?.(new HostRequestError('devices:attached', 'failed', 'The host went away.'))
    expect(heard).toEqual([{ ok: false, message: 'The host went away.' }])
  })

  it('S14: Disconnect asks the host to close every connection of that device, and says a refusal as it is', async () => {
    const host = new FakeConnection().answer('devices:disconnect', ({ fingerprint }) => {
      if (fingerprint !== PHONE.fingerprint)
        throw new HostRequestError('devices:disconnect', 'failed', 'No device with that fingerprint is attached.')
      return null
    })
    const store = createDevices({ log: () => undefined })
    const ref = hostRef('b', 'build-box', host)
    expect(await store.disconnect(ref, PHONE.fingerprint)).toEqual({
      ok: true
    })
    expect(host.payloads('devices:disconnect')).toEqual([{ fingerprint: PHONE.fingerprint }])
    expect(await store.disconnect(ref, 'nobody')).toEqual({
      ok: false,
      message: 'No device with that fingerprint is attached.'
    })
  })
})
