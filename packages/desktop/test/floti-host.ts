import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { flotiBinary, type HostChild, type HostPlaces } from '../src/main/host/launcher'
import { startRemoteHost } from '../src/main/host/remote-launcher'
import type { LocalHost } from '../src/main/host/launcher'

/**
 * A real `floti host` in a test's own folders, reached as a host on another
 * computer through test/fake-ssh's custom-command transport (`carry.mjs`),
 * which runs the line it is given here. Needs the `floti` this checkout built:
 * a test using it runs only where `flotiAvailable` is true.
 */

export const REPO = resolve(import.meta.dirname, '../../..')

export const FLOTI_PLACES: HostPlaces = {
  appMode: 'dev',
  dataDir: REPO,
  packaged: false,
  resourcesPath: REPO,
  repoRoot: REPO,
  templatesDir: REPO,
  execPath: process.execPath,
  appPath: REPO
}

export const FLOTI = flotiBinary(FLOTI_PLACES, { platform: process.platform, env: process.env })
export const flotiAvailable = existsSync(FLOTI)
export const CARRY = join(REPO, 'test', 'fake-ssh', 'carry.mjs')

const LISTENING = /^Floti host is listening at /m

/** Every process a test started, ended when it ends, by its own pid. */
export const startedProcesses: HostChild[] = []

export function endStartedProcesses(): void {
  for (const child of startedProcesses.splice(0)) child.kill()
}

/**
 * The environment of a host whose folders are inside `root`, with `bin`
 * first on `PATH`, where the world's fake `claude` is.
 */
export function flotiEnv(root: string, base: Record<string, string>, bin?: string): NodeJS.ProcessEnv {
  const pathKey = Object.keys(base).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    ...base,
    ...(bin !== undefined ? { [pathKey]: `${bin}${delimiter}${base[pathKey] ?? ''}` } : {}),
    FLOTI_DATA_DIR: join(root, 'host', 'data'),
    FLOTI_LOG_DIR: join(root, 'host', 'logs'),
    FLOTI_CONFIG_DIR: join(root, 'host', 'config'),
    FLOTI_RUNTIME_DIR: join(root, 'run')
  }
}

/** Runs `floti` with `args` and `env` to its end: its exit status and what it wrote. */
export function runFloti(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(FLOTI, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', fail)
    child.once('exit', (code) => done({ code, stdout, stderr }))
    child.stdin.end(stdin ?? '')
  })
}

/** Starts `floti host` in `env`'s folders and resolves once it says it is listening. */
export async function startFlotiHost(env: NodeJS.ProcessEnv): Promise<HostChild & { exited: Promise<void> }> {
  const child = spawn(FLOTI, ['host'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  startedProcesses.push(child)
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  let said = ''
  await new Promise<void>((done, fail) => {
    child.stdout.on('data', (chunk: Buffer) => {
      said += chunk.toString()
      if (LISTENING.test(said)) done()
    })
    child.once('error', fail)
    void exited.then(() => fail(new Error(`floti host exited before listening: ${said}`)))
  })
  return Object.assign(child, { exited })
}

/** Stops the host in `env`'s folders and waits for it to exit. */
export async function stopFlotiHost(host: { exited: Promise<void> }, env: NodeJS.ProcessEnv): Promise<void> {
  const stopped = await runFloti(['update-stop', '--stop'], env)
  if (stopped.code !== 0) throw new Error(`floti update-stop --stop failed: ${stopped.stderr}`)
  await host.exited
}

/**
 * Connects to the host in `env`'s folders the way Helm reaches a host on
 * another computer: `floti bridge` through `carry.mjs`, with this device's
 * keys in `folder`, pinning the host's key the first time.
 */
export function connectThroughCarry(env: NodeJS.ProcessEnv, folder: string): Promise<LocalHost> {
  return startRemoteHost(
    FLOTI_PLACES,
    {
      platform: process.platform,
      env: { ...env, FAKE_SSH_FLOTI: FLOTI },
      exists: existsSync,
      spawn: (command, args, options) => {
        const child = spawn(command, args, options)
        startedProcesses.push(child)
        return child
      },
      appVersion: '0.0.0',
      log: () => undefined
    },
    {
      folder,
      transport: { kind: 'command', program: process.execPath, args: [CARRY] },
      deviceName: 'this pc'
    }
  )
}
