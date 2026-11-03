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
import { transportArgv } from './remote-launcher'

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

/**
 * Runs `argv` without a shell, with the file at `stdinFile` as its standard
 * input, or none. When `signal` aborts, the run is stopped: its program ends.
 */
export type RunTransport = (
  argv: readonly string[],
  stdinFile: string | null,
  signal?: AbortSignal
) => Promise<TransportRun>

export interface RemoteInstallDeps {
  run: RunTransport
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

export function createRemoteInstaller(deps: RemoteInstallDeps): RemoteInstaller {
  const plans = new Map<string, Plan>()
  const newId = deps.newId ?? randomUUID

  const runThere = (
    transport: HostTransport,
    line: string,
    stdinFile: string | null = null,
    signal?: AbortSignal
  ): Promise<TransportRun> =>
    signal === undefined
      ? deps.run([...transportArgv(transport), line], stdinFile)
      : deps.run([...transportArgv(transport), line], stdinFile, signal)

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
 * Runs a transport for real: the program and its arguments without a shell,
 * windowless, with `env` as it is (the user's ssh finds their config, keys and
 * agent), and a file piped to its standard input when one is given.
 */
export function spawnTransportRun(
  spawn: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true }
  ) => ChildProcess,
  env: NodeJS.ProcessEnv
): RunTransport {
  return (argv, stdinFile, signal) =>
    new Promise((done) => {
      const [program, ...args] = argv as [string, ...string[]]
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (run: TransportRun): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', stop)
        done(run)
      }
      const failedToRun = (error: unknown): TransportRun => ({
        code: null,
        stdout,
        stderr,
        error: couldNotRun(program, error),
        ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? { notFound: true } : {})
      })
      let child: ChildProcess | null = null
      // The run this PC started, by its own process: nothing else is stopped.
      const stop = (): void => {
        child?.kill()
      }
      if (signal?.aborted === true) {
        finish({ code: null, stdout, stderr })
        return
      }
      signal?.addEventListener('abort', stop, { once: true })
      try {
        child = spawn(program, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        finish(failedToRun(error))
        return
      }
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = (stdout + chunk.toString()).slice(-KEPT)
      })
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr = (stderr + chunk.toString()).slice(-KEPT)
      })
      child.once('error', (error) => finish(failedToRun(error)))
      child.once('close', (code: number | null) => finish({ code, stdout, stderr }))
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
