import { NO_HOST_LINE, saysNotFound, type RemoteHost, type RemoteHostConnection } from '@helm/core/types'
import type { RemoteHostStates } from '../../shared/ipc'
import type { HostConnection, HostSubscription } from './client'
import type { LocalHost, PageBridge } from './launcher'
import { createHostLink, type HostLink } from './link'
import { createPageLinks, type PageLinks } from './page-link'
import type * as P from './protocol'
import { RemoteHostError } from './remote-launcher'
import type { WslKeepAwake } from './wsl-awake'

/**
 * Helm's links to the hosts on other computers this device has added (the
 * `hosts` setting), each over its own connection, beside this PC's own.
 *
 * - One link per host in main, for the quit and where it stands,
 *   and one page link per page that asks (`hostLink:open` naming the host).
 *   Each is its own `floti bridge` through the host's own transport.
 * - A link never starts a host. It connects at launch and when a host is
 *   added, and after any failure or drop tries again with the backoff this
 *   PC's link uses. A host that cannot be reached holds up no other.
 * - A link that drops (its ssh or command ended) sends nothing and ends
 *   nothing: the host keeps every session, and the window dims that host's
 *   rows until it is back.
 * - Adding a host is connecting to it: its first connection pins the key it
 *   proves, through the user's own login, and nothing is approved there. A
 *   host that later proves another key is `keyChanged` until it is removed
 *   and added again.
 * - Removing a host lets go of its link and page links without a word to the
 *   host, so none of its sessions ends, then removes its client folder, which
 *   holds the key it pinned: adding the same target again pins whatever key
 *   the host proves then.
 * - A quit tells each connected host whether the sessions this device started
 *   there end, by that host's own choice (Keep them running unless set).
 * - Where each stands goes to the window on `remoteHosts:changed`. A host
 *   whose floti refused this device's hello is too old or newer, with both versions; one
 *   whose login has no floti is missing; one Helm installed floti on while
 *   nobody was signed in there starts at the next sign-in, which is no
 *   failure.
 */

/** Where a failed attempt leaves a host: what its line says, read for what the window offers. */
export function failedState(error: Error, startsAtSignIn: boolean): RemoteHostConnection {
  if (!(error instanceof RemoteHostError)) return { state: 'retrying' }
  const { refused, lastLine, keyChanged } = error
  if (keyChanged) return { state: 'keyChanged' }
  if (refused !== null) {
    return { state: refused.update === 'host' ? 'tooOld' : 'newer', host: refused.host, client: refused.client }
  }
  if (startsAtSignIn && lastLine === NO_HOST_LINE) return { state: 'startsAtSignIn' }
  if (saysNotFound(null, lastLine)) return { state: 'missing', lastLine }
  return { state: 'failed', lastLine }
}

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
  /** Main's connection now to the host this device reaches with `ssh <target>`, or null. */
  reachedWithSsh(target: string): HostConnection | null
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
  /**
   * Helm installed or updated floti on host `id`, at `floti`: its link tries
   * again now, and with `startsAtNextSignIn` a host that is not running there
   * yet starts at the next sign-in rather than having failed.
   */
  installed(id: string, floti: string, startsAtNextSignIn: boolean): void
  /**
   * Host `host`, being added, connected on `connected`, which pinned its key:
   * its link starts on that connection rather than making another. The
   * settings write that adds the host follows at once, and its `sync` keeps
   * this link. Helm quitting, or a host already linked, closes it instead.
   */
  adopt(host: RemoteHost, connected: LocalHost): void
  /**
   * The user's Reconnect now for host `id`: its link drops the wait it is in
   * and tries at once, the next wait starting short again. Every other host
   * keeps its own wait. Nothing is asked of the host but the connection.
   */
  reconnect(id: string): void
}

export interface RemoteHostLinksDeps {
  /** Main's connection to `host`, pinning its key at the first connection. */
  start: (host: RemoteHost) => Promise<LocalHost>
  /** A page's own bridge to `host`, whose bytes go to `data`. */
  openBridge: (host: RemoteHost, data: (bytes: Uint8Array) => void) => PageBridge
  /** Removes a forgotten host's client folder. */
  forget: (host: RemoteHost) => Promise<void>
  /** Where every host stands, after each change. */
  changed: (states: RemoteHostStates) => void
  isHelmPage: (id: number) => boolean
  appVersion: string
  /** The computer's name, which each page's `hello` gives as this device's name. */
  deviceName?: string
  /** The one counter every host's page connections are numbered from. */
  nextConnection: () => number
  /**
   * What hangs on each host's main link beside the link itself (its plugins'
   * page files and tool relay, `remote-plugins.ts`), started with the link
   * and stopped when the link is let go of or Helm quits.
   */
  linked?: (host: RemoteHost, link: HostLink) => { stop(): void }
  /**
   * The hosts this device added, at the first `sync` and at each one after
   * that changes them: what `floti doctor` is told to check (`doctor-hosts.ts`).
   */
  hostsChanged?: (hosts: readonly RemoteHost[]) => void
  /**
   * Keeping WSL distros awake (`wsl-awake.ts`): told whether each host runs
   * a session, at each `session:activity`, and each time a host's link
   * connects or a host is removed.
   */
  wsl?: Pick<WslKeepAwake, 'activity' | 'connected' | 'forget'>
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
  /** What `linked` started on this link. */
  attached: { stop(): void } | null
}

