import { RECONNECT_FIRST_MS, nextReconnectWait } from '../../shared/host/reconnect'
import type { HostConnection } from './client'
import type { LocalHost } from './launcher'
import type { HostSettingsPatch } from './protocol'

/**
 * Helm's one connection to the local host, made when Helm starts and again
 * whenever it is wanted after the last one failed or ended.
 *
 * On every connect, before anything else uses it, Helm writes the two things
 * its own Settings decide for the host's sessions - the `claude` it runs and
 * the shell a terminal opens - and reads nothing else back: everything else in
 * the host's settings is the host's.
 *
 * Helm never stops the host on its own. A deliberate quit tells it what
 * becomes of what this device started (`host:quit`) and lets go; the host
 * decides its own exit. Quitting is bounded: a host that does not answer in
 * time is let go of all the same, and a Helm that crashes or is killed tells
 * it nothing. The user can stop it from Settings (`stopHost`), which ends
 * every session; the next request then starts a fresh one.
 *
 * A connection that ends without a stop or a quit is a host that crashed or
 * was killed. The link then connects again by itself, the first try after
 * `RECONNECT_FIRST_MS` and each wait after a failed try twice the last, up to
 * two minutes, until it connects or Helm quits. It starts a new host only in
 * place of one a desktop started (this Helm, or another whose host it found
 * and which says so in `app:info`); any other host is waited for, never
 * replaced. Every `onConnected` listener runs again on the new connection.
 */

/** How long a quit waits for the host's answer, and then for the bridge to exit. */
export const HOST_STOP_DEADLINE_MS = 10_000

export interface HostLink {
  /** The connection, connecting first when there is none. Rejects with the sentence to show. */
  connection(): Promise<HostConnection>
  /** The connection there is now, or null. */
  current(): HostConnection | null
  /** Settles once the attempt in flight has, without starting one. */
  settled(): Promise<void>
  /**
   * Called on every connect, after the settings are written and before
   * `connection()` resolves, so nothing is asked of the host before what it
   * needs to answer is subscribed.
   */
  onConnected(listener: (connection: HostConnection) => void | Promise<void>): void
  /** Writes Helm's settings for the host's sessions to the host connected now. */
  writeSettings(): void
  /**
   * Helm is quitting on purpose: tells the host that the plain terminals this
   * device opened end, and with `end` the sessions it started too, then lets
   * go of the connection and its bridge; resolves once the bridge has exited,
   * or the deadline passed. The host is never stopped here. Nothing connects
   * after it.
   */
  quit(options: { end: boolean }): Promise<void>
  /**
   * The user asked, and agreed to the count: stops the host (`host:stop`
   * with the plain-stop reason), so every session in it ends and is recorded
   * as ended, then lets go of the connection and its bridge. Resolves once
   * the connection has ended, or the deadline passed. The next `connection()`
   * connects again as after any ended connection, which starts a fresh host.
   */
  stopHost(): Promise<void>
  /**
   * Whether the connection there is, or the last one, is ending or ended
   * because Helm stopped the host or is quitting: an end that is no crash.
   */
  endedOnPurpose(): boolean
  /** Whether Helm starts a new host if the one it reaches now, or last reached, is gone. */
  restartsHost(): boolean
}

