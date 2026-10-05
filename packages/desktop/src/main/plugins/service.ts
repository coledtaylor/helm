import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect, createServer } from 'node:net'
import { utilityProcess } from 'electron'
import { cmdShimArgs } from '@helm/core'
import type { NormalizedService } from '@helm/plugin-sdk/manifest'
import type { PluginLogLine, PluginServiceInfo } from '../../shared/ipc'
import { treeKill } from '../treekill'
import { PluginCallError } from './errors'
import { programEnv, resolveProgram } from './exec'
import { resolveInside } from './loader'

/**
 * A plugin's long-running process: started when it is first needed (or with
 * the plugin, for `start: "enable"`), watched, restarted after a crash with a
 * growing delay, and stopped - with everything it started - when the plugin is
 * disabled, reloaded or removed, or Helm quits.
 *
 * Every service is HTTP on loopback, whichever kind it is. It is told a free
 * port (`HELM_SERVICE_PORT`) and a token for this run (`HELM_SERVICE_TOKEN`),
 * and the plugin reaches it as `helm.fetch('service:/path')`, which Helm sends
 * there with the token in `Helm-Service-Token`. A port that is only on
 * 127.0.0.1 and a token that changes every run means nothing else on the
 * machine can drive it by guessing.
 *
 * A `node` service runs in Electron's own Node (`utilityProcess`), so a plugin
 * can ship one without the user installing Node. A `command` service is any
 * program.
 */

/** How long a service has to start listening. */
export const SERVICE_READY_MS = 20_000
/** Restart delays double from this, up to `BACKOFF_MAX_MS`. */
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** This many crashes inside `CRASH_WINDOW_MS` and Helm stops trying until the plugin is reloaded. */
export const CRASH_LIMIT = 5
const CRASH_WINDOW_MS = 60_000
/** A service that ran this long before crashing starts its backoff again from the bottom. */
const STABLE_MS = 30_000

/** A process a launcher started. */
export interface ServiceProcess {
  pid(): number | null
  onOutput(listener: (stream: 'out' | 'err', text: string) => void): void
  onExit(listener: (code: number | null) => void): void
  /** Ends it and everything it started. */
  kill(sync: boolean): void
}

export interface ServiceLaunch {
  kind: 'command' | 'node'
  /** The executable (`command`), or the script (`node`). */
  file: string
  args: string[]
  /** A batch file, run through `cmd.exe` - `file` is then cmd and `program` the batch file. */
  batch: boolean
  program: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** What Windows' Task Manager calls a utility process. */
  name: string
}

export type ServiceLauncher = (launch: ServiceLaunch) => ServiceProcess

/** Production: `utilityProcess` for a Node service, a child process for anything else. */
export const electronServiceLauncher: ServiceLauncher = (launch) => {
  if (launch.kind === 'node') {
    const child = utilityProcess.fork(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: 'pipe',
      serviceName: launch.name
    })
    return {
      pid: () => child.pid ?? null,
      onOutput: (listener) => {
        child.stdout?.on('data', (chunk: Buffer) => listener('out', chunk.toString('utf8')))
        child.stderr?.on('data', (chunk: Buffer) => listener('err', chunk.toString('utf8')))
      },
      onExit: (listener) => child.once('exit', (code) => listener(code)),
      kill: (sync) => {
        const pid = child.pid
        // Whatever the script spawned goes too; `kill()` alone ends only it.
        if (pid !== undefined) treeKill(pid, sync)
        child.kill()
      }
    }
  }
  return childProcessLauncher(launch)
}

