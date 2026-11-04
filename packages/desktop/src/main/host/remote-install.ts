import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chooseSource,
  flotiLine,
  flotiPathProblem,
  formatProtocol,
  installFolderFor,
  judgeProtocol,
  parseShortVersion,
  parseSystemLine,
  parseVersionLine,
  releaseFileName,
  saysNotFound,
  SETUP_AT_NEXT_SIGN_IN_EXIT,
  SYSTEM_LINE,
  systemOfBuild,
  type FlotiFound,
  type FlotiOs,
  type HostCheck,
  type HostTransport,
  type InstallOutcome,
  type ProtocolVersionNumbers,
  type RemoteSystem
} from '@helm/core/types'
import { runsAsWritten, systemWsl, transportArgv, type TransportPrograms } from './remote-launcher'

/**
 * Installing and updating floti on a host's computer, over the same login
 * this device reaches the host by: `ssh -o BatchMode=yes <target> <line>`, or
 * the user's command with the line last, run without a shell on this PC.
 *
 * - The check changes nothing on either computer. It runs `floti version`
 *   there (the floti path the host keeps, when it keeps one) and, only when
 *   that says floti is not there, `SYSTEM_LINE` for its OS and CPU; for a
 *   floti too old to talk to, also `floti update-stop --ask`, which counts the
 *   sessions an update would end. Compatibility is judged from the protocol
 *   `floti version` names, as the host judges a hello (P6).
 * - What it found is kept here under an id, with the plan of what to do; the
 *   window gets the offer and answers with that id, or cancels it. The
 *   window never says what to run.
 * - Nothing is copied or run there before `install`. Then an update first
 *   stops the old host for the update (`floti update-stop --stop`, which
 *   keeps its sessions' rows to offer back), then the install script is sent
 *   with this Helm's own floti on its standard input when that computer's OS
 *   and CPU are this PC's, or with the release's address otherwise, which
 *   that computer downloads from itself. Either way the script checks the
 *   file's SHA-256 there before it moves it into place, so a floti that was
 *   there keeps working when anything fails. Then `<path> setup` there.
 * - Every failure is the last line written there, unedited, with the step it
 *   failed at.
 */

/** How one run of the transport ended, with what it wrote. */
export interface TransportRun {
  code: number | null
  stdout: string
  stderr: string
  /** Why the transport's program could not be run on this PC at all. */
  error?: string
  /** The transport's program is not on this PC (`ENOENT`): no ssh, or no such command. */
  notFound?: boolean
}

/** How a run's last argument goes on its command line. */
export interface RunHow {
  /**
   * The last argument is appended to the command line as written, never
   * quoted as one argument, and the program runs with `WSL_UTF8=1`: for this
   * PC's `wsl.exe` (`runsAsWritten`).
   */
  asWritten?: boolean
}

/**
 * Runs `argv` without a shell, with the file at `stdinFile` as its standard
 * input, or none. When `signal` aborts, the run is stopped: its program ends.
 */
export type RunTransport = (
  argv: readonly string[],
  stdinFile: string | null,
  signal?: AbortSignal,
  how?: RunHow
) => Promise<TransportRun>

export interface RemoteInstallDeps {
  run: RunTransport
  /** The programs that run this PC's ssh and `wsl.exe`: `ssh` and System32's when absent. */
  programs?: TransportPrograms
  /** This process's environment, where System32 is found when `wsl` is absent. */
  env?: NodeJS.ProcessEnv
  /** This PC's `process.platform` and `process.arch`. */
  platform: string
  arch: string
  /** This Helm's version, which is floti's. */
  version: string
  /** The protocol this Helm speaks. */
  protocol: ProtocolVersionNumbers
  /** This Helm's own floti and its SHA-256, or null when it carries none. */
  ownBuild: () => Promise<{ path: string; sha256: string } | null>
  /** The release's SHA-256 list this Helm carries (`floti-SHA256SUMS`), or null when it carries none. */
  sums: () => Promise<ReadonlyMap<string, string> | null>
  /** The install script for a computer of `os`: install.ps1 on Windows, install.sh elsewhere. */
  script: (os: FlotiOs) => Promise<string>
  /** The folder of the release of `version` its files are downloaded from. */
  releaseBase: (version: string) => string
  newId?: () => string
  log: (line: string) => void
}