export interface HostLinkDeps {
  /**
   * Connects to the local host. With `startHost` false it only connects,
   * and a host that does not answer is a failure rather than one to start.
   */
  start: (options: { startHost: boolean }) => Promise<LocalHost>
  /** What Helm writes to the host on every connect. */
  settings: () => HostSettingsPatch
  log: (line: string) => void
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export function createHostLink(deps: HostLinkDeps): HostLink {
  const listeners: Array<(connection: HostConnection) => void | Promise<void>> = []
  let local: LocalHost | null = null
  let attempt: Promise<HostConnection> | null = null
  let stopping: Promise<void> | null = null
  /** Set while the user's Stop host is under way, until the next connect. */
  let stoppingHost = false
  /** Whether the host reached now, or last, was started by a desktop. */
  let desktopHost = true
  /** Whether the next connect may start a host when none answers. */
  let mayStart = true
  let retryTimer: unknown = null
  let retryWait = RECONNECT_FIRST_MS

  /** Tries to connect again after a wait, until it connects or Helm quits. */
  const scheduleRetry = (): void => {
    if (stopping !== null || retryTimer !== null) return
    const wait = retryWait
    retryWait = nextReconnectWait(retryWait)
    retryTimer = deps.setTimeout(() => {
      retryTimer = null
      if (stopping !== null || local !== null) return
      link.connection().then(
        () => undefined,
        (error: unknown) => {
          deps.log(`host: the local host could not be reached again (${(error as Error).message})`)
          scheduleRetry()
        }
      )
    }, wait)
  }

  /** `work`, or nothing once the deadline has passed. */
  const bounded = async (work: Promise<unknown>): Promise<void> => {
    let timer: unknown = null
    const deadline = new Promise<void>((resolve) => {
      timer = deps.setTimeout(resolve, HOST_STOP_DEADLINE_MS)
    })
    await Promise.race([
      work.then(
        () => undefined,
        () => undefined
      ),
      deadline
    ])
    deps.clearTimeout(timer)
  }

  const writeSettings = async (connection: HostConnection): Promise<void> => {
    try {
      await connection.request('settings:write', deps.settings())
    } catch (error) {
      deps.log(`host: could not write Helm's settings to the local host (${(error as Error).message})`)
    }
  }

  const connect = async (): Promise<HostConnection> => {
    const started = await deps.start({ startHost: mayStart })
    if (stopping !== null) {
      await started.close()
      throw new Error('Helm is quitting.')
    }
    local = started
    stoppingHost = false
    retryWait = RECONNECT_FIRST_MS
    desktopHost = started.startedHost
    const { connection } = started
    void connection.ended.then(() => {
      if (local !== started) return
      local = null
      attempt = null
      if (stopping !== null || stoppingHost) {
        // Stopped on purpose: the next request starts a fresh host.
        mayStart = true
        return
      }
      mayStart = desktopHost
      deps.log(
        `host: the connection to the local host ended without a stop; ${
          mayStart ? 'starting a new host' : 'connecting to it again once it answers'
        }`
      )
      scheduleRetry()
    })
    if (!started.startedHost) {
      // A host found running is replaced only if a desktop started it.
      void connection.request('app:info', null).then(
        (info) => {
          if (local === started) desktopHost = info?.desktop === true
        },
        () => undefined
      )
    }
    await writeSettings(connection)
    for (const listener of listeners) {
      try {
        await listener(connection)
      } catch (error) {
        deps.log(`host: setting up the connection failed (${(error as Error).message})`)
      }
    }
    return connection
  }

  const link: HostLink = {
    connection() {
      if (stopping !== null) return Promise.reject(new Error('Helm is quitting.'))
      attempt ??= connect().catch((error: unknown) => {
        attempt = null
        throw error
      })
      return attempt
    },

    current: () => local?.connection ?? null,

    settled: () =>
      attempt === null
        ? Promise.resolve()
        : attempt.then(
            () => undefined,
            () => undefined
          ),

    onConnected(listener) {
      listeners.push(listener)
    },

    writeSettings() {
      const connection = local?.connection
      if (connection !== undefined) void writeSettings(connection)
    },

    async stopHost() {
      const connection = await link.connection()
      const host = local
      stoppingHost = true
      try {
        await connection.request('host:stop', { reason: 'stop' })
      } catch (error) {
        // Not stopped, unless the connection went with the asking.
        if (local !== null && local.connection === connection) stoppingHost = false
        throw error
      }
      await bounded(connection.ended)
      // The bridge goes with the host it reached; this makes sure of it.
      if (host !== null && host.connection === connection) await bounded(host.close())
    },

    endedOnPurpose: () => stopping !== null || stoppingHost,

    restartsHost: () => (local === null ? mayStart : desktopHost),

    quit({ end }) {
      if (retryTimer !== null) {
        deps.clearTimeout(retryTimer)
        retryTimer = null
      }
      stopping ??= (async () => {
        if (attempt !== null) await bounded(attempt)
        const host = local
        if (host === null) return
        local = null
        await bounded(host.connection.request('host:quit', { end }))
        await bounded(host.close())
      })()
      return stopping
    }
  }
  return link
}
