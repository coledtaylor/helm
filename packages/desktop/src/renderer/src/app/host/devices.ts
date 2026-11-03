import { HostRequestError, type HostConnection } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type { PresenceAnswer } from '../../../../shared/ipc'

/**
 * Settings > Devices: the devices paired with each host this device is an
 * admin of, the ones waiting to pair, and approving and revoking them, over
 * the window's own connection to each host.
 *
 * - This PC's host is listed first, then each host on another computer, in
 *   the order they were added: each only while its welcome says this device
 *   is its admin (`welcome.role`).
 * - Each host's welcome names the device this connection proved
 *   (`welcome.device`), so the row that is this device is marked and offers
 *   no Revoke.
 * - A host on another computer refuses an admin action until this computer
 *   confirmed its user within the last five minutes (`presenceNeeded`). Then
 *   this computer is asked (`presence:confirm`), the host is told
 *   (`devices:presence`) and the action is tried once more. Nothing is tried
 *   again after that.
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
  paired: readonly P.PairedDevice[]
  waiting: readonly P.WaitingDevice[]
  /** Why the listing could not be read; the lists are empty then. */
  error: string | null
}

/** What an approve or revoke came to: done, or the sentence that says why not. */
export type DeviceActionResult = { ok: true } | { ok: false; message: string }

export interface DevicesDeps {
  /** Asks this computer to confirm its user is present (`presence:confirm`). */
  confirmPresence: (reason: string) => Promise<PresenceAnswer>
  log: (line: string) => void
}

export interface Devices {
  /**
   * Each admin host's devices, in the order given; a host whose welcome says
   * this device is not its admin is left out, and one that cannot be read
   * says why in its entry.
   */
  list(hosts: readonly DevicesHostRef[]): Promise<HostDevices[]>
  approve(host: DevicesHostRef, code: string, role: P.DeviceRole): Promise<DeviceActionResult>
  revoke(host: DevicesHostRef, device: Pick<P.PairedDevice, 'name' | 'fingerprint'>): Promise<DeviceActionResult>
}

/** Said when this computer's user cancelled the check. */
export const PRESENCE_DECLINED = 'You did not confirm it was you on this computer, so nothing changed.'

/** Said where this computer has no check, naming the way that needs none. */
export function presenceUnavailable(hostName: string): string {
  return `Presence cannot be confirmed on this computer, so nothing changed. Run floti devices over ssh on ${hostName} instead.`
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createDevices(deps: DevicesDeps): Devices {
  /**
   * Runs `action` on `host`; when the host wants presence first, asks this
   * computer, tells the host, and runs it once more.
   */
  const withPresence = async <T>(
    host: DevicesHostRef,
    reason: string,
    action: (connection: HostConnection) => Promise<T>
  ): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
    let connection: HostConnection
    try {
      connection = await host.connection()
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
    try {
      return { ok: true, value: await action(connection) }
    } catch (error) {
      if (!(error instanceof HostRequestError) || error.code !== 'presenceNeeded') {
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

  const listOne = async (host: DevicesHostRef): Promise<HostDevices | null> => {
    const empty = { id: host.id, name: host.name, paired: [], waiting: [] }
    try {
      const connection = await host.connection()
      const role = connection.welcome.role
      if (role !== undefined && role !== 'admin') return null
      const listing = await connection.request('devices:list', null)
      return {
        ...empty,
        thisDevice: connection.welcome.device ?? null,
        paired: listing.paired,
        waiting: listing.waiting,
        error: null
      }
    } catch (error) {
      deps.log(`devices: listing a host's devices failed (${messageOf(error)})`)
      return { ...empty, thisDevice: null, error: messageOf(error) }
    }
  }

  return {
    list: async (hosts) =>
      (await Promise.all(hosts.map(listOne))).filter((listed): listed is HostDevices => listed !== null),
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
    }
  }
}
