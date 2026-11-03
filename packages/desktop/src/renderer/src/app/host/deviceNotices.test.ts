import { describe, expect, it, vi } from 'vitest'
import { PATIENCE } from '../../../../../../../test/patience'
import { FakeConnection } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import type { DeviceAttachedNotice } from '../../../../shared/ipc'
import { createDeviceNotices, type NoticeHost } from './deviceNotices'

const connected = (over: Partial<P.DeviceConnected> = {}): P.DeviceConnected => ({
  fingerprint: 'aaaa1111',
  name: 'phone',
  role: 'operator',
  away: false,
  at: '2026-11-03T10:00:00Z',
  ...over
})

function hostOf(id: string, name: string, connection: FakeConnection, onThisComputer: boolean): NoticeHost {
  return { id, name, onThisComputer, connection: () => Promise.resolve(connection.asConnection()) }
}

/** A connection whose welcome names this device, and the notices told. */
function world() {
  const told: DeviceAttachedNotice[] = []
  const notices = createDeviceNotices({ notify: (notice) => told.push(notice), log: () => undefined })
  const connection = (): FakeConnection => {
    const made = new FakeConnection()
    Object.assign(made.welcome, { device: 'bbbb2222', role: 'admin' })
    return made
  }
  return { told, notices, connection }
}

/** Until `connection` has subscribed to new connections. */
async function subscribed(connection: FakeConnection): Promise<void> {
  await vi.waitFor(() => expect(connection.subscriptions.has('devices:connected')).toBe(true), { timeout: PATIENCE })
}

describe('connection notices', () => {
  it('S5: another device attaching to a remote host is told once, naming the device, its role, the host and where it came from', async () => {
    const { told, notices, connection } = world()
    const build = connection()
    notices.follow([hostOf('h-build', 'build-box', build, false)])
    await subscribed(build)
    build.push('devices:connected', connected({ away: true }))
    expect(told).toEqual([
      {
        host: 'h-build',
        hostName: 'build-box',
        hostOnThisComputer: false,
        device: 'phone',
        role: 'operator',
        away: true
      }
    ])
    build.push('devices:connected', connected({ name: 'build console', fingerprint: 'cccc3333', away: false }))
    expect(told.at(-1)).toMatchObject({ device: 'build console', away: false })
    expect(told).toHaveLength(2)
  })

  it('S5: a device from another computer attaching to this PC’s host is left to the host’s own notification', async () => {
    const { told, notices, connection } = world()
    const local = connection()
    notices.follow([hostOf('local', 'This PC', local, true)])
    await subscribed(local)
    local.push('devices:connected', connected({ away: true }))
    expect(told).toEqual([])
    // One on this computer, such as a second Helm or a shell's client, is told.
    local.push('devices:connected', connected({ away: false, name: 'second window' }))
    expect(told).toEqual([
      {
        host: 'local',
        hostName: 'This PC',
        hostOnThisComputer: true,
        device: 'second window',
        role: 'operator',
        away: false
      }
    ])
  })

  it('S5: this device attaching is never told', async () => {
    const { told, notices, connection } = world()
    const build = connection()
    notices.follow([hostOf('h-build', 'build-box', build, false)])
    await subscribed(build)
    build.push('devices:connected', connected({ fingerprint: 'bbbb2222', away: true }))
    expect(told).toEqual([])
  })

  it('S5: a host no longer followed tells nothing, and one followed again is subscribed once', async () => {
    const { told, notices, connection } = world()
    const build = connection()
    const ref = hostOf('h-build', 'build-box', build, false)
    notices.follow([ref])
    await subscribed(build)
    notices.follow([ref])
    notices.follow([])
    expect(build.subscriptions.has('devices:connected')).toBe(false)
    build.push('devices:connected', connected())
    expect(told).toEqual([])

    const again = connection()
    notices.follow([hostOf('h-build', 'build-box', again, false)])
    await subscribed(again)
    again.push('devices:connected', connected())
    expect(told).toHaveLength(1)
  })

  it('S5: a host whose connection ended is followed again the next time it is named', async () => {
    const { told, notices, connection } = world()
    const first = connection()
    let current = first
    const ref: NoticeHost = {
      id: 'local',
      name: 'This PC',
      onThisComputer: true,
      connection: () => Promise.resolve(current.asConnection())
    }
    notices.follow([ref])
    await subscribed(first)
    first.close()
    await first.ended
    await Promise.resolve()
    current = connection()
    notices.follow([ref])
    await subscribed(current)
    current.push('devices:connected', connected())
    expect(told).toHaveLength(1)
  })
})
