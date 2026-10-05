import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { cmdShimArgs, isBatchFile } from '@helm/core'
import type { ExecResult } from '@helm/plugin-sdk'
import type { NormalizedExec } from '@helm/plugin-sdk/manifest'
import { isExecutableFile, searchPath } from '../claude-cli'
import { treeKill } from '../treekill'
import { PluginCallError } from './errors'
import { resolveInside } from './loader'

/**
 * `helm.exec`: a program the manifest names, run with the arguments the page
 * passes and no shell.
 *
 * The manifest is the whole of what can run. A page names a program by the
 * key it has in `exec`, never by a path or a command line, and its arguments
 * go to the program as an array - so text a user typed into a plugin's form
 * is an argument, never a command. The one place a line is composed is a
 * batch file, which Windows can only run through `cmd.exe`, and that goes
 * through the same quoting every other batch file Helm runs does
 * (`cmdShimArgs`).
 *
 * This is the edge of the sandbox: what runs here runs with the user's rights,
 * which is why a plugin that declares a program says so in Settings.
 */

export const EXEC_TIMEOUT_DEFAULT_MS = 60_000
export const EXEC_TIMEOUT_MAX_MS = 600_000
/** Each of stdout and stderr; past this the program is stopped. */
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024
const STDIN_MAX_BYTES = 16 * 1024 * 1024
const ARGS_MAX = 256

/**
 * What a plugin's program inherits: the user's environment, less what Helm's
 * own process carries that no program of the user's should - Electron's
 * switches, a dev server's address, and the markers that make a `claude`
 * started underneath believe it is a nested session.
 */
export function programEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(ELECTRON_|VITE_|CLAUDE)/i.test(name) || name === 'NODE_OPTIONS' || name === 'NODE_ENV') continue
    env[name] = value
  }
  return { ...env, ...extra }
}

/** How a program is started: the executable and the arguments that come before the page's. */
export interface ResolvedProgram {
  file: string
  /** The file the user would recognise: the batch file, when `file` is `cmd.exe`. */
  program: string
  batch: boolean
}

/**
 * A program as the manifest names it: a path relative to the plugin folder
 * (it has a slash), an absolute path, or a name looked up on PATH the way a
 * terminal would. Null when there is no such program.
 */
export function resolveProgram(dir: string, command: string): ResolvedProgram | null {
  let program: string | null
  if (isAbsolute(command)) {
    program = isExecutableFile(command) ? command : null
  } else if (/[\\/]/.test(command)) {
    const inside = resolveInside(dir, command)
    program = inside === null || inside === 'outside' ? null : inside
  } else {
    program = searchPath(command)
  }
  if (program === null) return null
  return isBatchFile(program)
    ? { file: process.env['COMSPEC'] ?? 'cmd.exe', program, batch: true }
    : { file: program, program, batch: false }
}

export interface ExecRequest {
  args: string[]
  stdin: string | null
  timeoutMs: number
}

/** The page's arguments to `helm.exec`, checked: they came from a page. */
export function readExecRequest(args: unknown, options: unknown): ExecRequest {
  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0')))) {
    throw new PluginCallError('invalid', 'exec arguments must be an array of strings')
  }
  const list = (args ?? []) as string[]
  if (list.length > ARGS_MAX) throw new PluginCallError('invalid', `exec takes at most ${String(ARGS_MAX)} arguments`)
  let stdin: string | null = null
  let timeoutMs = EXEC_TIMEOUT_DEFAULT_MS
  if (options !== undefined && options !== null) {
    if (typeof options !== 'object') throw new PluginCallError('invalid', 'exec options must be an object')
    const record = options as Record<string, unknown>
    if (record['stdin'] !== undefined) {
      if (typeof record['stdin'] !== 'string') throw new PluginCallError('invalid', 'stdin must be a string')
      if (Buffer.byteLength(record['stdin']) > STDIN_MAX_BYTES) throw new PluginCallError('invalid', 'stdin is too large')
      stdin = record['stdin']
    }
    if (record['timeoutMs'] !== undefined) {
      const value = record['timeoutMs']
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new PluginCallError('invalid', 'timeoutMs must be a positive number')
      }
      timeoutMs = Math.min(EXEC_TIMEOUT_MAX_MS, value)
    }
  }
  return { args: list, stdin, timeoutMs }
}

/**
 * Runs one declared program to completion.
 *
 * Resolves with what it wrote and how it ended - a non-zero exit is an answer,
 * not a failure. Rejects only when it could not be run (`not-found`), when the
 * page cancelled it (`aborted`), or when it wrote more than Helm will hold. A
 * timeout stops the whole tree and resolves with `timedOut`.
 */
export function runProgram(options: {
  dir: string
  spec: NormalizedExec
  env: Record<string, string>
  request: ExecRequest
  signal: AbortSignal
}): Promise<ExecResult> {
  const { dir, spec, request, signal } = options
  // An abort that came first never fires its event again: start nothing.
  if (signal.aborted) return Promise.reject(new PluginCallError('aborted', 'the program was cancelled'))
  const resolved = resolveProgram(dir, spec.command)
  if (resolved === null) {
    return Promise.reject(new PluginCallError('not-found', `${spec.command} was not found on this computer`))
  }
  const args = [...spec.args, ...request.args]

  return new Promise<ExecResult>((resolvePromise, reject) => {
    const child = spawn(resolved.file, resolved.batch ? cmdShimArgs(resolved.program, args) : args, {
      cwd: dir,
      env: programEnv(options.env),
      windowsHide: true,
      windowsVerbatimArguments: resolved.batch,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let sizes = { out: 0, err: 0 }
    let ended = false
    let timedOut = false
    let failure: PluginCallError | null = null

    const stop = (): void => {
      if (child.pid !== undefined) treeKill(child.pid, false)
      else child.kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, request.timeoutMs)
    const onAbort = (): void => {
      failure = new PluginCallError('aborted', 'the program was cancelled')
      stop()
    }
    signal.addEventListener('abort', onAbort)

    const collect = (stream: 'out' | 'err', into: Buffer[]) => (chunk: Buffer) => {
      sizes = { ...sizes, [stream]: sizes[stream] + chunk.length }
      if (sizes[stream] > OUTPUT_MAX_BYTES) {
        failure ??= new PluginCallError('invalid', `the program wrote more than ${String(OUTPUT_MAX_BYTES / 1024 / 1024)} MB`)
        stop()
        return
      }
      into.push(chunk)
    }
    child.stdout.on('data', collect('out', stdout))
    child.stderr.on('data', collect('err', stderr))
    // A program that exits without reading its input closes the pipe under
    // the write; that is the program's business, not an error here.
    child.stdin.on('error', () => undefined)
    if (request.stdin !== null) child.stdin.end(request.stdin)
    else child.stdin.end()

    const finish = (exitCode: number | null): void => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (failure !== null) {
        reject(failure)
        return
      }
      resolvePromise({
        exitCode: timedOut ? null : exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut
      })
    }
    child.on('error', (error) => {
      failure ??= new PluginCallError('not-found', `${spec.command} could not be started: ${error.message}`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

