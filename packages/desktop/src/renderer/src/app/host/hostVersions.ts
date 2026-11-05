import type { RefusedVersions } from '../../../../shared/ipc'
import type { PageLink } from './link'

/**
 * What the window last heard of this PC's host's version: the floti version
 * its welcome named, or the protocol versions it named when it refused this
 * Helm's hello. Null before either. Core's `localHostVersions` says from this
 * which side is behind; the window offers Restart host to update only on the
 * user's click, never by itself.
 */
export type SeenHostVersion = { hostVersion: string } | { refused: RefusedVersions } | null

export interface SeenHostVersionStore {
  get(): SeenHostVersion
  /** Calls `listener` on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createSeenHostVersion(link: Pick<PageLink, 'onConnected' | 'onRefused'>): SeenHostVersionStore {
  let seen: SeenHostVersion = null
  const listeners = new Set<() => void>()
  const set = (next: SeenHostVersion): void => {
    seen = next
    for (const listener of listeners) listener()
  }
  link.onConnected((connection) => {
    const { hostVersion } = connection.welcome
    if (seen === null || !('hostVersion' in seen) || seen.hostVersion !== hostVersion) set({ hostVersion })
  })
  link.onRefused?.((refused) => set({ refused }))
  return {
    get: () => seen,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
