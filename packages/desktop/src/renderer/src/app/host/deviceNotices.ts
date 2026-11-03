import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type { DeviceAttachedNotice } from '../../../../shared/ipc'

/**
 * Tells the user when another device attaches to a host the window is
 * connected to: each host says so on `devices:connected`, over the window's
 * own connection to it, and main shows one OS notification for it
 * (`notification:deviceAttached`).
 *
 * - The window's own device attaching (another of its pages, a session's
 *   screen) is never said: the host does not send it, and a notice naming
 *   this device is dropped here too.
 * - A device from another computer attaching to the host on this computer is
 *   shown once, by that host's own notification, so the window says nothing
 *   of it.
 * - A host is followed while the window is connected to it: `follow` is told
 *   the whole set each time it changes. One whose connection ended is let go
 *   of, and followed again the next time `follow` names it.
 */

/** A host whose new connections are told. */
export interface NoticeHost {
  id: string
  name: string
  /** Whether the host runs on this computer. */
  onThisComputer: boolean
  /** The window's own connection to it. */
  connection: () => Promise<HostConnection>
}

export interface DeviceNoticesDeps {
  /** Asks main to show the OS notification. */
  notify: (notice: DeviceAttachedNotice) => void
  log: (line: string) => void
}

export interface DeviceNotices {
  /** Follows exactly `hosts` from now on: new ones are subscribed, ones no longer named let go of. */
  follow(hosts: readonly NoticeHost[]): void
}

interface Followed {
  host: NoticeHost
  subscription: HostSubscription | null
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The notice for `event` on `host`, or null when the window does not say it. */
export function noticeFor(
  host: Pick<NoticeHost, 'id' | 'name' | 'onThisComputer'>,
  thisDevice: string | null,
  event: P.DeviceConnected
): DeviceAttachedNotice | null {
  if (event.fingerprint === thisDevice) return null
  // The host on this computer shows its own notification for these.
  if (host.onThisComputer && event.away) return null
  return {
    host: host.id,
    hostName: host.name,
    hostOnThisComputer: host.onThisComputer,
    device: event.name,
    role: event.role,
    away: event.away
  }
}

export function createDeviceNotices(deps: DeviceNoticesDeps): DeviceNotices {
  const followed = new Map<string, Followed>()

  const letGo = (id: string, entry: Followed): void => {
    if (followed.get(id) !== entry) return
    followed.delete(id)
    entry.subscription?.unsubscribe()
  }

  const begin = (host: NoticeHost): void => {
    const entry: Followed = { host, subscription: null }
    followed.set(host.id, entry)
    host.connection().then(
      (connection) => {
        if (followed.get(host.id) !== entry) return
        const thisDevice = connection.welcome.device ?? null
        entry.subscription = connection.subscribe('devices:connected', {
          event: (event) => {
            if (followed.get(host.id) !== entry) return
            const notice = noticeFor(entry.host, thisDevice, event)
            if (notice !== null) deps.notify(notice)
          },
          error: (error) => {
            deps.log(`devices: hearing new connections to a host ended (${error.message})`)
            letGo(host.id, entry)
          }
        })
        void connection.ended.then(() => letGo(host.id, entry))
      },
      (error: unknown) => {
        deps.log(`devices: connecting to a host to hear new connections failed (${messageOf(error)})`)
        letGo(host.id, entry)
      }
    )
  }

  return {
    follow(hosts) {
      const wanted = new Map(hosts.map((host) => [host.id, host]))
      for (const [id, entry] of followed) if (!wanted.has(id)) letGo(id, entry)
      for (const host of hosts) {
        const entry = followed.get(host.id)
        // A host renamed keeps its subscription and is named as it is now.
        if (entry !== undefined) entry.host = host
        else begin(host)
      }
    }
  }
}
