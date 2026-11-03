import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCAL_HOST_KEY, LOCAL_HOST_LABEL, type RemoteHost } from '@helm/core/types'
import type { DevicesSettingsProps, SettingsDevicesHost } from '@helm/ui'
import type { HostConnection } from '../../../shared/host/client'
import type { AttachedUpdate, Devices, DevicesHostRef } from './host/devices'
import type { RemoteHostView } from './host/remoteHosts'

/**
 * Settings > Devices, wired: This PC's host first, then each host on another
 * computer that is connected now, in the order they were added; a host that
 * is not connected now is not listed. Who is attached to each comes from its
 * `devices:attached` subscription, held while the section is on screen, so a
 * device that attaches or leaves shows up or goes without a click.
 */

export interface DevicesSettingsDeps {
  devices: Devices
  /** The window's own connection to this PC's host. */
  localConnection: () => Promise<HostConnection>
  /** The window's own connection to a host on another computer. */
  remoteConnection: (id: string) => Promise<HostConnection>
}

/** The hosts Settings > Devices lists: This PC, then each connected host on another computer, in the order added. */
export function devicesHosts(
  deps: Pick<DevicesSettingsDeps, 'localConnection' | 'remoteConnection'>,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): DevicesHostRef[] {
  const connected = hosts.filter((host) => view[host.id]?.connection?.state === 'connected')
  return [
    {
      id: LOCAL_HOST_KEY,
      name: LOCAL_HOST_LABEL,
      connection: deps.localConnection
    },
    ...connected.map((host) => ({
      id: host.id,
      name: host.name,
      connection: () => deps.remoteConnection(host.id)
    }))
  ]
}

/** One host as the section draws it, from what its watch last heard. */
export function hostView(
  ref: Pick<DevicesHostRef, 'id' | 'name'>,
  update: AttachedUpdate | undefined
): SettingsDevicesHost {
  return {
    id: ref.id,
    name: ref.name,
    thisComputer: ref.id === LOCAL_HOST_KEY,
    thisDevice: update?.ok === true ? update.thisDevice : null,
    attached:
      update?.ok === true
        ? update.devices.map(({ fingerprint, name, away, since }) => ({
            fingerprint,
            name,
            away,
            since
          }))
        : null,
    error: update?.ok === false ? update.message : null
  }
}

export function useDevicesSettings(
  deps: DevicesSettingsDeps,
  shown: boolean,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): DevicesSettingsProps {
  const [attached, setAttached] = useState<Readonly<Record<string, AttachedUpdate>>>({})
  const refs = devicesHosts(deps, hosts, view)
  // Watched again only when the set of hosts changes, not on every render.
  const key = refs.map((ref) => `${ref.id}\u0000${ref.name}`).join('\u0001')
  const current = useRef(refs)
  // Kept current after each render, before the watches below read it.
  useEffect(() => {
    current.current = refs
  })
  const { devices } = deps

  useEffect(() => {
    if (!shown) return
    const stops = current.current.map((ref) =>
      devices.watchAttached(ref, (update) => setAttached((before) => ({ ...before, [ref.id]: update })))
    )
    return () => {
      for (const stop of stops) stop()
      setAttached({})
    }
  }, [shown, key, devices])

  const onDisconnect = useCallback<DevicesSettingsProps['onDisconnect']>(
    async (id, device) => {
      const ref = current.current.find((entry) => entry.id === id)
      if (ref === undefined) return 'That host is no longer connected.'
      const done = await devices.disconnect(ref, device.fingerprint)
      return done.ok ? null : done.message
    },
    [devices]
  )

  return {
    hosts: refs.map((ref) => hostView(ref, attached[ref.id])),
    onDisconnect
  }
}
