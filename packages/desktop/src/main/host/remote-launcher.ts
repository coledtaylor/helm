import { createHash } from 'node:crypto'
import { formatProtocol, type HostTransport } from '@helm/core/types'
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
 * `floti bridge <the host's client folder> -- <transport>...` runs the
 * transport without a shell, adds `floti connect` as its one last argument,
 * and runs the Noise handshake over it, holding the host to the key this
 * device pinned for it (`crates/host/src/bridge.rs`). The transport is the
 * user's own `ssh -o BatchMode=yes <target>`, with the target exactly as
 * typed, or the user's own command as they gave it.
 *
 * - The user's login is the access. A host reached through it serves this
 *   device in full once the handshake completes: nothing is approved, typed
 *   or shown, and nothing runs there but `floti connect`.
 * - Adding a host is connecting to it. While this device has pinned no key
 *   for the host, the bridge learns it through the same transport
 *   (`floti connect --host-key`), holds the host to it and pins it once the
 *   host has proven it. From then on a host that proves another key is
 *   refused (`BRIDGE_EXIT.hostNotProven`) and said to have changed its key,
 *   until the user removes it, which forgets the pin, and adds it again.
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
 */

/**
 * A remote host could not be reached; `lastLine` is what the bridge, ssh or
 * the command said, unedited. `refused` holds the versions when the host
 * refused this device's hello (P6), and which side to update. `keyChanged`
 * says the host proved another key than the one this device pinned for it.
 */
export class RemoteHostError extends Error {
  override name = 'RemoteHostError'

  constructor(
    readonly lastLine: string,
    readonly refused: {
      host: string
      client: string
      update: 'host' | 'client'
    } | null = null,
    readonly keyChanged = false
  ) {
    super(lastLine)
  }
}

/** Said for a host that proved another key than the one pinned, when the bridge wrote nothing itself. */
export const KEY_CHANGED_LINE =
  'The host proved another key than the one this PC pinned for it, so Helm did not connect.'

/**
 * The folder a remote host's device key and pinned host key live in, inside
 * Helm's data directory: one per host, named from its id so no id can reach
 * outside it. This PC's host keeps its own (`clientFolder`).
 */
export function remoteClientFolder(places: Pick<HostPlaces, 'dataDir'>, platform: NodeJS.Platform, id: string): string {
  const name = createHash('sha256').update(id).digest('hex').slice(0, 16)
  return pathsFor(platform).join(places.dataDir, 'remote-hosts', name)
}

/**
 * This PC's `wsl.exe`: the one in Windows' System32, never one found on
 * `PATH`. A test passes its own program in its place (`RemoteLauncherDeps.wsl`),
 * the fake in test/fake-ssh/wsl.mjs, so no test runs the real one.
 */
export function systemWsl(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  return [`${root.replace(/[\\/]+$/, '')}\\System32\\wsl.exe`]
}

/**
 * The program and arguments that carry the bytes: ssh in batch mode with the
 * target as typed, the command as given, this PC's `wsl` (`wsl.exe` and any
 * arguments before its own) with `-d <distro> --`, or ssh to the Windows PC a
 * distro is on with that PC's `wsl.exe -d <distro> --`, which Windows'
 * OpenSSH runs in `cmd`. The line to run there goes after it.
 */
export function transportArgv(transport: HostTransport, programs: TransportPrograms = {}): string[] {
  const ssh = programs.ssh ?? ['ssh']
  switch (transport.kind) {
    case 'ssh':
      return [...ssh, '-o', 'BatchMode=yes', transport.target]
    case 'command':
      return [transport.program, ...transport.args]
    case 'wsl':
      return transport.through === undefined
        ? [...(programs.wsl ?? ['wsl.exe']), '-d', transport.distro, '--']
        : [...ssh, '-o', 'BatchMode=yes', transport.through, 'wsl.exe', '-d', transport.distro, '--']
  }
}

/**
 * The programs, each with any arguments before its own, that run this PC's
 * `ssh` and `wsl.exe`: `ssh` on `PATH` and System32's `wsl.exe` in Helm. A test
 * passes the fakes in test/fake-ssh, so none runs the real ones.
 */
export interface TransportPrograms {
  ssh?: readonly string[] | undefined
  wsl?: readonly string[] | undefined
}

/**
 * Whether the line to run there goes on the transport's command line as
 * written rather than quoted as one argument: for this PC's `wsl.exe`, which
 * hands the rest of its command line after `--` to the distro's shell as it
 * appears ("Pass the remaining command line as is"). Through ssh the line is
 * one argument, which ssh sends as it is and the PC's `cmd` hands to its
 * `wsl.exe` unquoted.
 */
export function runsAsWritten(transport: HostTransport): boolean {
  return transport.kind === 'wsl' && transport.through === undefined
}

/**
 * `floti bridge`'s arguments for a remote host. `floti` is the full path of
 * the floti Helm installed there, which every line run there starts with, for
 * a login whose `PATH` does not have it. A distro on this PC gets
 * `--as-written`, so the bridge appends the line to `wsl.exe`'s command line
 * as written and runs it with `WSL_UTF8=1`.
 */
export function remoteBridgeArgs(
  folder: string,
  transport: HostTransport,
  floti?: string,
  programs: TransportPrograms = {}
): string[] {
  const path = floti === undefined ? [] : ['--floti', floti]
  const written = runsAsWritten(transport) ? ['--as-written'] : []
  return ['bridge', folder, ...path, ...written, '--', ...transportArgv(transport, programs)]
}

