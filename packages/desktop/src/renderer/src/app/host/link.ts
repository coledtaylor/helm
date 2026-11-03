import {
  HostRefusedError,
  connectHost,
  type ByteTransport,
  type HostConnection
} from '../../../../shared/host/client'
import type { Capability } from '../../../../shared/host/protocol'
import { RECONNECT_FIRST_MS, nextReconnectWait } from '../../../../shared/host/reconnect'
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
 * saying why, naming the setting to turn off.
 *
 * When the host's side ends the connection, main says whether it ended the
 * host on purpose (Stop host, or a quit) and whether Helm starts a new one,
 * and the link tells its `onEnded` listeners. After an end on purpose the
 * next caller connects again. After any other end - a host that crashed or
 * was killed - the link connects again by itself, waiting as main's link
 * does (`shared/host/reconnect.ts`), until it connects; its `onConnected`
 * listeners then run again. A connection the page closed itself is no end
 * of the host.
 */

/** What the app window says it can do: draw terminals, show files and draw plugins' pages. */
export const WINDOW_CAPABILITIES: readonly Capability[] = ['terminal', 'files', 'pluginPages']

/** How the host's side of a connection ended. */
export interface HostEnd {
  /** Main's link ended the host on purpose: a stop or a quit, which is no crash. */
  planned: boolean
  /** Helm starts a new host in place of this one, rather than waiting for it to answer again. */
  restarts: boolean
}

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
  /** Called each time the host's side ends the connection, saying how. */
  onEnded(listener: (end: HostEnd) => void): void
}

export interface PageLinkDeps {
  /** The preload's bridge: only `hostLink:*` is used. */
  bridge: Pick<HelmBridge, 'invoke' | 'send' | 'on'>
  capabilities: readonly Capability[]
  log?: (line: string) => void
  /** The clock the waits before connecting again run on; the page's own by default. */
  setTimeout?: (run: () => void, ms: number) => unknown
  /** A host on another computer, by its id; this PC's host when absent. */
  host?: string
  /**
   * Whether the link connects again by itself after the host's side ended
   * without a stop: true by default. A remote host's page link is told when
   * to connect instead, once main's own link to that host is back.
   */
  retries?: boolean
}

/** The sentence when sessions do not run in the host this run, which no host adapter is asked in. */
export const NOT_IN_HOST = 'Sessions do not run in the local host this run.'

/**
 * A byte transport over this page's `hostLink:*` channels, for one
 * connection. `hostEnded` hears how the host's side ended, before the
 * connection does.
 */
export function relayTransport(
  bridge: PageLinkDeps['bridge'],
  connection: number,
  hostEnded?: (end: HostEnd) => void
): ByteTransport {
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
          hostEnded?.({ planned: payload.planned, restarts: payload.restarts })
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
  const endListeners: Array<(end: HostEnd) => void> = []
  const setTimer = deps.setTimeout ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms))
  let placement: Promise<boolean> | null = null
  /** The first open, which answered the placement, until a connect takes it. */
  let untaken: Promise<HostLinkOpened> | null = null
  let attempt: Promise<HostConnection> | null = null
  let retryTimer: unknown = null
  let retryWait = RECONNECT_FIRST_MS

  /** Connects again after a wait, and again after a longer one each time that fails. */
  const scheduleRetry = (): void => {
    if (retryTimer !== null) return
    const wait = retryWait
    retryWait = nextReconnectWait(retryWait)
    retryTimer = setTimer(() => {
      retryTimer = null
      link.connection().then(
        () => undefined,
        () => scheduleRetry()
      )
    }, wait)
  }

  const hostEnded = (end: HostEnd): void => {
    for (const listener of endListeners) {
      try {
        listener(end)
      } catch (error) {
        deps.log?.(`host: hearing the connection end failed (${(error as Error).message})`)
      }
    }
    if (!end.planned && deps.retries !== false) scheduleRetry()
  }

  const open = (): Promise<HostLinkOpened> => {
    const opened = deps.bridge.invoke('hostLink:open', deps.host === undefined ? undefined : { host: deps.host })
    placement ??= opened.then(
      (answer) => answer.inHost,
      () => false
    )
    return opened
  }

  /** Connects once; `ended` hears how the host's side ended this connection, if it does. */
  const connect = async (ended: (end: HostEnd) => void): Promise<HostConnection> => {
    const opened = await (untaken ?? open())
    untaken = null
    if (!opened.inHost) throw new Error(NOT_IN_HOST)
    if ('unreachable' in opened) throw new Error(opened.unreachable)
    let connection: HostConnection
    try {
      connection = await connectHost({
        transport: relayTransport(deps.bridge, opened.connection, ended),
        appVersion: opened.appVersion,
        ...(opened.deviceName !== undefined ? { deviceName: opened.deviceName } : {}),
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

  const link: PageLink = {
    inHost() {
      if (placement === null) untaken = open()
      return placement as Promise<boolean>
    },

    connection() {
      if (attempt !== null) return attempt
      let end: HostEnd | null = null
      const made: Promise<HostConnection> = connect((how) => {
        end = how
      }).then(
        (connection) => {
          retryWait = RECONNECT_FIRST_MS
          // Once it ends, the next caller connects again; a host that went
          // without a stop is connected to again without waiting for one.
          void connection.ended.then(() => {
            if (attempt === made) attempt = null
            if (end !== null) hostEnded(end)
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
    },

    onEnded(listener) {
      endListeners.push(listener)
    }
  }
  return link
}