/** A plain child process. Also what a test launches a `node` service with. */
export function childProcessLauncher(launch: ServiceLaunch): ServiceProcess {
  const file = launch.kind === 'node' ? process.execPath : launch.file
  const args =
    launch.kind === 'node'
      ? [launch.file, ...launch.args]
      : launch.batch
        ? cmdShimArgs(launch.program, launch.args)
        : launch.args
  const child = spawn(file, args, {
    cwd: launch.cwd,
    env: launch.kind === 'node' ? { ...launch.env, ELECTRON_RUN_AS_NODE: '1' } : launch.env,
    windowsHide: true,
    windowsVerbatimArguments: launch.batch,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exits: Array<(code: number | null) => void> = []
  let exited = false
  const done = (code: number | null): void => {
    if (exited) return
    exited = true
    for (const listener of exits) listener(code)
  }
  child.on('exit', (code) => done(code))
  child.on('error', () => done(null))
  return {
    pid: () => child.pid ?? null,
    onOutput: (listener) => {
      child.stdout.on('data', (chunk: Buffer) => listener('out', chunk.toString('utf8')))
      child.stderr.on('data', (chunk: Buffer) => listener('err', chunk.toString('utf8')))
    },
    onExit: (listener) => {
      exits.push(listener)
    },
    kill: (sync) => {
      if (child.pid !== undefined) treeKill(child.pid, sync)
      else child.kill()
    }
  }
}

export interface ServiceOptions {
  plugin: string
  dir: string
  spec: NormalizedService
  /** The declared environment with its secrets filled. Called at every start; may throw `PluginCallError`. */
  env: () => Record<string, string>
  launcher: ServiceLauncher
  onChange: () => void
  log: (line: Omit<PluginLogLine, 'at'>) => void
  /** The waits, shortened by a test that cannot sit through real ones. The app uses the defaults. */
  timing?: { readyMs?: number; backoffMinMs?: number; backoffMaxMs?: number } | undefined
}

export interface ServiceSupervisor {
  info(): Pick<PluginServiceInfo, 'state' | 'pid' | 'port' | 'restarts' | 'error'>
  /** Running and listening, starting it if it is not. Rejects with `PluginCallError('service')`. */
  ensure(): Promise<{ origin: string; token: string }>
  /** Starts it without waiting: `start: "enable"`. */
  start(): void
  /** Stops it and everything it started. Synchronous at quit, so nothing is left behind. */
  stop(sync: boolean): void
}

interface Waiter {
  resolve: (endpoint: { origin: string; token: string }) => void
  reject: (error: PluginCallError) => void
}

export function createServiceSupervisor(options: ServiceOptions): ServiceSupervisor {
  const { spec } = options
  const readyMs = options.timing?.readyMs ?? SERVICE_READY_MS
  const backoffMinMs = options.timing?.backoffMinMs ?? BACKOFF_MIN_MS
  const backoffMaxMs = options.timing?.backoffMaxMs ?? BACKOFF_MAX_MS
  let state: PluginServiceInfo['state'] = 'stopped'
  let error: string | null = null
  let restarts = 0
  let current: { process: ServiceProcess; port: number; token: string; startedAt: number } | null = null
  let endpoint: { origin: string; token: string } | null = null
  let restartTimer: NodeJS.Timeout | null = null
  let consecutive = 0
  let crashes: number[] = []
  /** Bumped by every launch and every stop, so a late event from an old process changes nothing. */
  let generation = 0
  let waiters: Waiter[] = []

  const set = (next: PluginServiceInfo['state'], problem: string | null = null): void => {
    state = next
    error = problem
    options.onChange()
  }
  const note = (text: string): void => options.log({ stream: 'helm', text })

  const settleWaiters = (outcome: { origin: string; token: string } | PluginCallError): void => {
    const pending = waiters
    waiters = []
    for (const waiter of pending) {
      if (outcome instanceof PluginCallError) waiter.reject(outcome)
      else waiter.resolve(outcome)
    }
  }

  const fail = (message: string): void => {
    note(message)
    set('failed', message)
    settleWaiters(new PluginCallError('service', message))
  }

  async function launch(): Promise<void> {
    const mine = ++generation
    set('starting')
    let env: Record<string, string>
    try {
      env = options.env()
    } catch (problem) {
      fail(`the service was not started: ${problem instanceof Error ? problem.message : String(problem)}`)
      return
    }

    let file: string
    let program: string
    let batch = false
    if (spec.kind === 'node') {
      const script = resolveInside(options.dir, spec.command)
      if (script === null || script === 'outside') {
        fail(`${spec.command} is not a file in the plugin folder`)
        return
      }
      file = script
      program = script
    } else {
      const resolved = resolveProgram(options.dir, spec.command)
      if (resolved === null) {
        fail(`${spec.command} was not found on this computer`)
        return
      }
      file = resolved.file
      program = resolved.program
      batch = resolved.batch
    }

    let port: number
    try {
      port = await freePort()
    } catch (problem) {
      fail(`no free port on 127.0.0.1: ${problem instanceof Error ? problem.message : String(problem)}`)
      return
    }
    if (mine !== generation) return
    const token = randomBytes(32).toString('hex')

    let child: ServiceProcess
    try {
      child = options.launcher({
        kind: spec.kind,
        file,
        args: spec.args,
        batch,
        program,
        cwd: options.dir,
        env: programEnv({
          ...env,
          HELM_SERVICE_PORT: String(port),
          HELM_SERVICE_TOKEN: token,
          HELM_PLUGIN_ID: options.plugin
        }),
        name: `Helm plugin ${options.plugin}`
      })
    } catch (problem) {
      fail(`the service could not be started: ${problem instanceof Error ? problem.message : String(problem)}`)
      return
    }
    current = { process: child, port, token, startedAt: Date.now() }
    note(`started ${program}, listening on 127.0.0.1:${String(port)}`)

    let partial = { out: '', err: '' }
    child.onOutput((stream, text) => {
      const lines = (partial[stream] + text).split(/\r?\n/)
      partial = { ...partial, [stream]: lines.pop() ?? '' }
      for (const line of lines) options.log({ stream, text: line })
    })
    child.onExit((code) => {
      for (const stream of ['out', 'err'] as const) {
        if (partial[stream] !== '') options.log({ stream, text: partial[stream] })
      }
      if (mine !== generation) return
      crashed(code)
    })

    const ready = await listening(port, readyMs, () => mine !== generation)
    if (mine !== generation) return
    if (!ready) {
      note(`it did not listen on 127.0.0.1:${String(port)} within ${String(readyMs / 1000)}s; stopping it`)
      child.kill(false)
      crashed(null)
      return
    }
    endpoint = { origin: `http://127.0.0.1:${String(port)}`, token }
    set('running')
    settleWaiters(endpoint)
  }

  function crashed(code: number | null): void {
    // Once per process: the exit of a process already counted as a failed start changes nothing.
    const last = current
    if (last === null) return
    generation += 1
    current = null
    endpoint = null
    const now = Date.now()
    if (now - last.startedAt >= STABLE_MS) consecutive = 0
    consecutive += 1
    crashes = [...crashes.filter((at) => now - at < CRASH_WINDOW_MS), now]
    const how = code === null ? 'stopped' : `exited with code ${String(code)}`
    if (crashes.length >= CRASH_LIMIT) {
      fail(`it ${how}, and has stopped ${String(CRASH_LIMIT)} times in a minute; Helm will not start it again until the plugin is reloaded`)
      return
    }
    const delay = Math.min(backoffMaxMs, backoffMinMs * 2 ** (consecutive - 1))
    note(`it ${how}; starting it again in ${String(delay / 1000)}s`)
    restarts += 1
    set('crashed', `it ${how}`)
    restartTimer = setTimeout(() => {
      restartTimer = null
      void launch()
    }, delay)
  }

  return {
    info: () => ({ state, pid: current?.process.pid() ?? null, port: current?.port ?? null, restarts, error }),

    ensure() {
      if (state === 'running' && endpoint !== null) return Promise.resolve(endpoint)
      if (state === 'failed') {
        return Promise.reject(new PluginCallError('service', `the service is not running: ${error ?? 'it failed'}`))
      }
      const waiting = new Promise<{ origin: string; token: string }>((resolve, reject) => {
        waiters.push({ resolve, reject })
      })
      if (state === 'stopped') void launch()
      return waiting
    },

    start() {
      if (state === 'stopped') void launch()
    },

    stop(sync) {
      generation += 1
      if (restartTimer !== null) clearTimeout(restartTimer)
      restartTimer = null
      const last = current
      current = null
      endpoint = null
      if (last !== null) {
        last.process.kill(sync)
        note('stopped')
      }
      if (state !== 'stopped') set('stopped')
      settleWaiters(new PluginCallError('unavailable', 'the service was stopped'))
    }
  }
}

/** A port nothing is listening on, for the service to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('no port was assigned'))))
    })
  })
}

/** Whether something accepts a connection on the port within the time, asking every 100ms. */
async function listening(port: number, withinMs: number, abandoned: () => boolean): Promise<boolean> {
  const until = Date.now() + withinMs
  while (Date.now() < until) {
    if (abandoned()) return false
    if (await accepts(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}
