import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_HOST_KEY, LOCAL_HOST_LABEL, type RemoteHost } from '@helm/core/types'
import type { DevicesSettingsProps, SettingsDevicesHost } from '@helm/ui'
import type { HostConnection } from '../../../shared/host/client'
import type { Devices, DevicesHostRef } from './host/devices'
import type { RemoteHostView } from './host/remoteHosts'

/**
 * Settings > Devices, wired: This PC's host first, then each host on another
 * computer that says this device is its admin, listed while the section is on
 * screen and again after each approve or revoke. Listed again every few
 * seconds while on screen, so a device that asks to pair shows up without a
 * click.
 */

/** How often the listing is read again while Settings > Devices is on screen. */
export const DEVICES_RELIST_MS = 5000

export interface DevicesSettingsDeps {
  devices: Devices
  /** The window's own connection to this PC's host. */
  localConnection: () => Promise<HostConnection>
  /** The window's own connection to a host on another computer. */
  remoteConnection: (id: string) => Promise<HostConnection>
}

/** The hosts Settings > Devices lists: This PC, then each connected remote host this device is an admin of. */
export function devicesHosts(
  deps: Pick<DevicesSettingsDeps, 'localConnection' | 'remoteConnection'>,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): DevicesHostRef[] {
  const admin = hosts.filter((host) => {
    const connection = view[host.id]?.connection
    return connection?.state === 'connected' && connection.role === 'admin'
  })
  return [
    {
      id: LOCAL_HOST_KEY,
      name: LOCAL_HOST_LABEL,
      connection: deps.localConnection
    },
    ...admin.map((host) => ({
      id: host.id,
      name: host.name,
      connection: () => deps.remoteConnection(host.id)
    }))
  ]
}

export function useDevicesSettings(
  deps: DevicesSettingsDeps,
  shown: boolean,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): DevicesSettingsProps {
  const [listed, setListed] = useState<readonly SettingsDevicesHost[] | null>(null)
  const refs = devicesHosts(deps, hosts, view)
  // Listed again only when the set of hosts changes, not on every render.
  const key = refs.map((ref) => `${ref.id}\u0000${ref.name}`).join('\u0001')
  const current = useRef(refs)
  // Kept current after each render, before the listing below reads it.
  useEffect(() => {
    current.current = refs
  })
  const generation = useRef(0)

  const relist = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    const next = await deps.devices.list(current.current)
    if (mine === generation.current) setListed(next)
  }, [deps.devices])

  useEffect(() => {
    if (!shown) return
    void relist()
    const timer = setInterval(() => void relist(), DEVICES_RELIST_MS)
    return () => clearInterval(timer)
  }, [shown, key, relist])

  return useMemo(() => {
    const refOf = (id: string): DevicesHostRef | undefined => current.current.find((ref) => ref.id === id)
    return {
      hosts: listed,
      onApprove: async (id, code, role) => {
        const ref = refOf(id)
        if (ref === undefined) return 'That host is no longer listed.'
        const done = await deps.devices.approve(ref, code, role)
        void relist()
        return done.ok ? null : done.message
      },
      onRevoke: async (id, device) => {
        const ref = refOf(id)
        if (ref === undefined) return 'That host is no longer listed.'
        const done = await deps.devices.revoke(ref, device)
        void relist()
        return done.ok ? null : done.message
      }
    }
  }, [listed, deps.devices, relist])
}
