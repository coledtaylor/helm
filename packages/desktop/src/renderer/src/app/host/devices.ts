import { HostRequestError, type HostConnection } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type { PresenceAnswer } from '../../../../shared/ipc'

/**
 * Settings > Devices: each host the window is connected to, the devices
 * attached to it now, and, where this device is its admin, the devices
 * paired with it, the ones waiting to pair, approving, revoking and changing
 * their roles, and its audit log, over the window's own connection to each
 * host.
 *
 * - This PC's host is listed first, then each host on another computer, in
 *   the order they were added, whatever role this device has there. Only a
 *   host whose welcome says this device is its admin (`welcome.role`) is
 *   asked for its paired devices and its audit log.
 * - Who is attached comes from a `devices:attached` subscription, which the
 *   host sends again whole on every change.
 * - Each host's welcome names the device this connection proved
 *   (`welcome.device`), so the row that is this device is marked and offers
 *   no Revoke.
 * - A host on another computer refuses an admin action until this computer
 *   confirmed its user within the last five minutes (`presenceNeeded`). Then
 *   this computer is asked (`presence:confirm`), the host is told
 *   (`devices:presence`) and the action is tried once more. Nothing is tried
 *   again after that. A quiet read (the listing read again while the section
 *   is on screen) never asks: it says the host's refusal instead.
 */

/** A host whose devices Settings > Devices lists. */
export interface DevicesHostRef {
  id: string
  name: string
  /** The window's own connection to it. */
  connection: () => Promise<HostConnection>
}

/** One host's devices, as Settings > Devices draws them. */
export interface HostDevices {
  id: string
  name: string
  /** This device's fingerprint there, from the host's welcome; null when it did not say. */
  thisDevice: string | null
  /** Whether this device is the host's admin: only then are its paired devices and audit log read. */
  admin: boolean
  paired: readonly P.PairedDevice[]
  waiting: readonly P.WaitingDevice[]
  /** Why the listing could not be read; the lists are empty then. */
  error: string | null
}

/** What an approve or revoke came to: done, or the sentence that says why not. */
export type DeviceActionResult = { ok: true } | { ok: false; message: string }

/** What a role change came to: the device as the host now holds it, or the sentence that says why not. */
export type RoleChangeResult = { ok: true; device: P.PairedDevice } | { ok: false; message: string }

/** A page of a host's audit log, or the sentence that says why it could not be read. */
export type AuditReadResult = { ok: true; page: P.AuditPage } | { ok: false; message: string }

/** Who is attached to a host now, or why that cannot be watched. */
export type AttachedUpdate = { ok: true; devices: readonly P.AttachedDevice[] } | { ok: false; message: string }

/** Whether a read may ask this computer for presence when the host wants it. */
export interface ReadOptions {
  ask?: boolean
}

export interface DevicesDeps {
  /** Asks this computer to confirm its user is present (`presence:confirm`). */
  confirmPresence: (reason: string) => Promise<PresenceAnswer>
  log: (line: string) => void
}

export interface Devices {
  /**
   * Each host's devices, in the order given. A host whose welcome says this
   * device is not its admin is listed with no paired or waiting devices; one
   * that cannot be read says why in its entry.
   */
  list(hosts: readonly DevicesHostRef[], options?: ReadOptions): Promise<HostDevices[]>
  approve(host: DevicesHostRef, code: string, role: P.DeviceRole): Promise<DeviceActionResult>
  revoke(host: DevicesHostRef, device: Pick<P.PairedDevice, 'name' | 'fingerprint'>): Promise<DeviceActionResult>
  /** Gives a paired device another role (`devices:role`). */
  changeRole(
    host: DevicesHostRef,
    device: Pick<P.PairedDevice, 'name' | 'fingerprint'>,
    role: P.DeviceRole
  ): Promise<RoleChangeResult>
  /** A page of the host's audit log, newest first (`devices:audit`). */
  audit(host: DevicesHostRef, query: P.AuditQuery, options?: ReadOptions): Promise<AuditReadResult>
  /**
   * Watches who is attached to the host (`devices:attached`): `listener`
   * hears the whole list first and after every change, or why it cannot be
   * watched, after which it hears nothing more. Returns the stop.
   */
  watchAttached(host: DevicesHostRef, listener: (update: AttachedUpdate) => void): () => void
}

/** Said when this computer's user cancelled the check. */
export const PRESENCE_DECLINED = 'You did not confirm it was you on this computer, so nothing changed.'

