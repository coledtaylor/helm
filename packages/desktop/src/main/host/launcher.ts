import { createHash } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { RECONNECT_FIRST_MS } from '../../shared/host/reconnect'
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
 * - `floti host --desktop <Helm> [--desktop-arg <app>]` is the host, started
 *   by Helm when no host answered, and told which Helm started it (the
 *   command that opens that Helm again). It outlives Helm: Helm reads only
 *   its listening line, then lets go of it, and the host decides its own
 *   exit - once it runs nothing and no client is attached, or when it is
 *   stopped. Helm crashing or being killed ends nothing, and Helm's next start
 *   connects to the same host through its bridge before it would start one.
 *   A host still ending its sessions holds its folders until it has, so a
 *   start that finds them held waits it out, up to the start deadline.
 *
 * Helm never opens the enrolment file or a key: the bridge reads them, and
 * says what went wrong as an exit status. Nothing the bridge prints is
 * logged, nor anything on the host's standard output, and the one line shown
 * is a host's reason for not starting, which it writes to be shown and which
 * names no code or key. What a host Helm started writes to standard error
 * before it has pointed it at its own log file goes into Helm's log, until
 * Helm lets go of the host: a host that dies that early leaves its reason
 * somewhere. The host writes nothing there that its log file may not hold.
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
  hostClosed: 6,
  transportNotStarted: 7,
  transportEnded: 8,
  pairingExpired: 9
} as const

/** The line `floti host` prints once it listens, the first on its standard output. */
const LISTENING = /^Floti host is listening at (.+)\.$/

/** The line `floti host` prints on its standard output when it stops before it listens: why, in one sentence. */
const DID_NOT_START = /^Floti host did not start: (.+)$/

/** How long a host Helm started has to say it is listening, and how long a start waits out a host still exiting. */
export const HOST_START_DEADLINE_MS = 30_000

/**
 * `floti host`'s exit status when another host still has its folders
 * (`ALREADY_RUNNING_EXIT` in `crates/host/src/lib.rs`).
 */
export const HOST_ALREADY_RUNNING_EXIT = 3

/**
 * How long a start waits before trying again while another host still has
 * the folders, and the first wait before a lost connection is tried again.
 */
export const HOST_RETRY_MS = RECONNECT_FIRST_MS

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
  /** `process.execPath`: the program that is this Helm. */
  execPath: string
  /** `app.getAppPath()`: what an unpackaged Helm's program is given to run this app. */
  appPath: string
}

/** A child process, as much of one as this needs; `child_process.spawn` returns one. */
export interface HostChild {
  readonly stdin: Writable | null
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  /** Ends the program: only ever a host Helm started that never served it. */
  kill(): boolean
  /** Lets Helm exit without waiting for the program. */
  unref(): void
}

