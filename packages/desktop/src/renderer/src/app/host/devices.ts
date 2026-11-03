import type { HostConnection } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'

/**
 * Settings > Devices: who is attached to each host the window is connected
 * to, and Disconnect, over the window's own connection to each host.
 *
 * - Who is attached comes from a `devices:attached` subscription, which the
 *   host sends whole first and again on every change: a device attaches with
 *   its first welcomed connection and leaves with its last, so one with
 *   several connections is one entry.
 * - Each host's welcome names the device this connection proved
 *   (`welcome.device`), so the row that is this device is marked.
 * - Disconnect (`devices:disconnect`) closes every connection of a device to
 *   that host at once. Its sessions keep running there.
 *
 * Every device that reaches a host through the user's own login is served in
 * full: the login is the access.
 */

/** A host whose attached devices Settings > Devices lists. */
export interface DevicesHostRef {
  id: string
  name: string
  /** The window's own connection to it. */
  connection: () => Promise<HostConnection>
}

/** Who is attached to a host now, with this device's fingerprint there, or why that cannot be watched. */
export type AttachedUpdate =
  | {
      ok: true
      devices: readonly P.AttachedDevice[]
      thisDevice: string | null
    }
  | { ok: false; message: string }

/** What a Disconnect came to: done, or the sentence that says why not. */
export type DeviceActionResult = { ok: true } | { ok: false; message: string }

export interface DevicesDeps {
  log: (line: string) => void
}

export interface Devices {
  /**
   * Watches who is attached to the host (`devices:attached`): `listener`
   * hears the whole list first and after every change, or why it cannot be
   * watched, after which it hears nothing more. Returns the stop.
   */
  watchAttached(host: DevicesHostRef, listener: (update: AttachedUpdate) => void): () => void
  /** Closes every connection of the device with `fingerprint` to the host (`devices:disconnect`). */
  disconnect(host: DevicesHostRef, fingerprint: string): Promise<DeviceActionResult>
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createDevices(deps: DevicesDeps): Devices {
  return {
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
          const thisDevice = connection.welcome.device ?? null
          const hear = (state: P.AttachedDevices): void => tell({ ok: true, devices: state.devices, thisDevice })
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
    },

    async disconnect(host, fingerprint) {
      try {
        const connection = await host.connection()
        await connection.request('devices:disconnect', { fingerprint })
        return { ok: true }
      } catch (error) {
        deps.log(`devices: disconnecting a device from a host failed (${messageOf(error)})`)
        return { ok: false, message: messageOf(error) }
      }
    }
  }
}
