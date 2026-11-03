import { describe, expect, it } from 'vitest'
import type { RemoteHost } from '@helm/core/types'
import type { HostConnection } from '../../../shared/host/client'
import { devicesHosts } from './useDevicesSettings'
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

describe('the hosts Settings > Devices lists', () => {
  it('S7: This PC first, then each connected host on another computer this device is an admin of, in the order added', () => {
    const refs = devicesHosts(
      { localConnection: never, remoteConnection: never },
      [host('ops'), host('build'), host('down'), host('lab')],
      {
        ops: view({ state: 'connected', role: 'operator' }),
        build: view({ state: 'connected', role: 'admin' }),
        down: view({ state: 'retrying' }),
        lab: view({ state: 'connected', role: 'admin' })
      }
    )
    expect(refs.map((ref) => ref.name)).toEqual(['This PC', 'build', 'lab'])
  })
})
