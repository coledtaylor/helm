import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { TURN_OFF } from '../../shared/host/sentences'
import type { AppMode } from '../../shared/ipc'
import { HostRefusedError, connectHost, type HostConnection } from './client'

/**
 * Finds the local host and connects the desktop to it, through the `floti`
 * program:
 *
 * - `floti bridge <client folder>` runs the client's half of the Noise
 *   handshake from the keys in Helm's client folder, enrolling as the first
 *   admin with the one-time code the host wrote when it has pinned no host,
 *   then carries protocol frames on its standard input and output. Its exit
 *   status says why it ended (`BRIDGE_EXIT`).
 * - `floti host --until-stdin-closes` is the host, started by Helm when no
 *   host answered, and stopped by Helm closing its standard input, which it
 *   holds open for as long as it wants the host: if Helm's main process dies
 *   outright, the pipe closes and the host goes with it.
 *
 * Helm never opens the enrolment file or a key: the bridge reads them, and
 * says what went wrong as an exit status. Nothing either program prints is
 * logged or shown, so no code or key can reach Helm's log through here.
 *
 * Everything that differs by OS for this (the program's name, how paths
 * join, and where the socket can live) is in this module and nowhere else.
 */

/** `floti bridge`'s exit statuses (`crates/host/src/bridge.rs`). */
export const BRIDGE_EXIT = {
  closed: 0,
  failed: 1,
  usage: 2,
  unreachable: 3,
  notPinned: 4,
  hostNotProven: 5,
  hostClosed: 6
} as const

/** The line `floti host` prints once it listens, the first on its standard output. */
const LISTENING = /^Floti host is listening at (.+)\.$/

/** How long a host Helm started has to say it is listening. */
export const HOST_START_DEADLINE_MS = 30_000

/**
 * The longest socket path macOS takes, in bytes (`sun_path` is 104 with its
 * terminating NUL); Linux takes 107, so this holds on both.
 */
export const SOCKET_PATH_MAX = 103

/** Where this Helm keeps its data and finds its programs. */
export interface HostPlaces {
  appMode: AppMode
  /** Helm's data directory (`paths.ts`). */
  dataDir: string
  /** `app.isPackaged`. */
  packaged: boolean
  /** `process.resourcesPath`: where a packaged build carries `floti`. */
  resourcesPath: string
  /** The checkout an unpackaged build runs from, whose `target/debug` holds `floti`. */
  repoRoot: string
  /**
   * Helm's templates folder (`paths.ts`). The host keeps its templates in
   * `templates` inside its config folder, so the folder holding this one is
   * the host's config folder in every run: one templates folder, whichever of
   * the two serves it.
   */
  templatesDir: string
}

