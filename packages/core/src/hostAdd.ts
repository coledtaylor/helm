/**
 * Adding a host on another computer is connecting to it.
 *
 * The add-a-host dialog checks the computer first (`remoteHosts:check`) and
 * installs floti there after a yes, then asks main to add the host
 * (`remoteHosts:add`). Main mints the host's id and makes its first
 * connection, in that host's own client folder, through the user's own ssh
 * or command; the handshake pins the host's key. Only once it connected does
 * main write the host into this device's hosts setting, keeping that
 * connection for the host's link. A failure or a cancel before then stops the
 * connection, removes the folder and writes nothing.
 *
 * The user's login is the access: nothing is approved, typed or copied on the
 * host, and no pairing code, approval or role is asked, shown or kept. The
 * key pinned is all that is kept of the handshake.
 */

import type { HostFailureCause } from './hostFailure'
import type { AgentStatus } from './hostAgents'
import type { HostSystem, HostTransport, RemoteHost } from './hosts'

/** What the dialog asks main to add, once the check said floti there can talk to this Helm. */
export interface HostAddRequest {
  /** The attempt the dialog minted at Connect, which `remoteHosts:cancelAdd` stops. */
  attempt: string
  name: string
  transport: HostTransport
  /** The full path of the floti Helm installed there, when it did. */
  floti?: string | undefined
  /** That computer's OS and CPU, as the check or the install found them. */
  system?: HostSystem | undefined
}

/**
 * How adding a host ended.
 *
 * - `added`: it connected, its key is pinned, and it is in this device's
 *   hosts. `version` is the floti version its welcome named, and `agents`
 *   what its `setup:status` said of each agent there, or null with `agentsError`
 *   when it could not say.
 * - `failed`: nothing was added, and nothing of it is left in Helm's data.
 *   `lastLine` is the last line ssh, the command or floti wrote, unedited.
 * - `cancelled`: the user stopped it; nothing was added or left.
 */
export type HostAddOutcome =
  | {
      kind: 'added'
      host: RemoteHost
      version: string
      agents: Readonly<Record<string, AgentStatus | undefined>> | null
      agentsError?: string
    }
  | { kind: 'failed'; lastLine: string; cause?: HostFailureCause }
  | { kind: 'cancelled' }
