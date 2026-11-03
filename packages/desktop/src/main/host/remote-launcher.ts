import { createHash } from 'node:crypto'
import { formatProtocol, type HostTransport, type PairingRole } from '@helm/core/types'
import { HostRefusedError, connectHost, type HostConnection } from './client'
import {
  BRIDGE_EXIT,
  clause,
  closeInput,
  describeExit,
  exitOf,
  flotiBinary,
  pathsFor,
  type Exit,
  type HostChild,
  type HostPlaces,
  type LauncherDeps,
  type LocalHost,
  type PageBridge
} from './launcher'

/**
 * Reaches a host on another computer, through the `floti` program:
 *
 * `floti bridge <the host's client folder> [--pair <this device's name>] --
 * <transport>...` runs the transport without a shell, adds `floti connect` as
 * its one last argument, and runs the Noise handshake over it, holding the
 * host to the key this device pinned for it (`crates/host/src/bridge.rs`).
 * The transport is the user's own `ssh -o BatchMode=yes <target>`, with the
 * target exactly as typed, or the user's own command as they gave it.
 *
 * - Batch mode, and no other option: ssh never waits on a prompt, Helm types
 *   nothing into it (the bridge writes only protocol frames on its input),
 *   and nothing is added that would skip a host-key check. When ssh needs a
 *   person - a password, a passphrase, a host key to accept - it fails, and
 *   the last line it wrote is shown unedited, with the fix.
 * - Nothing under `~/.ssh` is read or written by Helm, and no ssh key,
 *   password or passphrase is held: each host's client folder holds this
 *   device's key for it and the host key it pinned, which the bridge reads.
 * - A host is never started from here: with none running there, the bridge
 *   says so (`floti connect`'s line) and the link tries again later.
 * - While this device is not paired, the bridge asks to pair and writes one
 *   line with the code to approve there (`PAIRING_LINE_PREFIX`). The code
 *   goes to the window, on this device, and nowhere else: it is never logged.
 * - Given the role chosen when the host was added (`--approve`), the bridge
 *   approves this device itself, through the same transport, with the code
 *   on that command's standard input. When that fails it writes the
 *   command's last line, unedited, then the code line again, and waits for
 *   someone to approve by hand: the window shows both.
 */

/** The start of the line the bridge writes while it waits for approval (`PAIRING_LINE_PREFIX` in bridge.rs). */
export const PAIRING_LINE_PREFIX = 'floti bridge: pairing code '

/**
 * A remote host could not be reached; `lastLine` is what the bridge, ssh or
 * the command said, unedited. `refused` holds the versions when the host
 * refused this device's hello (P6), and which side to update.
 */
export class RemoteHostError extends Error {
  override name = 'RemoteHostError'

  constructor(
    readonly lastLine: string,
    readonly refused: { host: string; client: string; update: 'host' | 'client' } | null = null
  ) {
    super(lastLine)
  }
}

/** The code in the bridge's pairing line, or null for any other line. */
export function pairingCodeOf(line: string): string | null {
  if (!line.startsWith(PAIRING_LINE_PREFIX)) return null
  const code = (line.slice(PAIRING_LINE_PREFIX.length).split(',')[0] ?? '').trim()
  return code === '' ? null : code
}

/**
 * The folder a remote host's device key and pinned host key live in, inside
 * Helm's data directory: one per host, named from its id so no id can reach
 * outside it. This PC's host keeps its own (`clientFolder`).
 */
export function remoteClientFolder(
  places: Pick<HostPlaces, 'dataDir'>,
  platform: NodeJS.Platform,
  id: string
): string {
  const name = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return pathsFor(platform).join(places.dataDir, 'remote-hosts', name)
}

/** The program and arguments that carry the bytes: ssh in batch mode with the target as typed, or the command as given. */
export function transportArgv(transport: HostTransport): string[] {
  return transport.kind === 'ssh'
    ? ['ssh', '-o', 'BatchMode=yes', transport.target]
    : [transport.program, ...transport.args]
}

/**
 * `floti bridge`'s arguments for a remote host. `pairAs` asks to pair under
 * that name while nothing is pinned, and `approve` approves it with that role
 * in the same step, through the same transport. `floti` is the full path of
 * the floti Helm installed there, which every line run there starts with, for
 * a login whose `PATH` does not have it.
 */
export function remoteBridgeArgs(
  folder: string,
  transport: HostTransport,
  pairAs: string | null,
  approve: PairingRole | null = null,
  floti?: string
): string[] {
  const pairing = pairAs === null ? [] : ['--pair', pairAs, ...(approve === null ? [] : ['--approve', approve])]
  const path = floti === undefined ? [] : ['--floti', floti]
  return ['bridge', folder, ...pairing, ...path, '--', ...transportArgv(transport)]
}

/** Told each code to approve there; `approvalFailed` is the line the failed approval wrote, when one did. */
export type OnPairing = (code: string, approvalFailed: string | null) => void

/** What a remote host's bridge needs from the launcher's world. */
export type RemoteLauncherDeps = Pick<LauncherDeps, 'platform' | 'env' | 'exists' | 'spawn' | 'appVersion' | 'log'>

export interface RemoteTarget {
  /** The host's own client folder on this device (`remoteClientFolder`). */
  folder: string
  transport: HostTransport
  /** The full path of floti there, when Helm installed it (`RemoteHost.floti`). */
  floti?: string | undefined
}

interface StandardError {
  /** The last line that was not the pairing line, or null. */
  last(): string | null
  /** Settles once the pipe has ended. */
  readonly ended: Promise<void>
}

/**
 * Reads the bridge's standard error line by line: a pairing line goes to
 * `onPairing` only, never kept or logged. A line between two pairing lines is
 * the one-step approval's failure, which comes with the second.
 */
