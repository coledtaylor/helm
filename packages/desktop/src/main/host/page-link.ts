import { LOCAL_HOST_KEY } from '@helm/core/types'
import type { EventPayload, HostLinkOpened, RefusedVersions } from '../../shared/ipc'
import type { PageBridge } from './launcher'

/**
 * Each Helm page's own connection to the local host, while sessions run there.
 *
 * A Helm page that reaches a host feature does so over a protocol connection
 * of its own: main starts a `floti bridge` for it and pipes its frames both
 * ways over `hostLink:*`, reading none of them. The device key and the Noise
 * session stay in the bridge, so no window holds a key, and main logs no
 * frame.
 *
 * - Only Helm's own pages may open one, checked by web-contents id: never a
 *   plugin frame, an artifact frame or a page in the Browser tab.
 * - A page's bridge is opened only after main's own link has connected, so
 *   the host key it pinned and the settings main writes come first.
 * - A page has one connection at a time: opening again ends the last one, and
 *   a page that navigates, reloads or closes has its bridge ended.
 * - At quit every bridge is ended before main's link stops the host.
 * - A bridge that ends by itself tells the page whether main's link ended the
 *   host on purpose (Stop host, or a quit), and whether Helm starts a new host
 *   in place of this one, so a page tells a crash from a stop and says what
 *   comes next.
 */

/** A Helm page, as much of its web contents as this needs. */
export interface HelmPage {
  readonly id: number
  send<K extends 'hostLink:data' | 'hostLink:ended'>(channel: K, payload: EventPayload<K>): void
  /** Calls `listener` each time the page navigates away, reloads or closes. */
  onGone(listener: () => void): void
}

export interface PageLinksDeps {
  /** Helm's version, for the page's `hello`. */
  appVersion: string
  /** The computer's name, for the page's `hello`, as main's gives it. */
  deviceName?: string
  /** Whether a web contents is one of Helm's own pages. */
  isHelmPage: (id: number) => boolean
  /** Settles once main's own link has connected; rejects with the sentence saying why it could not. */
  ready: () => Promise<unknown>
  /** Whether main's link ended the host on purpose, and whether Helm starts a new one if it is gone. */
  howEnded: () => { planned: boolean; restarts: boolean; restarting?: boolean }
  /** Starts a bridge whose host bytes go to `data`. */
  openBridge: (data: (bytes: Uint8Array) => void) => PageBridge
  /**
   * The number the next connection is opened under. Every host's page links
   * share one counter, so a number names one connection whichever host it
   * reaches; each counts from 1 on its own when absent.
   */
  nextConnection?: () => number
  log: (line: string) => void
}

export interface PageLinks {
  /** Opens `page`'s connection, ending any it had. Throws for a page that is not Helm's. */
  open(page: HelmPage): Promise<HostLinkOpened>
  /** A page's bytes for its bridge; anything not from the page that opened `connection` is dropped. */
  send(pageId: number, connection: number, bytes: Uint8Array): void
  /** The page closed `connection`. */
  close(pageId: number, connection: number): void
  /** Ends every bridge and resolves once each has exited. Nothing opens after it. */
  stop(): Promise<void>
}

interface Open {
  page: number
  bridge: PageBridge
}

export const FOREIGN_PAGE = 'Only Helm’s own pages may connect to the local host.'

