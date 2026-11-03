import { createHash } from 'node:crypto'
import type { HostTransport } from '@helm/core/types'
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
 */

/** The start of the line the bridge writes while it waits for approval (`PAIRING_LINE_PREFIX` in bridge.rs). */
export const PAIRING_LINE_PREFIX = 'floti bridge: pairing code '

/** A remote host could not be reached; `lastLine` is what the bridge, ssh or the command said, unedited. */
export class RemoteHostError extends Error {
  override name = 'RemoteHostError'

  constructor(readonly lastLine: string) {
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

/** `floti bridge`'s arguments for a remote host; `pairAs` asks to pair under that name while nothing is pinned. */
export function remoteBridgeArgs(folder: string, transport: HostTransport, pairAs: string | null): string[] {
  return ['bridge', folder, ...(pairAs === null ? [] : ['--pair', pairAs]), '--', ...transportArgv(transport)]
}

/** What a remote host's bridge needs from the launcher's world. */
export type RemoteLauncherDeps = Pick<LauncherDeps, 'platform' | 'env' | 'exists' | 'spawn' | 'appVersion' | 'log'>

export interface RemoteTarget {
  /** The host's own client folder on this device (`remoteClientFolder`). */
  folder: string
  transport: HostTransport
}

interface StandardError {
  /** The last line that was not the pairing line, or null. */
  last(): string | null
  /** Settles once the pipe has ended. */
  readonly ended: Promise<void>
}

/** Reads the bridge's standard error line by line: a pairing line goes to `onPairing` only, never kept or logged. */
function readStandardError(child: HostChild, onPairing: (code: string) => void): StandardError {
  const stderr = child.stderr
  let last: string | null = null
  if (stderr === null) return { last: () => null, ended: Promise.resolve() }
  let pending = ''
  const take = (raw: string): void => {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') return
    const code = pairingCodeOf(line)
    if (code !== null) onPairing(code)
    else last = line
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
  pairAs: string | null
): { binary: string; child: HostChild } | { binary: string; missing: true } {
  const binary = flotiBinary(places, deps)
  if (!deps.exists(binary)) return { binary, missing: true }
  // The user's own environment, as it is: their ssh finds their config, keys
  // and agent the way it does in their terminal.
  const child = deps.spawn(binary, remoteBridgeArgs(target.folder, target.transport, pairAs), {
    env: deps.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return { binary, child }
}

/**
 * Main's own connection to a remote host. Pairs under `deviceName` while
 * nothing is pinned, telling `onPairing` each code to approve there. Rejects
 * with a `RemoteHostError` whose line is the one to show.
 */
export async function startRemoteHost(
  places: HostPlaces,
  deps: RemoteLauncherDeps,
  target: RemoteTarget & { deviceName: string; onPairing: (code: string) => void }
): Promise<LocalHost> {
  const spawned = spawnBridge(places, deps, target, target.deviceName)
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
      throw new RemoteHostError(`${clause(error.message)}.`)
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
