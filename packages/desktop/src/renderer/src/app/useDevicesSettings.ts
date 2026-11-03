import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_HOST_KEY, LOCAL_HOST_LABEL, type RemoteHost } from '@helm/core/types'
import type { DevicesSettingsProps, SettingsAuditLog, SettingsDevicesHost } from '@helm/ui'
import type { HostConnection } from '../../../shared/host/client'
import type * as P from '../../../shared/host/protocol'
import { auditLine } from './host/auditLines'
import type { AttachedUpdate, Devices, DevicesHostRef, HostDevices } from './host/devices'
import type { RemoteHostView } from './host/remoteHosts'

/**
 * Settings > Devices, wired: This PC's host first, then each connected host
 * on another computer, whatever this device's role there.
 *
 * - Who is attached to each comes from its `devices:attached` subscription,
 *   held while the section is on screen and live without asking again.
 * - Where this device is an admin, the paired devices and waiting requests
 *   are listed when the section opens, after each approve, revoke or role
 *   change, and every few seconds while it is on screen, so a device that
 *   asks to pair shows up without a click. Its audit log's newest page is
 *   read with them; "Show more" reads the page before the oldest shown.
 * - Opening the section, an action and "Show more" may ask this computer for
 *   presence when a host on another computer wants it; the reads every few
 *   seconds never do.
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

/** A host's audit log as read so far, newest first. */
interface AuditState {
  entries: readonly P.AuditEntry[]
  more: boolean
  loading: boolean
  error: string | null
}

const UNREAD: AuditState = { entries: [], more: false, loading: true, error: null }

/** `page`, the newest, laid over what was read before: new entries go on top, older pages read stay. */
export function mergeAuditHead(before: AuditState | undefined, page: P.AuditPage): AuditState {
  const newest = before?.entries[0]?.number
  if (before === undefined || newest === undefined) {
    return { entries: page.entries, more: page.more, loading: false, error: null }
  }
  const added = page.entries.filter((entry) => entry.number > newest)
  // More arrived than one page holds: what was read no longer joins it.
  if (added.length === page.entries.length && page.more) {
    return { entries: page.entries, more: page.more, loading: false, error: null }
  }
  return { ...before, entries: [...added, ...before.entries], loading: false, error: null }
}

const auditView = (state: AuditState | undefined): SettingsAuditLog => {
  const shown = state ?? UNREAD
  return { entries: shown.entries.map(auditLine), more: shown.more, loading: shown.loading, error: shown.error }
}

function hostView(
  host: HostDevices,
  attached: AttachedUpdate | undefined,
  audit: AuditState | undefined
): SettingsDevicesHost {
  return {
    id: host.id,
    name: host.name,
    thisComputer: host.id === LOCAL_HOST_KEY,
    thisDevice: host.thisDevice,
    admin: host.admin,
    attached:
      attached?.ok === true
        ? attached.devices.map(({ fingerprint, name, role, away, since }) => ({ fingerprint, name, role, away, since }))
        : null,
    attachedError: attached?.ok === false ? attached.message : null,
    paired: host.paired,
    waiting: host.waiting,
    error: host.error,
    audit: host.admin ? auditView(audit) : null
  }
}