export function createPageLinks(deps: PageLinksDeps): PageLinks {
  const open = new Map<number, Open>()
  /** The connection each page has now, and the one it is opening, by page id. */
  const byPage = new Map<number, number>()
  const watched = new Set<number>()
  let next = 1
  const nextConnection = deps.nextConnection ?? (() => next++)
  let stopped = false

  const end = (connection: number): void => {
    const entry = open.get(connection)
    if (entry === undefined) return
    open.delete(connection)
    if (byPage.get(entry.page) === connection) byPage.delete(entry.page)
    entry.bridge.end()
  }

  const pageGone = (pageId: number): void => {
    const connection = byPage.get(pageId)
    // A newer open for this page waits on `ready`; it is ended when it gets there.
    byPage.delete(pageId)
    if (connection !== undefined) end(connection)
  }

  return {
    async open(page) {
      if (!deps.isHelmPage(page.id)) throw new Error(FOREIGN_PAGE)
      if (!watched.has(page.id)) {
        watched.add(page.id)
        page.onGone(() => pageGone(page.id))
      }
      const last = byPage.get(page.id)
      if (last !== undefined) end(last)
      const connection = nextConnection()
      byPage.set(page.id, connection)
      try {
        await deps.ready()
      } catch (error) {
        if (byPage.get(page.id) === connection) byPage.delete(page.id)
        // A refused hello keeps the versions it named (`LocalHostRefusedError`).
        const refused = (error as { refused?: RefusedVersions }).refused
        return { unreachable: (error as Error).message, ...(refused !== undefined ? { refused } : {}) }
      }
      if (stopped) return { unreachable: 'Helm is quitting.' }
      // The page went, or opened again, while main's link connected.
      if (byPage.get(page.id) !== connection) {
        return { unreachable: 'The page that asked for this connection has gone.' }
      }
      const bridge = deps.openBridge((bytes) => {
        if (open.has(connection)) page.send('hostLink:data', { connection, bytes })
      })
      open.set(connection, { page: page.id, bridge })
      void bridge.ended.then((why) => {
        if (!open.has(connection)) return
        open.delete(connection)
        if (byPage.get(page.id) === connection) byPage.delete(page.id)
        if (why !== null) deps.log('host: a page’s connection to the local host ended')
        page.send('hostLink:ended', { connection, why, ...deps.howEnded() })
      })
      return {
        connection,
        appVersion: deps.appVersion,
        ...(deps.deviceName !== undefined ? { deviceName: deps.deviceName } : {})
      }
    },

    send(pageId, connection, bytes) {
      const entry = open.get(connection)
      if (entry === undefined || entry.page !== pageId) return
      entry.bridge.write(bytes)
    },

    close(pageId, connection) {
      const entry = open.get(connection)
      if (entry === undefined || entry.page !== pageId) return
      end(connection)
    },

    async stop() {
      stopped = true
      const bridges = [...open.values()].map((entry) => entry.bridge)
      open.clear()
      byPage.clear()
      for (const bridge of bridges) bridge.end()
      await Promise.all(bridges.map((bridge) => bridge.ended))
    }
  }
}

/**
 * Every Helm page's connections: to this PC's host, and to each host on
 * another computer, named by its id in `hostLink:open`. Bytes and closes
 * carry the connection's number, which every host's page links take from one
 * counter, so each goes to the one link that opened it.
 */
export interface HostPageLinks {
  /** Opens `page`'s connection to `host`: this PC's when null or `local`. */
  open(page: HelmPage, host: string | null): Promise<HostLinkOpened>
  send(pageId: number, connection: number, bytes: Uint8Array): void
  close(pageId: number, connection: number): void
  /** Ends this PC's host's page bridges; each remote host's are its link's. */
  stop(): Promise<void>
}

export function routePageLinks(
  local: PageLinks,
  remote: { pageLinks(id: string): PageLinks | null; allPageLinks(): readonly PageLinks[] } | null
): HostPageLinks {
  const everyLink = (): readonly PageLinks[] => [local, ...(remote?.allPageLinks() ?? [])]
  return {
    open(page, host) {
      if (host === null || host === LOCAL_HOST_KEY) return local.open(page)
      const links = remote?.pageLinks(host) ?? null
      if (links === null) return Promise.resolve({ unreachable: 'This PC has no such host.' })
      return links.open(page)
    },
    send(pageId, connection, bytes) {
      for (const links of everyLink()) links.send(pageId, connection, bytes)
    },
    close(pageId, connection) {
      for (const links of everyLink()) links.close(pageId, connection)
    },
    stop: () => local.stop()
  }
}
