import type { RemoteHost, RemoteHostConnection } from '@helm/core/types'
import type { RemoteHostStates } from '../../shared/ipc'
import type { HostConnection, HostSubscription } from './client'
import type { LocalHost, PageBridge } from './launcher'
import { createHostLink, type HostLink } from './link'
import { createPageLinks, type PageLinks } from './page-link'
import type * as P from './protocol'
import { RemoteHostError } from './remote-launcher'

/**
 * Helm's links to the hosts on other computers this device has added (the
 * `hosts` setting), each over its own connection, beside this PC's own.
 *
 * - One link per host in main, for pairing, the quit and where it stands,
 *   and one page link per page that asks (`hostLink:open` naming the host).
 *   Each is its own `floti bridge` through the host's own transport.
 * - A link never starts a host. It connects at launch and when a host is
 *   added, and after any failure or drop tries again with the backoff this
 *   PC's link uses. A host that cannot be reached holds up no other.
 * - A link that drops (its ssh or command ended) sends nothing and ends
 *   nothing: the host keeps every session, and the window dims that host's
 *   rows until it is back.
 * - Removing a host lets go of its link and page links without a word to the
 *   host, so none of its sessions ends, then removes its client folder.
 * - A quit tells each connected host whether the sessions this device started
 *   there end, by that host's own choice (Keep them running unless set).
 * - Where each stands goes to the window on `remoteHosts:changed`; a pairing
 *   code goes there and nowhere else, never into a log.
 */

/** The running sessions this device started on one host, which a quit would end there. */
export interface HostQuitPart {
  id: string
  name: string
  sessions: readonly P.DeviceSession[]
}

export interface RemoteHostLinks {
  /** Starts a link for each host not yet linked, and lets go of each one no longer listed. */
  sync(hosts: readonly RemoteHost[]): void
  /** Where each host stands, by id; a host nothing has been heard from yet is absent. */
  states(): RemoteHostStates
  /** The page links to one host, or null for a host this device does not have. */
  pageLinks(id: string): PageLinks | null
  allPageLinks(): readonly PageLinks[]
  /** The sessions this device started on each connected host where `endsOn` says a quit ends them. */
  quitParts(endsOn: (id: string) => boolean): HostQuitPart[]
  /**
   * Helm is quitting on purpose: ends every page bridge, then tells each
   * connected host `host:quit` with `endsOn(id)` and lets go. A host not
   * connected is told nothing. Nothing links after it.
   */
  quit(endsOn: (id: string) => boolean): Promise<void>
}

