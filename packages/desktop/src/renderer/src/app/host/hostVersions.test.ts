import { describe, expect, it } from 'vitest'
import type { HostConnection } from '../../../../shared/host/client'
import type { RefusedVersions } from '../../../../shared/ipc'
import { createSeenHostVersion } from './hostVersions'

/** A page link whose connects and refusals the test speaks into. */
function fakeLink(): {
  onConnected: (listener: (connection: HostConnection) => void) => void
  onRefused: (listener: (refused: RefusedVersions) => void) => void
  connect: (hostVersion: string) => void
  refuse: (refused: RefusedVersions) => void
} {
  const connected: Array<(connection: HostConnection) => void> = []
  const refusals: Array<(refused: RefusedVersions) => void> = []
  return {
    onConnected: (listener) => connected.push(listener),
    onRefused: (listener) => refusals.push(listener),
    connect: (hostVersion) => {
      for (const listener of connected) listener({ welcome: { hostVersion } } as unknown as HostConnection)
    },
    refuse: (refused) => {
      for (const listener of refusals) listener(refused)
    }
  }
}

describe('the version the window last heard of this PC’s host', () => {
  it('S9: keeps the floti version a welcome named, and tells its listeners only when it changes', () => {
    const link = fakeLink()
    const seen = createSeenHostVersion(link)
    let told = 0
    seen.subscribe(() => (told += 1))
    expect(seen.get()).toBeNull()
    link.connect('2.4.0')
    link.connect('2.4.0')
    expect(seen.get()).toEqual({ hostVersion: '2.4.0' })
    expect(told).toBe(1)
    link.connect('2.4.1')
    expect(seen.get()).toEqual({ hostVersion: '2.4.1' })
    expect(told).toBe(2)
  })

  it('S7 and S15: keeps the versions a refusal named, then the welcome of the host that replaced it', () => {
    const link = fakeLink()
    const seen = createSeenHostVersion(link)
    const refused: RefusedVersions = { host: { major: 1, minor: 4 }, client: { major: 2, minor: 0 }, update: 'host' }
    link.refuse(refused)
    expect(seen.get()).toEqual({ refused })
    link.connect('2.4.1')
    expect(seen.get()).toEqual({ hostVersion: '2.4.1' })
  })

  it('stops telling a listener that unsubscribed', () => {
    const link = fakeLink()
    const seen = createSeenHostVersion(link)
    let told = 0
    const unsubscribe = seen.subscribe(() => (told += 1))
    unsubscribe()
    link.connect('2.4.0')
    expect(told).toBe(0)
  })
})