export function useDevicesSettings(
  deps: DevicesSettingsDeps,
  shown: boolean,
  hosts: readonly RemoteHost[],
  view: Readonly<Record<string, RemoteHostView>>
): DevicesSettingsProps {
  const [listed, setListed] = useState<readonly HostDevices[] | null>(null)
  const [attached, setAttached] = useState<Readonly<Record<string, AttachedUpdate>>>({})
  const [audits, setAudits] = useState<Readonly<Record<string, AuditState>>>({})
  const refs = devicesHosts(deps, hosts, view)
  // Listed again only when the set of hosts changes, not on every render.
  const key = refs.map((ref) => `${ref.id}\u0000${ref.name}`).join('\u0001')
  const current = useRef(refs)
  // Kept current after each render, before the listing below reads it.
  useEffect(() => {
    current.current = refs
  })
  const auditsNow = useRef(audits)
  useEffect(() => {
    auditsNow.current = audits
  })
  const generation = useRef(0)
  const { devices } = deps

  const refOf = useCallback(
    (id: string): DevicesHostRef | undefined => current.current.find((ref) => ref.id === id),
    []
  )

  /** Reads a host's newest audit page and lays it over what is shown. */
  const readAuditHead = useCallback(
    async (ref: DevicesHostRef, ask: boolean): Promise<void> => {
      const read = await devices.audit(ref, {}, { ask })
      setAudits((before) => {
        const known = before[ref.id]
        if (read.ok) return { ...before, [ref.id]: mergeAuditHead(known, read.page) }
        // A quiet read that failed leaves what is shown; a first read says why.
        if (known !== undefined && known.entries.length > 0 && !ask) return before
        return { ...before, [ref.id]: { ...(known ?? UNREAD), loading: false, error: read.message } }
      })
    },
    [devices]
  )

  const relist = useCallback(
    async (ask = false): Promise<void> => {
      const mine = ++generation.current
      const next = await devices.list(current.current, { ask })
      if (mine !== generation.current) return
      setListed(next)
      await Promise.all(
        next
          .filter((host) => host.admin && host.error === null)
          .map((host) => {
            const ref = refOf(host.id)
            return ref === undefined ? undefined : readAuditHead(ref, ask)
          })
      )
    },
    [devices, readAuditHead, refOf]
  )

  // Who is attached to each host, while on screen; a watch that ended is begun again at the next relist.
  const watches = useRef(new Map<string, () => void>())
  const watch = useCallback(
    (ref: DevicesHostRef): void => {
      watches.current.get(ref.id)?.()
      const stop = devices.watchAttached(ref, (update) => {
        setAttached((before) => ({ ...before, [ref.id]: update }))
        if (!update.ok) watches.current.delete(ref.id)
      })
      watches.current.set(ref.id, stop)
    },
    [devices]
  )

  useEffect(() => {
    if (!shown) return
    const running = watches.current
    for (const ref of current.current) watch(ref)
    void relist(true)
    const timer = setInterval(() => {
      for (const ref of current.current) if (!running.has(ref.id)) watch(ref)
      void relist()
    }, DEVICES_RELIST_MS)
    return () => {
      clearInterval(timer)
      for (const stop of running.values()) stop()
      running.clear()
      setAttached({})
    }
  }, [shown, key, relist, watch])

  return useMemo(() => {
    const after = (id: string): void => {
      void relist()
      const ref = refOf(id)
      if (ref !== undefined) void readAuditHead(ref, false)
    }
    return {
      hosts: listed?.map((host) => hostView(host, attached[host.id], audits[host.id])) ?? null,
      onApprove: async (id, code, role) => {
        const ref = refOf(id)
        if (ref === undefined) return 'That host is no longer listed.'
        const done = await devices.approve(ref, code, role)
        after(id)
        return done.ok ? null : done.message
      },
      onRevoke: async (id, device) => {
        const ref = refOf(id)
        if (ref === undefined) return 'That host is no longer listed.'
        const done = await devices.revoke(ref, device)
        after(id)
        return done.ok ? null : done.message
      },
      onRole: async (id, device, role) => {
        const ref = refOf(id)
        if (ref === undefined) return 'That host is no longer listed.'
        const done = await devices.changeRole(ref, device, role)
        if (!done.ok) return done.message
        // The row shows the role the host answered with, before the listing is read again.
        setListed((before) =>
          before?.map((host) =>
            host.id !== id
              ? host
              : {
                  ...host,
                  paired: host.paired.map((paired) =>
                    paired.fingerprint === done.device.fingerprint ? done.device : paired
                  )
                }
          ) ?? null
        )
        after(id)
        return null
      },
      onMoreAudit: (id) => {
        const ref = refOf(id)
        const known = auditsNow.current[id]
        const oldest = known?.entries.at(-1)?.number
        if (ref === undefined || known === undefined || oldest === undefined || known.loading) return
        setAudits((before) => ({ ...before, [id]: { ...known, loading: true, error: null } }))
        void devices.audit(ref, { before: oldest }, { ask: true }).then((read) =>
          setAudits((before) => {
            const now = before[id] ?? known
            return {
              ...before,
              [id]: read.ok
                ? {
                    ...now,
                    entries: [...now.entries, ...read.page.entries.filter((entry) => entry.number < oldest)],
                    more: read.page.more,
                    loading: false,
                    error: null
                  }
                : { ...now, loading: false, error: read.message }
            }
          })
        )
      }
    }
  }, [listed, attached, audits, devices, relist, readAuditHead, refOf])
}