/** A child process, as much of one as this needs; `child_process.spawn` returns one. */
export interface HostChild {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export interface SpawnOptions {
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: true
}

export interface LauncherDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** `os.tmpdir()`: where a socket goes when the data directory is too deep for one. */
  tmpdir: () => string
  exists: (path: string) => boolean
  spawn: (command: string, args: string[], options: SpawnOptions) => HostChild
  appVersion: string
  log: (line: string) => void
  setTimeout: (run: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

/** A connection to the local host, and the host itself when Helm started it. */
export interface LocalHost {
  readonly connection: HostConnection
  /** Whether Helm started the host, rather than finding one running. */
  readonly startedHost: boolean
  /** Closes the connection, then stops the host if Helm started it; resolves once both have exited. */
  stop(): Promise<void>
}

/** Why the desktop could not reach the local host, as one sentence that says the setting can be turned off. */
export class LocalHostError extends Error {
  override name = 'LocalHostError'
}

function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/** Where `floti` is looked for: beside a packaged build's resources, or in the checkout's debug build. */
export function flotiBinary(places: HostPlaces, deps: Pick<LauncherDeps, 'platform' | 'env'>): string {
  const paths = pathsFor(deps.platform)
  const name = deps.platform === 'win32' ? 'floti.exe' : 'floti'
  if (places.packaged) return paths.join(places.resourcesPath, name)
  const target = deps.env['CARGO_TARGET_DIR'] || paths.join(places.repoRoot, 'target')
  return paths.join(target, 'debug', name)
}

/** The folder Helm's device key and pinned host key live in. */
export function clientFolder(places: HostPlaces, platform: NodeJS.Platform): string {
  return pathsFor(platform).join(places.dataDir, 'host-client')
}

/**
 * The environment both programs run with. The installed app uses the host's
 * own folders, so it passes its environment as it is; every other run moves
 * the host's folders inside Helm's data directory, so a dev or check run never
 * meets the user's real host. The config folder is the one exception, in every
 * run: it is the folder holding Helm's templates folder, which is all the
 * host keeps there.
 *
 * A build that is not packaged carries no Node beside `floti`, so it hands the
 * host the `node` on PATH (`FLOTI_NODE`, an absolute path) for plugin
 * services: `pnpm dev` and the checks run them on it. A packaged build passes
 * none, and the host uses the Node shipped beside it. A `FLOTI_NODE` already
 * in the environment is kept.
 */
export function hostEnvironment(
  places: HostPlaces,
  deps: Pick<LauncherDeps, 'platform' | 'env' | 'tmpdir'> & Partial<Pick<LauncherDeps, 'exists'>>
): NodeJS.ProcessEnv {
  const paths = pathsFor(deps.platform)
  const config = paths.dirname(places.templatesDir)
  const node = places.packaged || deps.env['FLOTI_NODE'] !== undefined ? null : nodeOnPath(deps)
  const env = node === null ? deps.env : { ...deps.env, FLOTI_NODE: node }
  if (places.appMode === 'installed') return { ...env, FLOTI_CONFIG_DIR: config }
  const root = paths.join(places.dataDir, 'host')
  return {
    ...env,
    FLOTI_DATA_DIR: paths.join(root, 'data'),
    FLOTI_LOG_DIR: paths.join(root, 'logs'),
    FLOTI_CONFIG_DIR: config,
    FLOTI_RUNTIME_DIR: runtimeFolder(places.dataDir, deps)
  }
}

/** The absolute path of the first `node` on PATH, or null when there is none (or nothing to look with). */
export function nodeOnPath(deps: Pick<LauncherDeps, 'platform' | 'env'> & Partial<Pick<LauncherDeps, 'exists'>>): string | null {
  const { exists } = deps
  if (exists === undefined) return null
  const paths = pathsFor(deps.platform)
  // Windows spells the variable however it likes; the first spelling found wins.
  const key = Object.keys(deps.env).find((name) => name.toUpperCase() === 'PATH')
  const list = key === undefined ? '' : (deps.env[key] ?? '')
  const name = deps.platform === 'win32' ? 'node.exe' : 'node'
  for (const folder of list.split(deps.platform === 'win32' ? ';' : ':')) {
    const dir = folder.trim().replace(/^"(.*)"$/, '$1')
    if (dir === '' || !paths.isAbsolute(dir)) continue
    const candidate = paths.join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * The folder the host's socket goes in. Inside Helm's data directory when the
 * socket's path fits macOS's and Linux's limit there; otherwise a folder of its
 * own, named from the data directory, in the user's runtime folder or temp
 * folder, which on both is the user's own. Windows names a pipe from the
 * folder instead, so any folder does.
 */
function runtimeFolder(dataDir: string, deps: Pick<LauncherDeps, 'platform' | 'env' | 'tmpdir'>): string {
  const paths = pathsFor(deps.platform)
  const inside = paths.join(dataDir, 'host', 'run')
  if (deps.platform === 'win32') return inside
  if (Buffer.byteLength(paths.join(inside, 'floti.sock')) <= SOCKET_PATH_MAX) return inside
  const runtime = deps.env['XDG_RUNTIME_DIR']
  const base = runtime !== undefined && paths.isAbsolute(runtime) ? runtime : deps.tmpdir()
  const name = `helm-floti-${createHash('sha256').update(dataDir).digest('hex').slice(0, 16)}`
  return paths.join(base, name)
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when the program could not be run at all. */
  error?: Error
}

/** Settles when `child` has exited or could not be started. */
function exitOf(child: HostChild): Promise<Exit> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', (error) => resolve({ code: null, signal: null, error }))
  })
}

function failure(sentence: string): LocalHostError {
  return new LocalHostError(`${sentence}; ${TURN_OFF}`)
}

/** The sentence for a bridge that ended without connecting. */
function bridgeFailure(exit: Exit, binary: string, hostStarted: boolean): LocalHostError {
  if (exit.error !== undefined) return couldNotRun(binary, exit.error)
  switch (exit.code) {
    case BRIDGE_EXIT.unreachable:
      return failure(
        hostStarted
          ? 'The local host Helm started did not answer on its socket'
          : 'No local host answered on its socket'
      )
    case BRIDGE_EXIT.notPinned:
      return failure(
        'Helm is not paired with the local host, and the host offered no one-time code for it to enrol with'
      )
    case BRIDGE_EXIT.hostNotProven:
      return failure('The local host did not prove the key Helm expected, so Helm did not connect to it')
    case BRIDGE_EXIT.hostClosed:
      return failure('The local host closed the connection')
    default:
      return failure(
        exit.code === null
          ? `The connection to the local host ended when floti bridge was stopped by ${exit.signal ?? 'a signal'}`
          : `The connection to the local host failed: floti bridge exited with status ${exit.code}`
      )
  }
}

function couldNotRun(binary: string, error: Error): LocalHostError {
  const code = (error as NodeJS.ErrnoException).code
  return failure(`Helm could not run the local host program at ${binary} (${code ?? error.message})`)
}

/** Ends a sentence's full stop, so a clause can follow it. */
function clause(sentence: string): string {
  return sentence.trim().replace(/\.$/, '')
}

/** Closes a child's standard input, which ends the bridge's connection or stops the host. */
function closeInput(child: HostChild): void {
  if (child.stdin !== null && !child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end()
}

type BridgeAttempt = { connection: HostConnection; exited: Promise<Exit>; child: HostChild } | { exit: Exit }

/**
 * Connects to the local host, starting it when none answers. Rejects with a
 * `LocalHostError` whose message is the one sentence to show.
 */
export async function startLocalHost(places: HostPlaces, deps: LauncherDeps): Promise<LocalHost> {
  const binary = flotiBinary(places, deps)
  if (!deps.exists(binary)) {
    throw failure(`Helm could not find the local host program at ${binary}`)
  }
  const env = hostEnvironment(places, deps)
  const folder = clientFolder(places, deps.platform)
  const options: SpawnOptions = {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  }

  const bridge = async (): Promise<BridgeAttempt> => {
    const child = deps.spawn(binary, ['bridge', folder], options)
    const exited = exitOf(child)
    // Its one line on standard error says why it failed; the exit status says
    // the same, and nothing it prints is logged.
    child.stderr?.resume()
    if (child.stdout === null || child.stdin === null) {
      closeInput(child)
      return { exit: await exited }
    }
    try {
      const connection = await connectHost({
        transport: { input: child.stdout, output: child.stdin },
        appVersion: deps.appVersion,
        log: deps.log
      })
      return { connection, exited, child }
    } catch (error) {
      closeInput(child)
      if (error instanceof HostRefusedError) {
        await exited
        throw failure(clause(error.message))
      }
      return { exit: await exited }
    }
  }

  let attempt = await bridge()
  let host: StartedHost | null = null
  const first = 'exit' in attempt && attempt.exit.error === undefined ? attempt.exit.code : null
  // A client that has pinned no host does not knock on the socket, so "not
  // paired, no code" is also what it says when no host is running at all; a
  // host started then writes the code it enrols with. One already running
  // refuses to start a second on its folders, and the sentence stays "not paired".
  if (first === BRIDGE_EXIT.unreachable || first === BRIDGE_EXIT.notPinned) {
    deps.log(
      first === BRIDGE_EXIT.unreachable
        ? 'host: no local host answered; starting one'
        : 'host: not paired with a host and no code waits; starting one'
    )
    const unpaired = attempt
    try {
      host = await startHost(binary, options, deps)
    } catch (error) {
      if (first === BRIDGE_EXIT.notPinned && error instanceof HostEndedEarly && 'exit' in unpaired) {
        throw bridgeFailure(unpaired.exit, binary, false)
      }
      throw error
    }
    try {
      attempt = await bridge()
    } catch (error) {
      await host.stop()
      throw error
    }
  }
  if ('exit' in attempt) {
    const why = bridgeFailure(attempt.exit, binary, host !== null)
    deps.log(`host: could not connect (${describeExit(attempt.exit)})`)
    await host?.stop()
    throw why
  }

  const { connection, exited, child } = attempt
  void exited.then((exit) => deps.log(`host: floti bridge ended (${describeExit(exit)})`))
  const started = host
  let stopping: Promise<void> | null = null
  return {
    connection,
    startedHost: started !== null,
    stop: () => {
      stopping ??= (async () => {
        connection.close()
        closeInput(child)
        await exited
        await started?.stop()
      })()
      return stopping
    }
  }
}

/**
 * A Helm page's own connection to the local host: a `floti bridge` of its
 * own, run from Helm's client folder as main's is, whose frames main pipes to
 * the page and never reads. The device key and the Noise session stay in the
 * bridge; the page sees only protocol frames.
 */
export interface PageBridge {
  /** The page's bytes, to the host. Ignored once ended. */
  write(bytes: Uint8Array): void
  /** Closes the bridge's standard input, which ends its connection. */
  end(): void
  /** Settles once the bridge has exited: null when it closed, or the sentence saying why it failed. */
  readonly ended: Promise<string | null>
}

/**
 * Starts a page's bridge to the host that is already running: main opens one
 * only after its own link has connected, so enrolment is done and the host
 * is listening. `data` gets the host's bytes, unread.
 */
export function openPageBridge(
  places: HostPlaces,
  deps: Pick<LauncherDeps, 'platform' | 'env' | 'tmpdir' | 'exists' | 'spawn'>,
  data: (bytes: Uint8Array) => void
): PageBridge {
  const binary = flotiBinary(places, deps)
  if (!deps.exists(binary)) {
    const missing = failure(`Helm could not find the local host program at ${binary}`).message
    return { write: () => undefined, end: () => undefined, ended: Promise.resolve(missing) }
  }
  const child = deps.spawn(binary, ['bridge', clientFolder(places, deps.platform)], {
    env: hostEnvironment(places, deps),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const exited = exitOf(child)
  // Its one line on standard error says why it failed; the exit status says
  // the same, and nothing it prints is logged.
  child.stderr?.resume()
  child.stdout?.on('data', (chunk: Uint8Array) =>
    data(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  )
  const stdin = child.stdin
  const open = (): boolean => stdin !== null && !stdin.writableEnded && !stdin.destroyed
  // A write racing the bridge's exit fails on the pipe; the exit says why.
  stdin?.on('error', () => undefined)
  return {
    write: (bytes) => {
      if (open()) stdin?.write(bytes)
    },
    end: () => closeInput(child),
    ended: exited.then((exit) =>
      exit.error === undefined && exit.code === BRIDGE_EXIT.closed ? null : bridgeFailure(exit, binary, false).message
    )
  }
}

function describeExit(exit: Exit): string {
  if (exit.error !== undefined)
    return `could not run: ${(exit.error as NodeJS.ErrnoException).code ?? exit.error.message}`
  return exit.code === null ? `stopped by ${exit.signal ?? 'a signal'}` : `status ${exit.code}`
}

interface StartedHost {
  stop(): Promise<void>
}

/**
 * Starts `floti host --until-stdin-closes` and resolves once it says it is
 * listening. Its standard input stays open, held by Helm, until `stop`.
 */
async function startHost(binary: string, options: SpawnOptions, deps: LauncherDeps): Promise<StartedHost> {
  const child = deps.spawn(binary, ['host', '--until-stdin-closes'], options)
  const exited = exitOf(child)
  child.stderr?.resume()
  const stop = async (): Promise<void> => {
    closeInput(child)
    await exited
  }

  const listening = new Promise<'listening'>((resolve) => {
    const stdout = child.stdout
    if (stdout === null) return
    let pending = ''
    const onData = (chunk: Buffer | string): void => {
      pending += chunk.toString()
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (LISTENING.test(line)) {
          // What it says after that is not read, only drained.
          stdout.off('data', onData)
          stdout.resume()
          resolve('listening')
          return
        }
        newline = pending.indexOf('\n')
      }
    }
    stdout.on('data', onData)
  })
  let timer: unknown = null
  const deadline = new Promise<'late'>((resolve) => {
    timer = deps.setTimeout(() => resolve('late'), HOST_START_DEADLINE_MS)
  })

  const outcome = await Promise.race([listening, deadline, exited])
  deps.clearTimeout(timer)
  if (outcome === 'listening') {
    deps.log('host: the local host Helm started is listening')
    return { stop }
  }
  if (outcome === 'late') {
    await stop()
    throw failure(`The local host did not say it was listening within ${HOST_START_DEADLINE_MS / 1000} seconds`)
  }
  if (outcome.error !== undefined) throw couldNotRun(binary, outcome.error)
  deps.log(`host: the local host Helm started stopped before it was ready (${describeExit(outcome)})`)
  throw new HostEndedEarly(
    `${
      outcome.code === null
        ? `The local host stopped before it was ready, stopped by ${outcome.signal ?? 'a signal'}`
        : `The local host stopped before it was ready, with status ${outcome.code}`
    }; ${TURN_OFF}`
  )
}

/** A host Helm started that exited before it said it was listening, as one already running on its folders does. */
class HostEndedEarly extends LocalHostError {}
