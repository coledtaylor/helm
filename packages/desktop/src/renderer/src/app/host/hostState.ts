import type { PageLink } from './link'

/**
 * Whether the window has its host, as the window shows it: from the moment
 * the host goes without a stop or a quit until the window is connected again,
 * `lost` says whether Helm is starting a new host or waiting for this one to
 * answer. `reconnects` counts the times the window got its host back after
 * such a loss, so what the new host offers (the sessions the old one lost) is
 * asked for again each time.
 */
export interface HostState {
  lost: { restarts: boolean } | null
  reconnects: number
}

export interface HostStateStore {
  get(): HostState
  /** Calls `listener` on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createHostState(link: Pick<PageLink, 'onEnded' | 'onConnected'>): HostStateStore {
  let state: HostState = { lost: null, reconnects: 0 }
  const listeners = new Set<() => void>()
  const set = (next: HostState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  link.onEnded((end) => {
    // A stop or a quit is no loss, and says nothing.
    if (!end.planned) set({ ...state, lost: { restarts: end.restarts } })
  })
  link.onConnected(() => {
    if (state.lost !== null) set({ lost: null, reconnects: state.reconnects + 1 })
  })
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
