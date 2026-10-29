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
 * Stopping is bounded: a host that does not answer in time is left to its
 * standard input closing, which stops it as Helm exits.
 */

/** How long a quit waits for the host to stop, and then for both programs to exit. */
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
   * Ends the sessions and stops the host when Helm started it, then lets go
   * of both programs; resolves once both have exited, or the deadline passed.
   * Nothing connects after it.
   */
  stop(): Promise<void>
}

export interface HostLinkDeps {
  start: () => Promise<LocalHost>
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
    const started = await deps.start()
    if (stopping !== null) {
      await started.stop()
      throw new Error('Helm is quitting.')
    }
    local = started
    const { connection } = started
    void connection.ended.then(() => {
      if (local !== started) return
      local = null
      attempt = null
    })
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

  return {
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

    stop() {
      stopping ??= (async () => {
        if (attempt !== null) await bounded(attempt)
        const host = local
        if (host === null) return
        local = null
        if (host.startedHost) {
          // A plain stop: every session ends and is recorded as ended. Its
          // answer may not arrive - the host closes the connection as it goes.
          await bounded(host.connection.request('host:stop', { reason: 'stop' }))
        }
        await bounded(host.stop())
      })()
      return stopping
    }
  }
}