export interface RemoteHostLinksDeps {
  /** Main's connection to `host`, pairing first while nothing is pinned and telling `onPairing` the code. */
  start: (host: RemoteHost, onPairing: (code: string) => void) => Promise<LocalHost>
  /** A page's own bridge to `host`, whose bytes go to `data`. */
  openBridge: (host: RemoteHost, data: (bytes: Uint8Array) => void) => PageBridge
  /** Removes a forgotten host's client folder. */
  forget: (host: RemoteHost) => Promise<void>
  /** Where every host stands, after each change. */
  changed: (states: RemoteHostStates) => void
  isHelmPage: (id: number) => boolean
  appVersion: string
  /** The one counter every host's page connections are numbered from. */
  nextConnection: () => number
  log: (line: string) => void
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

interface Entry {
  host: RemoteHost
  link: HostLink
  pages: PageLinks
  /** The running sessions this device started there, as the host last said. */
  own: readonly P.DeviceSession[]
  subscriptions: HostSubscription[]
}

/** Two transports that reach a host the same way. */
const sameTransport = (a: RemoteHost['transport'], b: RemoteHost['transport']): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

export function createRemoteHostLinks(deps: RemoteHostLinksDeps): RemoteHostLinks {
  const entries = new Map<string, Entry>()
  const states = new Map<string, RemoteHostConnection>()
  let quitting = false

  const tell = (): void => deps.changed(Object.fromEntries(states))

  const setState = (entry: Entry, state: RemoteHostConnection): void => {
    if (entries.get(entry.host.id) !== entry) return
    const last = states.get(entry.host.id)
    if (last !== undefined && JSON.stringify(last) === JSON.stringify(state)) return
    states.set(entry.host.id, state)
    tell()
  }

  /** Asks the host again which running sessions this device started there. */
  const refreshOwn = async (entry: Entry, connection: HostConnection): Promise<void> => {
    try {
      const own = await connection.request('host:deviceSessions', null)
      if (entry.link.current() === connection) entry.own = own
    } catch (error) {
      deps.log(`host: ${entry.host.name} did not say which sessions this device started (${(error as Error).message})`)
    }
  }

  const open = (host: RemoteHost): Entry => {
    // Filled in below: the link's callbacks reach the entry they belong to.
    const entry = { host, own: [], subscriptions: [] } as unknown as Entry
    entry.link = createHostLink({
      start: () => deps.start(entry.host, (code) => setState(entry, { state: 'pairing', code })),
      name: host.name,
      onAttemptFailed: (error) =>
        setState(entry, error instanceof RemoteHostError ? { state: 'failed', lastLine: error.lastLine } : { state: 'retrying' }),
      log: deps.log,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout
    })
    entry.pages = createPageLinks({
      inHost: true,
      appVersion: deps.appVersion,
      isHelmPage: deps.isHelmPage,
      // A page connects only while main is connected; it never makes main try.
      ready: () =>
        entry.link.current() !== null
          ? Promise.resolve()
          : Promise.reject(new Error(`${entry.host.name} is not connected.`)),
      howEnded: () => ({ planned: entry.link.endedOnPurpose(), restarts: false }),
      openBridge: (data) => deps.openBridge(entry.host, data),
      nextConnection: deps.nextConnection,
      log: deps.log
    })
    entry.link.onConnected(async (connection) => {
      for (const subscription of entry.subscriptions) subscription.unsubscribe()
      const refresh = (): void => void refreshOwn(entry, connection)
      const ignore = (): void => undefined
      entry.subscriptions = [
        connection.subscribe('session:activity', { snapshot: refresh, event: refresh, error: ignore }),
        connection.subscribe('session:exit', { event: refresh, error: ignore })
      ]
      await refreshOwn(entry, connection)
      void connection.ended.then(() => {
        // Dropped, not let go of: nothing there ended, and it is tried again.
        if (!entry.link.endedOnPurpose()) setState(entry, { state: 'retrying' })
      })
      setState(entry, { state: 'connected' })
    })
    entry.link.keepConnected()
    return entry
  }

  const forget = (entry: Entry, removeFolder: boolean): void => {
    entries.delete(entry.host.id)
    states.delete(entry.host.id)
    for (const subscription of entry.subscriptions) subscription.unsubscribe()
    void (async () => {
      await entry.pages.stop()
      await entry.link.release()
      if (removeFolder) await deps.forget(entry.host)
    })().catch((error: unknown) => {
      deps.log(`host: forgetting ${entry.host.name} did not finish (${(error as Error).message})`)
    })
  }

  return {
    sync(hosts) {
      if (quitting) return
      let changed = false
      const listed = new Set(hosts.map((host) => host.id))
      for (const entry of [...entries.values()]) {
        if (!listed.has(entry.host.id)) {
          forget(entry, true)
          changed = true
        }
      }
      for (const host of hosts) {
        const entry = entries.get(host.id)
        if (entry !== undefined && sameTransport(entry.host.transport, host.transport)) {
          entry.host = host
          continue
        }
        // Reached another way: the same host and its folder, a new link.
        if (entry !== undefined) {
          forget(entry, false)
          changed = true
        }
        entries.set(host.id, open(host))
      }
      if (changed) tell()
    },

    states: () => Object.fromEntries(states),

    pageLinks: (id) => entries.get(id)?.pages ?? null,

    allPageLinks: () => [...entries.values()].map((entry) => entry.pages),

    quitParts(endsOn) {
      return [...entries.values()]
        .filter((entry) => entry.link.current() !== null && endsOn(entry.host.id) && entry.own.length > 0)
        .map((entry) => ({ id: entry.host.id, name: entry.host.name, sessions: entry.own }))
    },

    async quit(endsOn) {
      quitting = true
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          for (const subscription of entry.subscriptions) subscription.unsubscribe()
          await entry.pages.stop()
          await entry.link.quit({ end: endsOn(entry.host.id) })
        })
      )
    }
  }
}
