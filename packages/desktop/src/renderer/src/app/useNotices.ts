import { useSyncExternalStore } from 'react'
import type { NoticesStore, NoticesView } from './host/notices'

/**
 * The notices standing on each host this window is connected to, and what the
 * user can do with them: dismiss one (for every client), allow a parent more
 * starts after its starts limit refused it, and close the While you were away
 * list in this window until its connection to that host opens again.
 *
 * Each host's notices are the host's own (`host/notices.ts`); this joins them
 * so a view reads one place.
 */

export interface HostNotices {
  /** Every host's view, by host key; a host not yet heard from has none. The same map until one changes. */
  get(): ReadonlyMap<string, NoticesView>
  subscribe(listener: () => void): () => void
  /** Dismisses the notice `id` on `host`; the host removes it for every client. */
  dismiss(host: string, id: string): Promise<void>
  /** Lets `parentId` on `host` start more (the starts setting's value); resolves with how many it added. */
  allowMore(host: string, parentId: number): Promise<number>
  /** Closes While you were away on `host` in this window. */
  closeAway(host: string): void
}

export interface HostNoticesDeps {
  /** Calls `listener` with every host's notices store, this PC's first, and each made from now on; returns the stop. */
  each: (listener: (host: string, store: NoticesStore) => void) => () => void
  dismiss: (host: string, id: string) => Promise<void>
  allowMore: (host: string, parentId: number) => Promise<{ added: number }>
}

export function createHostNotices(deps: HostNoticesDeps): HostNotices {
  const stores = new Map<string, NoticesStore>()
  let views: ReadonlyMap<string, NoticesView> = new Map()
  const listeners = new Set<() => void>()
  const stops: Array<() => void> = []
  let attached = false

  const changed = (host: string, store: NoticesStore): void => {
    const next = new Map(views)
    next.set(host, store.get())
    views = next
    for (const listener of [...listeners]) listener()
  }
  const attach = (): void => {
    if (attached) return
    attached = true
    stops.push(
      deps.each((host, store) => {
        stores.set(host, store)
        stops.push(store.subscribe(() => changed(host, store)))
        changed(host, store)
      })
    )
  }
  const detach = (): void => {
    attached = false
    for (const stop of stops.splice(0)) stop()
    stores.clear()
    views = new Map()
  }

  return {
    get: () => views,
    subscribe(listener) {
      listeners.add(listener)
      attach()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) detach()
      }
    },
    dismiss: (host, id) => deps.dismiss(host, id),
    allowMore: async (host, parentId) => (await deps.allowMore(host, parentId)).added,
    closeAway: (host) => stores.get(host)?.closeAway()
  }
}

/** The notices of every host as a hook. */
export function useHostNotices(source: HostNotices): ReadonlyMap<string, NoticesView> {
  return useSyncExternalStore(source.subscribe, source.get)
}
