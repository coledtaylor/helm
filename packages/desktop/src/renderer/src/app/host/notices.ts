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

export function createNoticesAdapter(link: HostReach, log: (line: string) => void = () => undefined): HostAdapter {
  const listeners = new Set<(notices: StandingNotice[]) => void>()
  let subscription: HostSubscription | null = null
  let latest: StandingNotice[] | null = null

  const host = (): Promise<HostConnection> => link.connection()
  const take = (listed: readonly P.StandingNotice[]): void => {
    latest = listed.map(noticeFromHost)
    for (const listener of listeners) listener(latest)
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    latest = null
    subscription = connection.subscribe('notices:changed', {
      snapshot: take,
      event: take,
      error: (error) => log(`host: notices:changed ended (${error.message})`)
    })
  })

  return {
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