export interface RemoteInstaller {
  /**
   * What is on that computer, and the offer when floti is missing or too old
   * there. `signal` stops a check under way: the add-a-host dialog's Cancel.
   */
  check(target: { transport: HostTransport; floti?: string | undefined }, signal?: AbortSignal): Promise<HostCheck>
  /** Does what the check with `id` offered. Rejects for an id no check gave, or one used or cancelled. */
  install(id: string): Promise<InstallOutcome>
  /** Forgets the offer: nothing is run there. */
  cancel(id: string): void
}

interface Plan {
  transport: HostTransport
  /** The floti an update replaces, by the path the host keeps or on `PATH`. */
  floti: string | undefined
  action: 'install' | 'update'
  os: FlotiOs
  cpu: string
  source: { how: 'copy' } | { how: 'download'; file: string; sha256: string }
}

/** `update-stop`'s status when no host is running there, and `floti`'s for usage it does not know. */
const NO_HOST_EXIT = 3
const USAGE_EXIT = 2

/** What a run said last: the program's failure, its last line on standard error, or on standard output. */
const CLIXML = /^(#< CLIXML|<Objs[ >])/

export function lastLineOf(run: TransportRun): string {
  if (run.error !== undefined) return run.error
  for (const text of [run.stderr, run.stdout]) {
    const lines = text.split(/\r?\n/).map((line) => line.trimEnd())
    // PowerShell writes its progress and other streams to a redirected
    // standard error as CLIXML records, `#< CLIXML` and then `<Objs ...>`:
    // not a line anybody wrote.
    const last = lines.filter((line) => line.trim() !== '' && !CLIXML.test(line)).at(-1)
    if (last !== undefined) return last
  }
  return run.code === null ? 'The command was stopped before it said anything.' : `It exited with status ${String(run.code)}.`
}

/**
 * A check that could not run there: the last line, everything written for
 * what the last line alone cannot tell (a changed host key and an unknown one
 * end on the same line), and whether the transport's program is missing here.
 */
function failedCheck(run: TransportRun): HostCheck {
  const said = `${run.stderr}\n${run.stdout}`.trim()
  return {
    kind: 'failed',
    lastLine: lastLineOf(run),
    ...(said !== '' ? { said } : {}),
    ...(run.notFound === true ? { cause: 'transportMissing' as const } : {})
  }
}

/** The first line the login printed before `floti version`'s own line, or null when that line came first. */
export function firstLineBeforeVersion(stdout: string): string | null {
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .find((line) => line.trim() !== '')
  if (first === undefined || parseVersionLine(first) !== null) return null
  return first
}

/** A word for a POSIX shell: single-quoted, each quote in it closed, escaped and reopened. */
function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/**
 * The line that runs the install script there with `args`: through `sh -c`
 * with the script as its one argument on a POSIX computer, and through
 * PowerShell's `-EncodedCommand` on Windows, whose line `cmd` (the shell
 * Windows' OpenSSH runs it in) passes on untouched. The script's comment lines
 * are left out there, to keep the line inside `cmd`'s limit.
 */
export function installLine(os: FlotiOs, script: string, args: readonly string[]): string {
  const text = script.replace(/\r\n/g, '\n')
  if (os !== 'windows') return `sh -c ${shellWord(text)} floti-install ${args.map(shellWord).join(' ')}`
  const body = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') && line.trim() !== '')
    .join('\n')
  const call = `& {\n${body}\n} ${args.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(' ')}`
  const encoded = Buffer.from(call, 'utf16le').toString('base64')
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

/** Characters `cmd` reads rather than passes on, outside double quotes. */
const CMD_READS = /[|&<>^%()]/

/**
 * The line a distro's shell is given: as it is when `cmd` (which Windows'
 * OpenSSH runs a line in, before `wsl.exe`) would pass it on unaltered, and
 * otherwise as `eval "$(echo <base64> | base64 -d)"`, whose only `|` is in
 * double quotes, so the line reaches the distro's shell as it was written,
 * with standard input left for the line. floti's own lines go as they are.
 */
export function wslLine(line: string): string {
  if (!CMD_READS.test(line)) return line
  return `eval "$(echo ${Buffer.from(line, 'utf8').toString('base64')} | base64 -d)"`
}

/**
 * What a program wrote, as text: UTF-16LE when it is (what `wsl.exe` writes to
 * a pipe without `WSL_UTF8=1`, as it always does through ssh), else UTF-8.
 * The same judgement as `decode_output` in crates/host/src/bridge.rs: a
 * byte-order mark, or every other byte mostly zero, as ASCII is in UTF-16LE
 * and never in UTF-8.
 */
export function decodeOutput(bytes: Uint8Array): string {
  const pairs = Math.floor(bytes.length / 2)
  let utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
  if (!utf16 && pairs > 0) {
    let highZero = 0
    let lowZero = 0
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      if (bytes[i + 1] === 0) highZero += 1
      if (bytes[i] === 0) lowZero += 1
    }
    utf16 = highZero * 2 > pairs && lowZero * 4 < pairs
  }
  if (!utf16) return new TextDecoder('utf-8').decode(bytes)
  return new TextDecoder('utf-16le').decode(bytes.subarray(0, pairs * 2)).replace(/^\uFEFF/, '')
}

export function createRemoteInstaller(deps: RemoteInstallDeps): RemoteInstaller {
  const plans = new Map<string, Plan>()
  const newId = deps.newId ?? randomUUID

  const programs: TransportPrograms = {
    ...deps.programs,
    wsl: deps.programs?.wsl ?? systemWsl(deps.env ?? {})
  }
  const runThere = (
    transport: HostTransport,
    line: string,
    stdinFile: string | null = null,
    signal?: AbortSignal
  ): Promise<TransportRun> => {
    const argv = [...transportArgv(transport, programs), transport.kind === 'wsl' ? wslLine(line) : line]
    if (runsAsWritten(transport)) return deps.run(argv, stdinFile, signal, { asWritten: true })
    return signal === undefined ? deps.run(argv, stdinFile) : deps.run(argv, stdinFile, signal)
  }

  /** How many sessions the floti there says an update ends, or null when it cannot say. */
  const sessionsThere = async (transport: HostTransport, floti: string | undefined): Promise<number | null> => {
    const asked = await runThere(transport, flotiLine(floti, 'update-stop --ask'))
    if (asked.code === NO_HOST_EXIT) return 0
    const count = asked.stdout.trim()
    return asked.code === 0 && /^\d+$/.test(count) ? Number(count) : null
  }

  /** The OS and CPU there, or what the line said instead. */
  const systemThere = async (transport: HostTransport, signal?: AbortSignal): Promise<RemoteSystem | HostCheck> => {
    const said = await runThere(transport, SYSTEM_LINE, null, signal)
    const system = said.code === 0 ? parseSystemLine(said.stdout) : null
    return system ?? failedCheck(said)
  }

  const offer = async (
    transport: HostTransport,
    floti: string | undefined,
    system: RemoteSystem,
    found: FlotiFound | null
  ): Promise<HostCheck> => {
    const own = await deps.ownBuild()
    const source = chooseSource({
      system,
      desktop: { platform: deps.platform, arch: deps.arch },
      ownBuild: own !== null,
      version: deps.version,
      sums: await deps.sums()
    })
    if (source.how === 'none' || system.os === null) {
      return { kind: 'noBuild', system, reason: source.how === 'none' ? source.reason : `There is no floti for ${system.label} yet.` }
    }
    const action = found === null ? 'install' : 'update'
    const id = newId()
    plans.set(id, { transport, floti, action, os: system.os, cpu: system.cpu, source })
    return {
      kind: 'offer',
      id,
      offer: {
        system,
        found,
        action,
        how: source.how,
        version: deps.version,
        folder: installFolderFor(system.os),
        sessions: action === 'update' ? await sessionsThere(transport, floti) : null
      }
    }
  }

  return {
    async check({ transport, floti }, signal) {
      const asked = await runThere(transport, flotiLine(floti, 'version'), null, signal)
      if (asked.error !== undefined) return failedCheck(asked)
      const found = asked.code === 0 ? parseVersionLine(asked.stdout) : null
      if (found !== null) {
        // floti's connection goes where its version line went: anything the
        // login printed before it would land in the middle of the handshake.
        const printed = firstLineBeforeVersion(asked.stdout)
        if (printed !== null) return { kind: 'failed', lastLine: printed, cause: 'loginOutput' }
        const { protocolNumbers, os, cpu, ...named } = found
        const verdict = judgeProtocol(protocolNumbers, deps.protocol)
        if (verdict === 'ok') return { kind: 'ready', found: named, system: systemOfBuild(os, cpu) }
        if (verdict === 'newer') {
          return { kind: 'newer', found: named, ours: formatProtocol(deps.protocol), helm: deps.version }
        }
        return offer(transport, floti, systemOfBuild(os, cpu), named)
      }
      const said = `${asked.stderr}\n${asked.stdout}`
      // A floti from before `floti version`: too old, whatever it is.
      const old = asked.code === USAGE_EXIT && /^usage: floti /m.test(said)
      if (!old && !saysNotFound(asked.code, said)) return failedCheck(asked)
      const system = await systemThere(transport, signal)
      if ('kind' in system) return system
      if (!old) return offer(transport, floti, system, null)
      const short = await runThere(transport, flotiLine(floti, '--version'))
      const version = (short.code === 0 ? parseShortVersion(short.stdout) : null) ?? 'of unknown version'
      return offer(transport, floti, system, { version, protocol: null })
    },

    async install(id) {
      const plan = plans.get(id)
      if (plan === undefined) throw new Error('That offer is no longer open. Check the host again.')
      plans.delete(id)
      const { transport } = plan
      if (plan.action === 'update') {
        const stop = await runThere(transport, flotiLine(plan.floti, 'update-stop --stop'))
        // No host running there is nothing to stop; a floti too old to stop
        // itself for an update is replaced as it runs.
        if (stop.code !== 0 && stop.code !== NO_HOST_EXIT && stop.code !== USAGE_EXIT) {
          return { ok: false, step: 'stop', lastLine: lastLineOf(stop) }
        }
      }
      const script = await deps.script(plan.os)
      let args: string[]
      let stdinFile: string | null = null
      if (plan.source.how === 'copy') {
        const own = await deps.ownBuild()
        if (own === null) return { ok: false, step: 'install', lastLine: 'This Helm no longer has its own floti to send.' }
        args = [deps.version, releaseFileName(deps.version, plan.os, plan.cpu), own.sha256, '-']
        stdinFile = own.path
      } else {
        args = [deps.version, plan.source.file, plan.source.sha256, deps.releaseBase(deps.version)]
      }
      const put = await runThere(transport, installLine(plan.os, script, args), stdinFile)
      if (put.code !== 0) return { ok: false, step: 'install', lastLine: lastLineOf(put) }
      const path = put.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').at(-1) ?? ''
      const problem = flotiPathProblem(path)
      if (problem !== null) return { ok: false, step: 'install', lastLine: `floti was installed, but ${problem}.` }
      deps.log(`host: installed floti ${deps.version} at ${path} there`)
      const setup = await runThere(transport, flotiLine(path, 'setup'))
      if (setup.code === 0) return { ok: true, floti: path, startsAtNextSignIn: false }
      if (setup.code === SETUP_AT_NEXT_SIGN_IN_EXIT) return { ok: true, floti: path, startsAtNextSignIn: true }
      return { ok: false, step: 'setup', lastLine: lastLineOf(setup) }
    },

    cancel(id) {
      plans.delete(id)
    }
  }
}

/** The most of a run's output kept: its last lines are what is shown. */
const KEPT = 64 * 1024

/**
 * A word on a Windows command line, quoted the way a program's own C runtime
 * splits it back: as it is when it holds no blank or quote, else in double
 * quotes with each quote, and the backslashes before one, escaped.
 */
export function windowsArgument(word: string): string {
  if (word !== '' && !/[\s"]/.test(word)) return word
  let quoted = '"'
  let slashes = 0
  for (const char of word) {
    if (char === '\\') {
      slashes += 1
      continue
    }
    quoted += char === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + char
    slashes = 0
  }
  return `${quoted}${'\\'.repeat(slashes * 2)}"`
}

/** How `spawnTransportRun` starts a program. */
export interface TransportSpawnOptions {
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: true
  /** Set for a run as written: the command line is the arguments as given. */
  windowsVerbatimArguments?: true
  argv0?: string
}

/**
 * Runs a transport for real: the program and its arguments without a shell,
 * windowless, with `env` as it is (the user's ssh finds their config, keys and
 * agent), and a file piped to its standard input when one is given.
 *
 * A run as written (this PC's `wsl.exe`) gets `WSL_UTF8=1` and, on Windows, a
 * command line built here: every word before the last quoted as its program's
 * runtime reads it (`windowsArgument`), and the last, the distro's line,
 * appended as it is. Elsewhere the line is one more argument. What it writes
 * is read as UTF-16LE when it is (`decodeOutput`).
 */
export function spawnTransportRun(
  spawn: (command: string, args: string[], options: TransportSpawnOptions) => ChildProcess,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): RunTransport {
  return (argv, stdinFile, signal, how) =>
    new Promise((done) => {
      const [program, ...args] = argv as [string, ...string[]]
      const out: Buffer[] = []
      const err: Buffer[] = []
      const text = (chunks: Buffer[]): string => {
        const all = Buffer.concat(chunks)
        // The last lines are what is shown; an even cut keeps UTF-16 whole.
        return decodeOutput(all.length > KEPT ? all.subarray(all.length - KEPT) : all)
      }
      const keep = (chunks: Buffer[], chunk: Buffer | string): void => {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
        let size = chunks.reduce((sum, each) => sum + each.length, 0)
        while (chunks.length > 1 && size - (chunks[0]?.length ?? 0) >= KEPT) size -= chunks.shift()?.length ?? 0
      }
      let settled = false
      const finish = (run: TransportRun): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', stop)
        done(run)
      }
      const failedToRun = (error: unknown): TransportRun => ({
        code: null,
        stdout: text(out),
        stderr: text(err),
        error: couldNotRun(program, error),
        ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? { notFound: true } : {})
      })
      let child: ChildProcess | null = null
      // The run this PC started, by its own process: nothing else is stopped.
      const stop = (): void => {
        child?.kill()
      }
      if (signal?.aborted === true) {
        finish({ code: null, stdout: '', stderr: '' })
        return
      }
      signal?.addEventListener('abort', stop, { once: true })
      const options: TransportSpawnOptions = { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      let spawnArgs = args
      if (how?.asWritten === true) {
        options.env = { ...env, WSL_UTF8: '1' }
        if (platform === 'win32') {
          // Node quotes nothing with verbatim arguments, so each word but the
          // line is quoted here, the program's own name included.
          options.windowsVerbatimArguments = true
          options.argv0 = windowsArgument(program)
          spawnArgs = args.map((word, at) => (at === args.length - 1 ? word : windowsArgument(word)))
        }
      }
      try {
        child = spawn(program, spawnArgs, options)
      } catch (error) {
        finish(failedToRun(error))
        return
      }
      child.stdout?.on('data', (chunk: Buffer | string) => keep(out, chunk))
      child.stderr?.on('data', (chunk: Buffer | string) => keep(err, chunk))
      child.once('error', (error) => finish(failedToRun(error)))
      child.once('close', (code: number | null) => finish({ code, stdout: text(out), stderr: text(err) }))
      const stdin = child.stdin
      if (stdin === null) return
      // A program that exits before reading all of it closes the pipe.
      stdin.on('error', () => undefined)
      if (stdinFile === null) {
        stdin.end()
        return
      }
      const file = createReadStream(stdinFile)
      file.once('error', () => stdin.destroy())
      file.pipe(stdin)
    })
}

function couldNotRun(program: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  return `Helm could not run ${program} on this PC (${code ?? (error as Error).message}).`
}
