import type { EventChannel, EventPayload } from '../../../../shared/ipc'
import type { EventRoute } from './router'

/**
 * The window's listeners on the events a host adapter hands it, by channel.
 * Listening is reason enough to connect, so each new listener calls `onListen`.
 */
export interface LocalEvents {
  tell<K extends EventChannel>(channel: K, payload: EventPayload<K>): void
  listen<K extends EventChannel>(channel: K): EventRoute<K>
  /** How many listen on `channel` now. */
  count(channel: EventChannel): number
}

export function createLocalEvents(onListen: () => void): LocalEvents {
  const sets = new Map<EventChannel, Set<(payload: never) => void>>()
  const of = (channel: EventChannel): Set<(payload: never) => void> => {
    let set = sets.get(channel)
    if (set === undefined) {
      set = new Set()
      sets.set(channel, set)
    }
    return set
  }
  return {
    tell(channel, payload) {
      for (const listener of [...of(channel)]) (listener as (payload: unknown) => void)(payload)
    },
    listen(channel) {
      return (listener) => {
        const set = of(channel)
        const held = listener as (payload: never) => void
        set.add(held)
        onListen()
        return () => {
          set.delete(held)
        }
      }
    },
    count: (channel) => sets.get(channel)?.size ?? 0
  }
}
