import { randomUUID } from 'node:crypto'
import {
  remoteHostsProblem,
  type AgentStatus,
  type HostAddOutcome,
  type HostAddRequest,
  type HostFailureCause,
  type RemoteHost
} from '@helm/core/types'
import type { LocalHost } from './launcher'
import { RemoteHostError } from './remote-launcher'

/**
 * Adding a host on another computer is connecting to it.
 *
 * The add-a-host dialog has checked the computer, and installed floti there
 * after a yes, before it asks for this. Main then:
 *
 * 1. mints the host's id, which names its own client folder here;
 * 2. makes the host's first connection through the user's own ssh or command
 *    (`startRemoteHost`), which pins the key the host proves once the
 *    handshake completes; nothing is approved, typed or copied there;
 * 3. reads the floti version its welcome named, and asks it `setup:status`
 *    for each agent there, which the host judges by the agent's own check;
 * 4. only then hands the connection on (`keep`), which gives it to the host's
 *    link and writes the host into this device's hosts setting.
 *
 * A failure at any step, or a cancel before step 4, stops the connection,
 * removes the client folder and writes nothing: no host is listed and no key
 * is left pinned. The same attempt id stops a check under way, so Cancel on
 * any screen of the dialog stops whatever runs for it.
 */

export interface RemoteHostAdderDeps {
  /** The hosts this device has now: the new one must be another. */
  hosts: () => readonly RemoteHost[]
  /** The first connection to `host`, in its own client folder, stopped by `signal`. */
  connect: (host: RemoteHost, signal: AbortSignal) => Promise<LocalHost>
  /** Removes the client folder of a host that was not added, with the key it pinned. */
  forget: (host: RemoteHost) => Promise<void>
  newId?: () => string
  log: (line: string) => void
}

export interface RemoteHostAdder {
  /**
   * Adds the host the request names by connecting to it. `keep` is given the
   * host and its connection once it connected, and must take both on at once:
   * give the connection to the host's link and write the host.
   */
  add(request: HostAddRequest, keep: (host: RemoteHost, connected: LocalHost) => void): Promise<HostAddOutcome>
  /** A signal for a check under `attempt`, which `cancel(attempt)` aborts. Released once the check is done. */
  during<T>(attempt: string, run: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Stops whatever runs under `attempt`: its check or its first connection. */
  cancel(attempt: string): void
}

/** Why a first connection did not connect, as the dialog's classifier reads it. */
function failure(error: unknown): HostAddOutcome {
  if (!(error instanceof RemoteHostError)) return { kind: 'failed', lastLine: (error as Error).message }
  const { lastLine, refused, keyChanged } = error
  let cause: HostFailureCause | undefined
  if (keyChanged) cause = { kind: 'keyChanged' }
  else if (refused !== null) {
    cause =
      refused.update === 'client'
        ? { kind: 'newer', host: refused.host, ours: refused.client, by: 'protocol' }
        : { kind: 'tooOld', host: refused.host, ours: refused.client }
  }
  return { kind: 'failed', lastLine, ...(cause !== undefined ? { cause } : {}) }
}

export function createRemoteHostAdder(deps: RemoteHostAdderDeps): RemoteHostAdder {
  const attempts = new Map<string, AbortController>()
  const newId = deps.newId ?? randomUUID

  const begin = (attempt: string): AbortController => {
    attempts.get(attempt)?.abort()
    const controller = new AbortController()
    attempts.set(attempt, controller)
    return controller
  }
  const end = (attempt: string, controller: AbortController): void => {
    if (attempts.get(attempt) === controller) attempts.delete(attempt)
  }

  return {
    async during(attempt, run) {
      const controller = begin(attempt)
      try {
        return await run(controller.signal)
      } finally {
        end(attempt, controller)
      }
    },

    cancel(attempt) {
      attempts.get(attempt)?.abort()
      attempts.delete(attempt)
    },

    async add(request, keep) {
      const host: RemoteHost = {
        id: newId(),
        name: request.name,
        transport: request.transport,
        ...(request.floti !== undefined ? { floti: request.floti } : {}),
        ...(request.system !== undefined ? { system: request.system } : {})
      }
      const problem = remoteHostsProblem([...deps.hosts(), host])
      if (problem !== null) throw new Error(problem)
      const controller = begin(request.attempt)
      const { signal } = controller
      /** Nothing of it is left: the connection stopped and its folder, with any key it pinned, removed. */
      const leaveNothing = async (connected: LocalHost | null): Promise<void> => {
        await connected?.close()
        await deps.forget(host).catch((error: unknown) => {
          deps.log(`host: the folder of ${host.name}, not added, was not removed (${(error as Error).message})`)
        })
      }
      try {
        let connected: LocalHost
        try {
          connected = await deps.connect(host, signal)
        } catch (error) {
          await leaveNothing(null)
          return signal.aborted ? { kind: 'cancelled' } : failure(error)
        }
        const version = connected.connection.welcome.hostVersion
        let agents: Record<string, AgentStatus | undefined> | null = null
        let agentsError: string | undefined
        try {
          const status = await connected.connection.request('setup:status', null)
          agents = status.backends as Record<string, AgentStatus | undefined>
        } catch (error) {
          agentsError = (error as Error).message
        }
        if (signal.aborted) {
          await leaveNothing(connected)
          return { kind: 'cancelled' }
        }
        keep(host, connected)
        deps.log(`host: added ${host.name}, floti ${version}, its key pinned`)
        return { kind: 'added', host, version, agents, ...(agentsError !== undefined ? { agentsError } : {}) }
      } finally {
        end(request.attempt, controller)
      }
    }
  }
}
