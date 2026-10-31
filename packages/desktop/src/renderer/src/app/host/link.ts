import {
  HostRefusedError,
  connectHost,
  type ByteTransport,
  type HostConnection
} from '../../../../shared/host/client'
import type { Capability } from '../../../../shared/host/protocol'
import { unreachable } from '../../../../shared/host/sentences'
import type { HelmBridge, HostLinkOpened } from '../../../../shared/ipc'

/**
 * This page's own protocol connection to the local host, while sessions run
 * there.
 *
 * Main starts a `floti bridge` for the page and pipes its frames over
 * `hostLink:*` without reading them (`main/host/page-link.ts`); the page
 * speaks the protocol itself, through the client both builds share. The
 * device key and the Noise session stay in the bridge.
 *
 * Every caller joins one connect attempt, so a read asked before the first
 * connect has settled waits for it rather than answering that there is
 * nothing there. When the host cannot be reached it rejects with the sentence
 * saying why, naming the setting to turn off. After the connection ends, the
 * next caller connects again.
 */

/** What the app window says it can do: draw terminals, show files and draw plugins' pages. */
export const WINDOW_CAPABILITIES: readonly Capability[] = ['terminal', 'files', 'pluginPages']

export interface PageLink {
  /** Whether sessions run in the local host this run: main's answer to the first open. */
  inHost(): Promise<boolean>
  /** The connection, connecting first when there is none. Rejects with the sentence to show. */
  connection(): Promise<HostConnection>
  /**
   * Called on every connect, before `connection()` resolves, so a channel
   * subscribed here is subscribed before anything is asked of the host.
   */
  onConnected(listener: (connection: HostConnection) => void): void
}

export interface PageLinkDeps {
  /** The preload's bridge: only `hostLink:*` is used. */
  bridge: Pick<HelmBridge, 'invoke' | 'send' | 'on'>
  capabilities: readonly Capability[]
  log?: (line: string) => void
}

/** The sentence when sessions do not run in the host this run, which no host adapter is asked in. */
export const NOT_IN_HOST = 'Sessions do not run in the local host this run.'

/** A byte transport over this page's `hostLink:*` channels, for one connection. */
export function relayTransport(bridge: PageLinkDeps['bridge'], connection: number): ByteTransport {
  let ended = false
  let unsubscribe: Array<() => void> = []
  const stop = (): void => {
    ended = true
    for (const off of unsubscribe) off()
    unsubscribe = []
  }
  return {
    start(receiver) {
      unsubscribe = [
        bridge.on('hostLink:data', (payload) => {
          if (payload.connection === connection && !ended) receiver.data(payload.bytes)
        }),
        bridge.on('hostLink:ended', (payload) => {
          if (payload.connection !== connection || ended) return
          stop()
          receiver.end(payload.why)
        })
      ]
    },
    write(bytes) {
      if (!ended) bridge.send('hostLink:send', { connection, bytes })
    },
    end() {
      if (ended) return
      stop()
      bridge.send('hostLink:close', { connection })
    }
  }
}

export function createPageLink(deps: PageLinkDeps): PageLink {
  const listeners: Array<(connection: HostConnection) => void> = []
  let placement: Promise<boolean> | null = null
  /** The first open, which answered the placement, until a connect takes it. */
  let untaken: Promise<HostLinkOpened> | null = null
  let attempt: Promise<HostConnection> | null = null

  const open = (): Promise<HostLinkOpened> => {
    const opened = deps.bridge.invoke('hostLink:open')
    placement ??= opened.then(
      (answer) => answer.inHost,
      () => false
    )
    return opened
  }

  const connect = async (): Promise<HostConnection> => {
    const opened = await (untaken ?? open())
    untaken = null
    if (!opened.inHost) throw new Error(NOT_IN_HOST)
    if ('unreachable' in opened) throw new Error(opened.unreachable)
    let connection: HostConnection
    try {
      connection = await connectHost({
        transport: relayTransport(deps.bridge, opened.connection),
        appVersion: opened.appVersion,
        capabilities: deps.capabilities,
        ...(deps.log !== undefined ? { log: deps.log } : {})
      })
    } catch (error) {
      // The bridge's exit said why, as main's link would; a refused hello
      // names both versions.
      throw new Error(error instanceof HostRefusedError ? unreachable(error.message) : (error as Error).message, {
        cause: error
      })
    }
    for (const listener of listeners) {
      try {
        listener(connection)
      } catch (error) {
        deps.log?.(`host: setting up the connection failed (${(error as Error).message})`)
      }
    }
    return connection
  }

  return {
    inHost() {
      if (placement === null) untaken = open()
      return placement as Promise<boolean>
    },

    connection() {
      if (attempt !== null) return attempt
      const made: Promise<HostConnection> = connect().then(
        (connection) => {
          // Once it ends, the next caller connects again.
          void connection.ended.then(() => {
            if (attempt === made) attempt = null
          })
          return connection
        },
        (error: unknown) => {
          if (attempt === made) attempt = null
          throw error
        }
      )
      attempt = made
      return made
    },

    onConnected(listener) {
      listeners.push(listener)
    }
  }
}