function readStandardError(child: HostChild, onPairing: OnPairing): StandardError {
  const stderr = child.stderr
  let last: string | null = null
  if (stderr === null) return { last: () => null, ended: Promise.resolve() }
  let pending = ''
  let shown = false
  let sinceCode: string | null = null
  const take = (raw: string): void => {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') return
    const code = pairingCodeOf(line)
    if (code === null) {
      last = line
      sinceCode = line
      return
    }
    onPairing(code, shown ? sinceCode : null)
    shown = true
    sinceCode = null
  }
  stderr.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString()
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      take(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  stderr.on('error', () => undefined)
  const ended = new Promise<void>((resolve) => {
    const done = (): void => {
      if (pending !== '') take(pending)
      pending = ''
      resolve()
    }
    stderr.once('end', done)
    stderr.once('close', done)
  })
  return { last: () => last, ended }
}

/** What to show for a bridge that ended without connecting: its last line, unedited, or what its exit says. */
function remoteFailure(exit: Exit, lastLine: string | null, binary: string): RemoteHostError {
  if (exit.error !== undefined) {
    const code = (exit.error as NodeJS.ErrnoException).code
    return new RemoteHostError(`Helm could not run floti at ${binary} (${code ?? exit.error.message}).`)
  }
  if (lastLine !== null) return new RemoteHostError(lastLine)
  if (exit.code === BRIDGE_EXIT.transportEnded) return new RemoteHostError('The connection ended before the host answered.')
  return new RemoteHostError(
    exit.code === null
      ? `floti bridge was stopped by ${exit.signal ?? 'a signal'}.`
      : `floti bridge exited with status ${String(exit.code)}.`
  )
}

function spawnBridge(
  places: HostPlaces,
  deps: Omit<RemoteLauncherDeps, 'appVersion' | 'log'>,
  target: RemoteTarget,
  pairAs: string | null,
  approve: PairingRole | null = null
): { binary: string; child: HostChild } | { binary: string; missing: true } {
  const binary = flotiBinary(places, deps)
  if (!deps.exists(binary)) return { binary, missing: true }
  // The user's own environment, as it is: their ssh finds their config, keys
  // and agent the way it does in their terminal.
  const args = remoteBridgeArgs(target.folder, target.transport, pairAs, approve, target.floti)
  const child = deps.spawn(binary, args, {
    env: deps.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return { binary, child }
}

/**
 * Main's own connection to a remote host. Pairs under `deviceName` while
 * nothing is pinned, approving itself with `approve` when one is given, and
 * telling `onPairing` each code to approve there. Rejects with a
 * `RemoteHostError` whose line is the one to show.
 */
export async function startRemoteHost(
  places: HostPlaces,
  deps: RemoteLauncherDeps,
  target: RemoteTarget & { deviceName: string; approve: PairingRole | null; onPairing: OnPairing }
): Promise<LocalHost> {
  const spawned = spawnBridge(places, deps, target, target.deviceName, target.approve)
  if ('missing' in spawned) throw new RemoteHostError(`Helm could not find floti at ${spawned.binary}.`)
  const { binary, child } = spawned
  const exited = exitOf(child)
  const said = readStandardError(child, target.onPairing)
  const failed = async (): Promise<never> => {
    closeInput(child)
    const exit = await exited
    await said.ended
    throw remoteFailure(exit, said.last(), binary)
  }
  if (child.stdout === null || child.stdin === null) return failed()
  let connection: HostConnection
  try {
    connection = await connectHost({
      transport: { input: child.stdout, output: child.stdin },
      appVersion: deps.appVersion,
      log: deps.log
    })
  } catch (error) {
    if (error instanceof HostRefusedError) {
      closeInput(child)
      await exited
      const { refused } = error
      throw new RemoteHostError(
        `${clause(error.message)}.`,
        refused === null
          ? null
          : { host: formatProtocol(refused.host), client: formatProtocol(refused.client), update: refused.update }
      )
    }
    return failed()
  }
  void exited.then((exit) => deps.log(`host: a remote host's floti bridge ended (${describeExit(exit)})`))
  let closing: Promise<void> | null = null
  return {
    connection,
    startedHost: false,
    close: () => {
      closing ??= (async () => {
        connection.close()
        closeInput(child)
        await exited
      })()
      return closing
    }
  }
}

/**
 * A window's own connection to a remote host main is connected to: a bridge
 * of its own through the same transport, never pairing (main's link paired
 * first), whose frames main pipes to the page unread.
 */
export function openRemotePageBridge(
  places: HostPlaces,
  deps: Omit<RemoteLauncherDeps, 'appVersion' | 'log'>,
  target: RemoteTarget,
  data: (bytes: Uint8Array) => void
): PageBridge {
  const spawned = spawnBridge(places, deps, target, null)
  if ('missing' in spawned) {
    const missing = `Helm could not find floti at ${spawned.binary}.`
    return { write: () => undefined, end: () => undefined, ended: Promise.resolve(missing) }
  }
  const { binary, child } = spawned
  const exited = exitOf(child)
  const said = readStandardError(child, () => undefined)
  child.stdout?.on('data', (chunk: Uint8Array) =>
    data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  )
  const stdin = child.stdin
  const open = (): boolean => stdin !== null && !stdin.writableEnded && !stdin.destroyed
  stdin?.on('error', () => undefined)
  return {
    write: (bytes) => {
      if (open()) stdin?.write(bytes)
    },
    end: () => closeInput(child),
    ended: exited.then(async (exit) => {
      if (exit.error === undefined && exit.code === BRIDGE_EXIT.closed) return null
      await said.ended
      return remoteFailure(exit, said.last(), binary).message
    })
  }
}
