import type { StandingNotice } from '@helm/core/types'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * The notices standing on a host: a child that needs a person, a start a limit
 * refused, a child that ended in error. The host keeps them, so the window
 * subscribes on every connect, and the first snapshot is whatever still stands.
 * Dismissing one, and allowing a parent more starts, are the host's: the window
 * asks over its own connection, in ipc.ts's shapes.
 *
 * The latest list is kept and handed to a listener that arrives after it, so a
 * page that mounts once the host has answered is not left without the notices.
 * With no host the requests reject with the link's sentence.
 */

export function noticeFromHost(notice: P.StandingNotice): StandingNotice {
  return {
    id: notice.id,
    kind: notice.kind,
    parentId: notice.parentId,
    parentName: notice.parentName,
    childId: notice.childId ?? null,
    childName: notice.childName ?? null,
    text: notice.text,
    since: notice.since,
    limit: notice.limit ?? null,
    allowMore: notice.allowMore ?? null
  }
}

/** One notice as this window tells it apart from the same host's next one with its id: a child that waits again begins a new notice. */
export const noticeKey = (notice: Pick<StandingNotice, 'id' | 'since'>): string => `${notice.id}\n${notice.since}`

/**
 * What a window holds of one host's notices: those standing now, and those
 * that stood when its connection to the host opened and still do (While you
 * were away), which are none once the window closed that list.
 */
export interface NoticesView {
  /** Every notice standing now. */
  notices: readonly StandingNotice[]
  /** The ones standing when the connection opened that still stand; empty once closed in this window. */
  away: readonly StandingNotice[]
  /** The `noticeKey` of each notice that stood when the connection opened, kept after it resolves. */
  atConnect: ReadonlySet<string>
}

export interface NoticesStore {
  get(): NoticesView
  /** Called on every change; also asks for the host's list. Returns the stop. */
  subscribe(listener: () => void): () => void
  /** Closes the While you were away list in this window, until the next connect. */
  closeAway(): void
}

export type NoticesAdapter = HostAdapter & { store: NoticesStore }

export function createNoticesAdapter(link: HostReach, log: (line: string) => void = () => undefined): NoticesAdapter {
  const listeners = new Set<(notices: StandingNotice[]) => void>()
  const watchers = new Set<() => void>()
  let subscription: HostSubscription | null = null
  let latest: StandingNotice[] | null = null
  let atConnect: ReadonlySet<string> = new Set()
  let awayClosed = false
  let view: NoticesView = { notices: [], away: [], atConnect }

  const host = (): Promise<HostConnection> => link.connection()
  const refresh = (): void => {
    const notices = latest ?? []
    view = {
      notices,
      away: awayClosed ? [] : notices.filter((notice) => atConnect.has(noticeKey(notice))),
      atConnect
    }
    for (const watcher of [...watchers]) watcher()
  }
  const take = (listed: readonly P.StandingNotice[]): void => {
    const first = latest === null
    latest = listed.map(noticeFromHost)
    if (first) atConnect = new Set(latest.map(noticeKey))
    for (const listener of listeners) listener(latest)
    refresh()
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    latest = null
    atConnect = new Set()
    awayClosed = false
    refresh()
    subscription = connection.subscribe('notices:changed', {
      snapshot: take,
      event: take,
      error: (error) => log(`host: notices:changed ended (${error.message})`)
    })
  })

  const store: NoticesStore = {
    get: () => view,
    subscribe: (listener) => {
      watchers.add(listener)
      void host().catch(() => undefined)
      return () => {
        watchers.delete(listener)
      }
    },
    closeAway: () => {
      if (awayClosed) return
      awayClosed = true
      refresh()
    }
  }

  return {
    store,
    requests: {
      'notices:dismiss': async ({ id }): Promise<void> => {
        await (await host()).request('notices:dismiss', { id })
      },
      'notices:allowMore': async ({ parentId }): Promise<{ added: number }> => {
        const allowed = await (await host()).request('notices:allowMore', { parentId })
        return { added: allowed.added }
      }
    },
    events: {
      'notices:changed': (listener) => {
        listeners.add(listener)
        if (latest !== null) listener(latest)
        void host().catch(() => undefined)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}