/** Said where this computer has no check, naming the way that needs none. */
export function presenceUnavailable(hostName: string): string {
  return `Presence cannot be confirmed on this computer, so nothing changed. Run floti devices over ssh on ${hostName} instead.`
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

export function createDevices(deps: DevicesDeps): Devices {
  /**
   * Runs `action` on `host`; when the host wants presence first and `ask`
   * allows it, asks this computer, tells the host, and runs it once more.
   */
  const withPresence = async <T>(
    host: DevicesHostRef,
    reason: string,
    action: (connection: HostConnection) => Promise<T>,
    ask = true
  ): Promise<Outcome<T>> => {
    let connection: HostConnection
    try {
      connection = await host.connection()
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
    try {
      return { ok: true, value: await action(connection) }
    } catch (error) {
      if (!ask || !(error instanceof HostRequestError) || error.code !== 'presenceNeeded') {
        return { ok: false, message: messageOf(error) }
      }
    }
    const answer = await deps.confirmPresence(reason).catch((error: unknown) => {
      deps.log(`devices: the presence check failed (${messageOf(error)})`)
      return 'unavailable' as const
    })
    if (answer === 'declined') return { ok: false, message: PRESENCE_DECLINED }
    if (answer === 'unavailable') return { ok: false, message: presenceUnavailable(host.name) }
    try {
      await connection.request('devices:presence', null)
      return { ok: true, value: await action(connection) }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  const listOne = async (host: DevicesHostRef, ask: boolean): Promise<HostDevices> => {
    const empty = { id: host.id, name: host.name, paired: [], waiting: [] }
    let connection: HostConnection
    try {
      connection = await host.connection()
    } catch (error) {
      deps.log(`devices: connecting to a host for its devices failed (${messageOf(error)})`)
      return { ...empty, thisDevice: null, admin: false, error: messageOf(error) }
    }
    const thisDevice = connection.welcome.device ?? null
    const role = connection.welcome.role
    // A host that names no role predates roles: every device there is its admin.
    if (role !== undefined && role !== 'admin') return { ...empty, thisDevice, admin: false, error: null }
    const listing = await withPresence(
      host,
      `See the devices paired with ${host.name}`,
      (link) => link.request('devices:list', null),
      ask
    )
    if (!listing.ok) {
      deps.log(`devices: listing a host's devices failed (${listing.message})`)
      return { ...empty, thisDevice, admin: true, error: listing.message }
    }
    return {
      ...empty,
      thisDevice,
      admin: true,
      paired: listing.value.paired,
      waiting: listing.value.waiting,
      error: null
    }
  }

  return {
    async list(hosts, options) {
      if (options?.ask !== true) return Promise.all(hosts.map((host) => listOne(host, false)))
      // One at a time when this computer may be asked, so two hosts never ask at once.
      const listed: HostDevices[] = []
      for (const host of hosts) listed.push(await listOne(host, true))
      return listed
    },
    async approve(host, code, role) {
      const done = await withPresence(host, `Approve a device on ${host.name}`, (connection) =>
        connection.request('devices:approve', { code, role })
      )
      return done.ok ? { ok: true } : done
    },
    async revoke(host, device) {
      const done = await withPresence(host, `Revoke ${device.name} on ${host.name}`, (connection) =>
        connection.request('devices:revoke', {
          fingerprint: device.fingerprint
        })
      )
      return done.ok ? { ok: true } : done
    },
    async changeRole(host, device, role) {
      const done = await withPresence(host, `Change the role of ${device.name} on ${host.name}`, (connection) =>
        connection.request('devices:role', { fingerprint: device.fingerprint, role })
      )
      return done.ok ? { ok: true, device: done.value } : done
    },
    async audit(host, query, options) {
      const done = await withPresence(
        host,
        `Read the audit log of ${host.name}`,
        (connection) => connection.request('devices:audit', query),
        options?.ask === true
      )
      return done.ok ? { ok: true, page: done.value } : done
    },
    watchAttached(host, listener) {
      let stopped = false
      let stop = (): void => {
        stopped = true
      }
      const tell = (update: AttachedUpdate): void => {
        if (!stopped) listener(update)
      }
      host.connection().then(
        (connection) => {
          if (stopped) return
          const hear = (state: P.AttachedDevices): void => tell({ ok: true, devices: state.devices })
          const subscription = connection.subscribe('devices:attached', {
            snapshot: hear,
            event: hear,
            error: (error) => {
              deps.log(`devices: watching who is attached to a host ended (${error.message})`)
              tell({ ok: false, message: error.message })
            }
          })
          stop = () => {
            stopped = true
            subscription.unsubscribe()
          }
        },
        (error: unknown) => tell({ ok: false, message: messageOf(error) })
      )
      return () => stop()
    }
  }
}