/** Two hosts reached the same way: the same transport, running the same floti there. */
const reachedAlike = (a: RemoteHost, b: RemoteHost): boolean =>
  JSON.stringify(a.transport) === JSON.stringify(b.transport) && a.floti === b.floti

export function createRemoteHostLinks(deps: RemoteHostLinksDeps): RemoteHostLinks {
  const entries = new Map<string, Entry>()
  const states = new Map<string, RemoteHostConnection>()
  /** The hosts Helm installed floti on while nobody was signed in there. */
  const atSignIn = new Set<string>()
  let quitting = false
  /** The hosts as `hostsChanged` was last told them, as JSON; null before the first `sync`. */
  let recorded: string | null = null

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

  const open = (host: RemoteHost, connected: LocalHost | null = null): Entry => {
    // Filled in below: the link's callbacks reach the entry they belong to.
    const entry = { host, own: [], subscriptions: [], attached: null } as unknown as Entry
    // The connection the add already made is the link's first; every later
    // one is its own.
    let first = connected
    entry.link = createHostLink({
      start: () => {
        const adopted = first
        first = null
        return adopted !== null ? Promise.resolve(adopted) : deps.start(entry.host)
      },
      name: host.name,
      onAttemptFailed: (error) => setState(entry, failedState(error, atSignIn.has(entry.host.id))),
      log: deps.log,
      setTimeout: deps.setTimeout,
      clearTimeout: deps.clearTimeout
    })
    entry.pages = createPageLinks({
      inHost: true,
      appVersion: deps.appVersion,
      ...(deps.deviceName !== undefined ? { deviceName: deps.deviceName } : {}),
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
      const activity = (states: readonly P.SessionActivityState[]): void => {
        refresh()
        deps.wsl?.activity(entry.host, connection, states.length > 0)
      }
      entry.subscriptions = [
        connection.subscribe('session:activity', { snapshot: activity, event: activity, error: ignore }),
        connection.subscribe('session:exit', { event: refresh, error: ignore })
      ]
      await refreshOwn(entry, connection)
      void connection.ended.then(() => {
        // Dropped, not let go of: nothing there ended, and it is tried again.
        if (!entry.link.endedOnPurpose()) setState(entry, { state: 'retrying' })
      })
      atSignIn.delete(entry.host.id)
      setState(entry, { state: 'connected', version: connection.welcome.hostVersion })
      deps.wsl?.connected(entry.host)
    })
    // Before the first connect, so what hangs on the link hears it.
    entry.attached = deps.linked?.(host, entry.link) ?? null
    entry.link.keepConnected()
    return entry
  }

  const forget = (entry: Entry, removeFolder: boolean): void => {
    entries.delete(entry.host.id)
    states.delete(entry.host.id)
    deps.wsl?.forget(entry.host.id)
    for (const subscription of entry.subscriptions) subscription.unsubscribe()
    entry.attached?.stop()
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
      const listing = JSON.stringify(hosts)
      if (listing !== recorded) {
        recorded = listing
        deps.hostsChanged?.(hosts)
      }
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
        if (entry !== undefined && reachedAlike(entry.host, host)) {
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

    reachedWithSsh(target) {
      for (const entry of entries.values()) {
        const { transport } = entry.host
        if (transport.kind === 'ssh' && transport.target === target) return entry.link.current()
      }
      return null
    },

    pageLinks: (id) => entries.get(id)?.pages ?? null,

    allPageLinks: () => [...entries.values()].map((entry) => entry.pages),

    quitParts(endsOn) {
      return [...entries.values()]
        .filter((entry) => entry.link.current() !== null && endsOn(entry.host.id) && entry.own.length > 0)
        .map((entry) => ({ id: entry.host.id, name: entry.host.name, sessions: entry.own }))
    },

    installed(id, floti, startsAtNextSignIn) {
      if (startsAtNextSignIn) atSignIn.add(id)
      else atSignIn.delete(id)
      const entry = entries.get(id)
      // A host whose floti path changed is linked again by the settings
      // write that keeps the new path; one at the same path, here.
      if (quitting || entry === undefined || entry.host.floti !== floti) return
      forget(entry, false)
      entries.set(id, open(entry.host))
      tell()
    },

    adopt(host, connected) {
      if (quitting || entries.has(host.id)) {
        void connected.close()
        return
      }
      entries.set(host.id, open(host, connected))
    },

    reconnect(id) {
      if (quitting) return
      entries.get(id)?.link.reconnectNow()
    },

    async quit(endsOn) {
      quitting = true
      await Promise.all(
        [...entries.values()].map(async (entry) => {
          for (const subscription of entry.subscriptions) subscription.unsubscribe()
          entry.attached?.stop()
          await entry.pages.stop()
          await entry.link.quit({ end: endsOn(entry.host.id) })
        })
      )
    }
  }
}
