import type { PageLink } from './link'

/**
 * Whether the window has its host, as the window shows it: from the moment
 * the host goes without a stop or a quit until the window is connected again,
 * `lost` says whether Helm is starting a new host or waiting for this one to
 * answer. `restarting` is set from the moment a Restart host to update ends
 * the connection until the window has the new host: no loss, and nothing is
 * marked lost. `reconnects` counts the times the window got its host back
 * after either, or got one at all after a host refused it, so what the new
 * host lists and offers (the sessions the old one could not hand over) is
 * asked for again each time.
 */
export interface HostState {
  lost: { restarts: boolean } | null
  restarting: boolean
  reconnects: number
}

export interface HostStateStore {
  get(): HostState
  /** Calls `listener` on every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
}

export function createHostState(link: Pick<PageLink, 'onEnded' | 'onConnected' | 'onRefused'>): HostStateStore {
  let state: HostState = { lost: null, restarting: false, reconnects: 0 }
  /** A host refused the window since it last connected: nothing it shows came from a host yet. */
  let refused = false
  const listeners = new Set<() => void>()
  const set = (next: HostState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  link.onEnded((end) => {
    // A restart for an update is no loss, and comes back at once.
    if (end.restarting === true) set({ ...state, restarting: true })
    // A stop or a quit is no loss, and says nothing.
    else if (!end.planned) set({ ...state, lost: { restarts: end.restarts } })
  })
  link.onRefused?.(() => {
    refused = true
  })
  link.onConnected(() => {
    const afterRefusal = refused
    refused = false
    if (state.lost !== null || state.restarting || afterRefusal) {
      set({ lost: null, restarting: false, reconnects: state.reconnects + 1 })
    }
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
