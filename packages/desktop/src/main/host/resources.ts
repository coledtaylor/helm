import type { SessionResources } from '@helm/core'
import type { ResourcesService } from '../resources'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import { resourcesFromHost } from './records'
import type { Emit } from './sessions'

/**
 * What each hosted session is holding - its process tree and its ports - when
 * sessions run in the local host. The host runs the pass (it is the one with
 * the sessions' processes) under the same rules Helm's own pass keeps: only
 * while somebody is looking, every 4s, never two at once. This is how the
 * window reads it, as the same `ResourcesService` Helm's own pass is.
 *
 * On every connect it subscribes to the host's `sessions:resources` and hands
 * each set to the window, converted field by field, so "could not look"
 * (null) and "nothing there" ([]) reach the pane as the host said them.
 *
 * A read goes through `link.connection()`, which joins the first connect while
 * it is in flight, and then waits for that connection's first set, so a window
 * that asks before Helm has reached the host gets the host's answer, never an
 * empty one first. When the host cannot be reached the read rejects with the
 * link's sentence, and when the connection ends the window is told the empty
 * set: a hosted session with no entry paints Unknown, never "nothing there".
 *
 * Watching stays reference-counted here, so two things looking from this
 * window cannot switch each other off; the host is told only when the count
 * crosses zero, and again on every connect while somebody is looking.
 */

export interface HostResourcesDeps {
  link: HostLink
  /** Sends an event to the window. */
  emit: Emit
  log: (line: string) => void
}

/** The host's pass, read over the link: a read waits for the host's answer. */
export interface HostResources extends ResourcesService {
  snapshots: () => Promise<SessionResources[]>
}

export function createHostResources({ link, emit, log }: HostResourcesDeps): HostResources {
  let watchers = 0
  let stopped = false
  let current: SessionResources[] = []
  let subscription: HostSubscription | null = null
  /** The connection the window's set came from; only its end clears the set. */
  let source: HostConnection | null = null
  /** Each connection's first set, which a read waits for. */
  const firstSet = new WeakMap<HostConnection, Promise<void>>()
  /** What the host was last told about this client looking, on which connection. */
  let told: { connection: HostConnection; watching: boolean } | null = null
  let syncing = false
  let again = false

  const wanted = (): boolean => !stopped && watchers > 0

  const publish = (next: SessionResources[]): void => {
    current = next
    emit('sessions:resources', current)
  }

  async function tell(connection: HostConnection, watching: boolean): Promise<void> {
    told = { connection, watching }
    try {
      await connection.request('sessions:watch', { watching })
    } catch (error) {
      log(`host: could not tell the host whether the sessions pane is open (${(error as Error).message})`)
    }
  }

  /** The connection, joining the connect in flight; null, said in the log, when the host cannot be reached. */
  async function reach(): Promise<HostConnection | null> {
    try {
      return await link.connection()
    } catch (error) {
      log(`host: processes and ports cannot be read (${(error as Error).message})`)
      return null
    }
  }

  /**
   * Tells the host whether this client is looking, once per change: joins the
   * connect in flight, and sends only the latest state when several changes
   * landed while one was being sent.
   */
  async function sync(): Promise<void> {
    if (syncing) {
      again = true
      return
    }
    syncing = true
    try {
      do {
        again = false
        const watching = wanted()
        const connection = watching ? await reach() : link.current()
        if (connection === null) continue
        if (told?.connection === connection && told.watching === watching) continue
        await tell(connection, watching)
      } while (again)
    } finally {
      syncing = false
    }
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    source = connection
    let arrived = (): void => undefined
    let failed = (_error: Error): void => undefined
    const first = new Promise<void>((resolve, reject) => {
      arrived = resolve
      failed = reject
    })
    // A read that never came is answered to whoever asked; nobody asking is not an error.
    first.catch(() => undefined)
    firstSet.set(connection, first)

    const take = (sets: readonly P.SessionResources[]): void => {
      if (source !== connection) return
      publish(resourcesFromHost(sets))
      arrived()
    }
    subscription = connection.subscribe('sessions:resources', {
      snapshot: take,
      event: take,
      error: (error) => {
        log(`host: sessions:resources ended (${error.message})`)
        failed(error)
      }
    })
    void connection.ended.then((sentence) => {
      failed(new Error(sentence))
      if (source !== connection) return
      source = null
      subscription = null
      // What the window holds was this connection's: every hosted row paints
      // Unknown until a connection answers again.
      publish([])
    })

    // A new connection's host is not watching for this client, so it is told
    // only if somebody here is looking - this connection, before anything
    // else is asked of it.
    told = { connection, watching: false }
    if (wanted()) void tell(connection, true)
  })

  return {
    async snapshots() {
      const connection = await link.connection()
      await firstSet.get(connection)
      return current
    },

    watch(on) {
      if (stopped) return
      const before = watchers > 0
      watchers = Math.max(0, watchers + (on ? 1 : -1))
      if (watchers > 0 !== before) void sync()
    },

    // The host passes again by itself when one of its sessions ends.
    refresh: () => Promise.resolve(),

    // The host's pass, timed in the host.
    lastPass: () => null,

    stop() {
      stopped = true
      watchers = 0
      subscription?.unsubscribe()
      subscription = null
      source = null
    }
  }
}
