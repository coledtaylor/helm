import type { EventPayload, HostLinkOpened } from '../../shared/ipc'
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
 *   enrolment and the settings main writes come first.
 * - A page has one connection at a time: opening again ends the last one, and
 *   a page that navigates, reloads or closes has its bridge ended.
 * - At quit every bridge is ended before main's link stops the host.
 */

/** A Helm page, as much of its web contents as this needs. */
export interface HelmPage {
  readonly id: number
  send<K extends 'hostLink:data' | 'hostLink:ended'>(channel: K, payload: EventPayload<K>): void
  /** Calls `listener` each time the page navigates away, reloads or closes. */
  onGone(listener: () => void): void
}

export interface PageLinksDeps {
  /** Whether sessions run in the local host this run. */
  inHost: boolean
  /** Helm's version, for the page's `hello`. */
  appVersion: string
  /** Whether a web contents is one of Helm's own pages. */
  isHelmPage: (id: number) => boolean
  /** Settles once main's own link has connected; rejects with the sentence saying why it could not. */
  ready: () => Promise<unknown>
  /** Starts a bridge whose host bytes go to `data`. */
  openBridge: (data: (bytes: Uint8Array) => void) => PageBridge
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
      if (!deps.inHost) return { inHost: false }
      if (!watched.has(page.id)) {
        watched.add(page.id)
        page.onGone(() => pageGone(page.id))
      }
      const last = byPage.get(page.id)
      if (last !== undefined) end(last)
      const connection = next++
      byPage.set(page.id, connection)
      try {
        await deps.ready()
      } catch (error) {
        if (byPage.get(page.id) === connection) byPage.delete(page.id)
        return { inHost: true, unreachable: (error as Error).message }
      }
      if (stopped) return { inHost: true, unreachable: 'Helm is quitting.' }
      // The page went, or opened again, while main's link connected.
      if (byPage.get(page.id) !== connection) {
        return { inHost: true, unreachable: 'The page that asked for this connection has gone.' }
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
        page.send('hostLink:ended', { connection, why })
      })
      return { inHost: true, connection, appVersion: deps.appVersion }
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
