import { useEffect, useRef } from 'react'
import { LOCAL_HOST_KEY, type RemoteHost } from '@helm/core/types'
import type { DeviceNotices, NoticeHost } from './host/deviceNotices'
import type { RemoteHostView } from './host/remoteHosts'
import { devicesHosts, type DevicesSettingsDeps } from './useDevicesSettings'

/**
 * The window's connection notices, wired: while sessions run in the local
 * host, every host the window is connected to (This PC's, then each host on
 * another computer main says is connected) is followed for devices that
 * attach, whether or not Settings is open.
 */

/** The hosts followed: the ones Settings > Devices lists. */
export function noticeHosts(
  deps: Pick<DevicesSettingsDeps, 'localConnection' | 'remoteConnection'>,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): NoticeHost[] {
  return devicesHosts(deps, hosts, view).map((ref) => ({ ...ref, onThisComputer: ref.id === LOCAL_HOST_KEY }))
}

/**
 * Follows the hosts while `enabled`. `reconnects` counts the window's
 * reconnects to this PC's host, so a host that came back is followed again.
 */
export function useDeviceNotices(
  notices: DeviceNotices,
  deps: Pick<DevicesSettingsDeps, 'localConnection' | 'remoteConnection'>,
  enabled: boolean,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>,
  reconnects: number
): void {
  const followed = enabled ? noticeHosts(deps, hosts, view) : []
  const key = `${String(reconnects)}\u0002${followed.map((host) => `${host.id}\u0000${host.name}`).join('\u0001')}`
  const current = useRef(followed)
  useEffect(() => {
    current.current = followed
  })
  useEffect(() => {
    notices.follow(current.current)
  }, [notices, key])
  useEffect(() => () => notices.follow([]), [notices])
}