/**
 * What a remote host's bridge needs from the launcher's world. `programs`
 * runs this PC's ssh and `wsl.exe`: `ssh` and System32's (`systemWsl`) when
 * absent.
 */
export type RemoteLauncherDeps = Pick<LauncherDeps, 'platform' | 'env' | 'exists' | 'spawn' | 'appVersion' | 'log'> & {
  programs?: TransportPrograms | undefined
}

export interface RemoteTarget {
  /** The host's own client folder on this device (`remoteClientFolder`). */
  folder: string
  transport: HostTransport
  /** The full path of floti there, when Helm installed it (`RemoteHost.floti`). */
  floti?: string | undefined
}

interface StandardError {
  /** The last line it wrote, or null. */
  last(): string | null
  /** Settles once the pipe has ended. */
  readonly ended: Promise<void>
}

/** Reads the bridge's standard error line by line, keeping the last line, which says why it ended. */
function readStandardError(child: HostChild): StandardError {
  const stderr = child.stderr
  let last: string | null = null
  if (stderr === null) return { last: () => null, ended: Promise.resolve() }
  let pending = ''
  const take = (raw: string): void => {
    const line = raw.replace(/\r$/, '')
    if (line.trim() !== '') last = line
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
  if (exit.code === BRIDGE_EXIT.hostNotProven) return new RemoteHostError(lastLine ?? KEY_CHANGED_LINE, null, true)
  if (lastLine !== null) return new RemoteHostError(lastLine)
  if (exit.code === BRIDGE_EXIT.transportEnded)
    return new RemoteHostError('The connection ended before the host answered.')
  return new RemoteHostError(
    exit.code === null
      ? `floti bridge was stopped by ${exit.signal ?? 'a signal'}.`
      : `floti bridge exited with status ${String(exit.code)}.`
  )
}

function spawnBridge(
  places: HostPlaces,
  deps: Omit<RemoteLauncherDeps, 'appVersion' | 'log'>,
  target: RemoteTarget
): { binary: string; child: HostChild } | { binary: string; missing: true } {
  const binary = flotiBinary(places, deps)
  if (!deps.exists(binary)) return { binary, missing: true }
  // The user's own environment, as it is: their ssh finds their config, keys
  // and agent the way it does in their terminal.
  const args = remoteBridgeArgs(target.folder, target.transport, target.floti, {
    ...deps.programs,
    wsl: deps.programs?.wsl ?? systemWsl(deps.env)
  })
  const child = deps.spawn(binary, args, {
    env: deps.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  return { binary, child }
}

/** Said for a first connection the user stopped before it connected. */
export const STOPPED_LINE = 'Stopped before it connected.'

/**
 * Main's own connection to a remote host, which pins the host's key at the
 * first connection; its `hello` names this device `deviceName`. Rejects with
 * a `RemoteHostError` whose line is the one to show.
 *
 * `signal` stops a connection that has not connected yet: the bridge this
 * started ends, and it rejects. Once connected, the signal stops nothing.
 */
export async function startRemoteHost(
  places: HostPlaces,
  deps: RemoteLauncherDeps,
  target: RemoteTarget & { deviceName: string; signal?: AbortSignal | undefined }
): Promise<LocalHost> {
  const stopped = (): boolean => target.signal?.aborted === true
  if (stopped()) throw new RemoteHostError(STOPPED_LINE)
  const spawned = spawnBridge(places, deps, target)
  if ('missing' in spawned) throw new RemoteHostError(`Helm could not find floti at ${spawned.binary}.`)
  const { binary, child } = spawned
  const exited = exitOf(child)
  const said = readStandardError(child)
  // The bridge this started, by its own process: nothing else is stopped.
  const stop = (): void => {
    closeInput(child)
    child.kill()
  }
  target.signal?.addEventListener('abort', stop, { once: true })
  try {
    return await connectRemote(deps, target, child, exited, said, binary)
  } catch (error) {
    if (stopped()) throw new RemoteHostError(STOPPED_LINE)
    throw error
  } finally {
    target.signal?.removeEventListener('abort', stop)
  }
}

async function connectRemote(
  deps: RemoteLauncherDeps,
  target: RemoteTarget & { deviceName: string },
  child: HostChild,
  exited: Promise<Exit>,
  said: StandardError,
  binary: string
): Promise<LocalHost> {
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
      deviceName: target.deviceName,
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
          : {
              host: formatProtocol(refused.host),
              client: formatProtocol(refused.client),
              update: refused.update
            }
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
 * of its own through the same transport and the same client folder, so it
 * holds the host to the key main's link pinned, whose frames main pipes to
 * the page unread.
 */
export function openRemotePageBridge(
  places: HostPlaces,
  deps: Omit<RemoteLauncherDeps, 'appVersion' | 'log'>,
  target: RemoteTarget,
  data: (bytes: Uint8Array) => void
): PageBridge {
  const spawned = spawnBridge(places, deps, target)
  if ('missing' in spawned) {
    const missing = `Helm could not find floti at ${spawned.binary}.`
    return {
      write: () => undefined,
      end: () => undefined,
      ended: Promise.resolve(missing)
    }
  }
  const { binary, child } = spawned
  const exited = exitOf(child)
  const said = readStandardError(child)
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