export interface SpawnOptions {
  env: NodeJS.ProcessEnv
  /**
   * A bridge's three pipes; a host's standard output, for its listening line,
   * and its standard error, for what it says before its log file is open.
   */
  stdio: ['pipe', 'pipe', 'pipe'] | ['ignore', 'pipe', 'pipe']
  windowsHide: true
  /**
   * A host apart from Helm, so it outlives Helm however Helm ends. On macOS
   * and Linux it leads a session of its own, so nothing sent to Helm's
   * process group (a terminal's Ctrl+C or hang-up) reaches it. On Windows it
   * is left out of the job Node puts every other child in, which ends them
   * all when Helm's process ends; it then has no console, so the host starts
   * every console program it runs outside a terminal with no window
   * (`windowless` in the host's platform launcher).
   */
  detached?: boolean
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

/** A connection to the local host. */
export interface LocalHost {
  readonly connection: HostConnection
  /** Whether Helm started the host, rather than finding one running. */
  readonly startedHost: boolean
  /**
   * Closes the connection and lets go of the bridge; resolves once the bridge
   * has exited. The host is never stopped here: it decides its own exit.
   */
  close(): Promise<void>
}

/** Why the desktop could not reach the local host, as one sentence that says the setting can be turned off. */
export class LocalHostError extends Error {
  override name = 'LocalHostError'
}

function pathsFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * What `floti host` is told about the Helm starting it: the command that
 * opens this Helm again, which is its program and, unpackaged, the app it
 * runs.
 */
export function desktopArgs(places: HostPlaces): string[] {
  return ['--desktop', places.execPath, ...(places.packaged ? [] : ['--desktop-arg', places.appPath])]
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
 *
 * The name is short because macOS's temp folder already takes about half the
 * limit (`/var/folders/<2>/<28>/T/`), and a test run's own folder sits inside
 * it: twelve hex characters of the hash still tell one data directory from
 * another.
 */
function runtimeFolder(dataDir: string, deps: Pick<LauncherDeps, 'platform' | 'env' | 'tmpdir'>): string {
  const paths = pathsFor(deps.platform)
  const inside = paths.join(dataDir, 'host', 'run')
  if (deps.platform === 'win32') return inside
  if (Buffer.byteLength(paths.join(inside, 'floti.sock')) <= SOCKET_PATH_MAX) return inside
  const runtime = deps.env['XDG_RUNTIME_DIR']
  const base = runtime !== undefined && paths.isAbsolute(runtime) ? runtime : deps.tmpdir()
  const name = `floti-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}`
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

/** Closes a child's standard input, which ends the bridge's connection. */
function closeInput(child: HostChild): void {
  if (child.stdin !== null && !child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end()
}

type BridgeAttempt = { connection: HostConnection; exited: Promise<Exit>; child: HostChild } | { exit: Exit }

/**
 * Connects to the local host, starting it when none answers. With
 * `startHost` false it only connects: a host that does not answer is a
 * failure, for a host Helm waits for rather than replaces. Rejects with a
 * `LocalHostError` whose message is the one sentence to show.
 */
export async function startLocalHost(
  places: HostPlaces,
  deps: LauncherDeps,
  { startHost: mayStart = true }: { startHost?: boolean } = {}
): Promise<LocalHost> {
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
  const hostOptions: SpawnOptions = {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true
  }
  const hostArgs = ['host', ...desktopArgs(places)]

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
  if (mayStart && (first === BRIDGE_EXIT.unreachable || first === BRIDGE_EXIT.notPinned)) {
    deps.log(
      first === BRIDGE_EXIT.unreachable
        ? 'host: no local host answered; starting one'
        : 'host: not paired with a host and no code waits; starting one'
    )
    const unpaired = attempt
    try {
      // A host still ending its sessions does not answer but holds the
      // folders; one that answers and only refuses Helm is not waited for.
      host = await startHost(binary, hostArgs, hostOptions, deps, first === BRIDGE_EXIT.unreachable)
    } catch (error) {
      // Only a host that found one already running leaves "not paired" the
      // reason; one that stopped for a reason of its own says that.
      if (first === BRIDGE_EXIT.notPinned && error instanceof HostFoldersHeld && 'exit' in unpaired) {
        throw bridgeFailure(unpaired.exit, binary, false)
      }
      throw error
    }
    try {
      attempt = await bridge()
    } catch (error) {
      await host.abandon()
      throw error
    }
  }
  if ('exit' in attempt) {
    const why = bridgeFailure(attempt.exit, binary, host !== null)
    deps.log(`host: could not connect (${describeExit(attempt.exit)})`)
    await host?.abandon()
    throw why
  }

  const { connection, exited, child } = attempt
  void exited.then((exit) => deps.log(`host: floti bridge ended (${describeExit(exit)})`))
  // Connected: the host Helm started is the host's own from here on.
  host?.release()
  let closing: Promise<void> | null = null
  return {
    connection,
    startedHost: host !== null,
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

/** A host Helm started and has not yet connected through. */
interface StartedHost {
  /** Helm is through with it: it stops reading it and exits without waiting for it. */
  release(): void
  /** Ends it, for a host Helm could not connect through: it never served anyone. */
  abandon(): Promise<void>
}

/** Waits `ms` on the launcher's clock. */
function delay(deps: Pick<LauncherDeps, 'setTimeout'>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    deps.setTimeout(resolve, ms)
  })
}

/**
 * Starts the host and resolves once it says it is listening. With
 * `waitOut`, a host that finds another still holding its folders is tried
 * again until the start deadline: one that is ending its sessions lets them
 * go once it has.
 */
async function startHost(
  binary: string,
  args: string[],
  options: SpawnOptions,
  deps: LauncherDeps,
  waitOut: boolean
): Promise<StartedHost> {
  for (let tries = Math.ceil(HOST_START_DEADLINE_MS / HOST_RETRY_MS); ; tries -= 1) {
    try {
      return await startHostOnce(binary, args, options, deps)
    } catch (error) {
      if (!(error instanceof HostFoldersHeld) || !waitOut) throw error
      if (tries <= 0) {
        throw failure(
          `Another local host still had Helm's host folders after ${HOST_START_DEADLINE_MS / 1000} seconds`
        )
      }
      if (tries === Math.ceil(HOST_START_DEADLINE_MS / HOST_RETRY_MS)) {
        deps.log('host: another host still has the folders; waiting for it to exit')
      }
      await delay(deps, HOST_RETRY_MS)
    }
  }
}

/** Starts `floti host` once, and resolves once it says it is listening. */
async function startHostOnce(
  binary: string,
  args: string[],
  options: SpawnOptions,
  deps: LauncherDeps
): Promise<StartedHost> {
  const child = deps.spawn(binary, args, options)
  const exited = exitOf(child)
  keepStandardError(child, deps)
  const release = (): void => {
    // What it says after its listening line is not read: a host whose
    // console has gone writes on regardless.
    child.stdout?.destroy()
    // It points its standard error at its own log file first thing, so
    // nothing more is expected there.
    child.stderr?.destroy()
    child.unref()
  }
  const abandon = async (): Promise<void> => {
    child.kill()
    await exited
  }

  // Why it did not start, when it says so, and whether it has said all it
  // will: a process's exit can be seen before the last of its output.
  let reason: string | null = null
  let outputEnded: Promise<void> = Promise.resolve()
  const listening = new Promise<'listening'>((resolve) => {
    const stdout = child.stdout
    if (stdout === null) return
    let pending = ''
    /** Reads one line; true once it is the listening line. */
    const read = (line: string): boolean => {
      if (LISTENING.test(line)) return true
      reason = DID_NOT_START.exec(line)?.[1] ?? reason
      return false
    }
    const onData = (chunk: Buffer | string): void => {
      pending += chunk.toString()
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (read(line)) {
          // What it says after that is only drained until Helm lets go.
          stdout.off('data', onData)
          stdout.resume()
          resolve('listening')
          return
        }
        newline = pending.indexOf('\n')
      }
    }
    stdout.on('data', onData)
    outputEnded = new Promise((ended) => {
      const done = (): void => {
        if (pending !== '') read(pending.replace(/\r$/, ''))
        pending = ''
        ended()
      }
      stdout.once('end', done)
      stdout.once('close', done)
    })
  })
  let timer: unknown = null
  const deadline = new Promise<'late'>((resolve) => {
    timer = deps.setTimeout(() => resolve('late'), HOST_START_DEADLINE_MS)
  })

  const outcome = await Promise.race([listening, deadline, exited])
  if (outcome === 'listening') {
    deps.clearTimeout(timer)
    deps.log('host: the local host Helm started is listening')
    return { release, abandon }
  }
  if (outcome === 'late') {
    await abandon()
    throw failure(`The local host did not say it was listening within ${HOST_START_DEADLINE_MS / 1000} seconds`)
  }
  // It has exited. Its reason is read once its output has ended, which a
  // program it left running could hold open: past the deadline, it has none.
  await Promise.race([outputEnded, deadline])
  deps.clearTimeout(timer)
  if (outcome.error !== undefined) throw couldNotRun(binary, outcome.error)
  if (outcome.code === HOST_ALREADY_RUNNING_EXIT) throw new HostFoldersHeld()
  deps.log(`host: the local host Helm started stopped before it was ready (${describeExit(outcome)})`)
  const why = reason as string | null
  if (why !== null) throw new HostEndedEarly(`The local host did not start: ${clause(why)}; ${TURN_OFF}`)
  throw new HostEndedEarly(
    `${
      outcome.code === null
        ? `The local host stopped before it was ready, stopped by ${outcome.signal ?? 'a signal'}`
        : `The local host stopped before it was ready, with status ${outcome.code}`
    }; ${TURN_OFF}`
  )
}

/**
 * Logs each line a host Helm started writes to standard error, prefixed so
 * it reads as the host's, until the pipe is let go of or ends.
 */
function keepStandardError(child: HostChild, deps: Pick<LauncherDeps, 'log'>): void {
  const stderr = child.stderr
  if (stderr === null) return
  let pending = ''
  const say = (line: string): void => {
    const text = line.replace(/\r$/, '')
    if (text.trim() !== '') deps.log(`host: floti host said: ${text}`)
  }
  stderr.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString()
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      say(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  })
  const done = (): void => {
    if (pending !== '') say(pending)
    pending = ''
  }
  stderr.once('end', done)
  stderr.once('close', done)
  // A pipe let go of while the host writes fails; that is nothing to report.
  stderr.on('error', () => undefined)
}

/** A host Helm started that exited before it said it was listening. */
class HostEndedEarly extends LocalHostError {}

/** A host Helm started that found another host still holding its folders or socket. */
class HostFoldersHeld extends HostEndedEarly {
  constructor() {
    super(`Another local host is running on Helm's host folders; ${TURN_OFF}`)
  }
}
