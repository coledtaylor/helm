import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { flotiBinary, type HostChild, type HostPlaces } from './launcher'
import { RemoteHostError, startRemoteHost } from './remote-launcher'

/**
 * Reaching a host on another computer through the user's own login, against
 * the real thing: the `floti` this checkout built, a `floti host` in this
 * test's own folders standing for the host on another computer, and
 * test/fake-ssh's custom-command transport (`carry.mjs`) standing for ssh,
 * which runs each line it is given here.
 *
 * It needs the built binary, which the Rust jobs build and the TypeScript
 * jobs do not, so it runs where `floti` has been built and is skipped
 * elsewhere; the host crate's bridge tests prove the bridge's side of the
 * same pinning on every OS.
 */

const REPO = resolve(import.meta.dirname, '../../../../..')
const PLACES: HostPlaces = {
  appMode: 'dev',
  dataDir: REPO,
  packaged: false,
  resourcesPath: REPO,
  repoRoot: REPO,
  templatesDir: REPO,
  execPath: process.execPath,
  appPath: REPO
}
const FLOTI = flotiBinary(PLACES, {
  platform: process.platform,
  env: process.env
})
const CARRY = join(REPO, 'test', 'fake-ssh', 'carry.mjs')
const LISTENING = /^Floti host is listening at /m

/** Every process this test started, ended when it ends, by its own pid. */
const started: HostChild[] = []
afterEach(() => {
  for (const child of started.splice(0)) child.kill()
})

/** Runs `floti` with `args` and `env` to its end; its exit status and standard error. */
function floti(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(FLOTI, args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', fail)
    child.once('exit', (code) => done({ code, stderr }))
  })
}

/** Starts `floti host` in `env`'s folders and resolves once it says it is listening. */
async function startHost(env: NodeJS.ProcessEnv): Promise<HostChild & { exited: Promise<void> }> {
  const child = spawn(FLOTI, ['host'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  started.push(child)
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

/** The lines the transport was given to run on the host's computer, in order. */
function transportRuns(log: string): string[] {
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { line: string }).line)
}

describe.runIf(existsSync(FLOTI))(
  'reaching a host on another computer through floti, the login being the access',
  () => {
    it(
      'S4, S7, S8: connects at once and pins the host key, refuses a host proving another key as changed, and pins the new one once removed and added again',
      { timeout: PATIENCE * 4 },
      async () => {
        const root = await mkdtemp(join(inject(RUN_ROOT), 'login is the access '))
        const home = join(root, 'home')
        await mkdir(home, { recursive: true })
        const hostEnv = (data: string): NodeJS.ProcessEnv => ({
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          FLOTI_DATA_DIR: join(root, data, 'data'),
          FLOTI_LOG_DIR: join(root, data, 'logs'),
          FLOTI_CONFIG_DIR: join(root, data, 'config'),
          FLOTI_RUNTIME_DIR: join(root, 'run')
        })
        const transportLog = join(root, 'transport.jsonl')
        const folder = join(root, 'this pc')
        const connect = (env: NodeJS.ProcessEnv) =>
          startRemoteHost(
            PLACES,
            {
              platform: process.platform,
              // What the login on the other side sees: the host's folders, and
              // which floti to run there.
              env: {
                ...env,
                FAKE_SSH_FLOTI: FLOTI,
                FAKE_SSH_LOG: transportLog
              },
              exists: existsSync,
              spawn: (command, args, options) => {
                const child = spawn(command, args, options)
                started.push(child)
                return child
              },
              appVersion: '0.0.0',
              log: () => undefined
            },
            {
              folder,
              transport: {
                kind: 'command',
                program: process.execPath,
                args: [CARRY]
              },
              deviceName: 'my laptop'
            }
          )

        // S4: the first connection is welcomed and pins the key, with nothing
        // approved, typed or run there beyond floti connect.
        const first = hostEnv('first')
        const host = await startHost(first)
        const connected = await connect(first)
        expect(connected.connection.welcome.away).toBe(true)
        expect(connected.connection.welcome).not.toHaveProperty('role')
        expect(transportRuns(transportLog).every((line) => line.startsWith('floti connect'))).toBe(true)
        await connected.close()
        // The next connection is the same pinned host.
        const again = await connect(first)
        await again.close()
        expect(transportRuns(transportLog).every((line) => line.startsWith('floti connect'))).toBe(true)
        const stopped = await floti(['update-stop', '--stop'], first)
        expect(stopped.code, stopped.stderr).toBe(0)
        await host.exited

        // S7: a host proving another key there is refused as a changed key.
        const second = hostEnv('second')
        const other = await startHost(second)
        const refused = await connect(second).then(
          () => null,
          (error: unknown) => error
        )
        expect(refused).toBeInstanceOf(RemoteHostError)
        expect((refused as RemoteHostError).keyChanged).toBe(true)

        // S8: removed (its client folder forgotten) and added again, it pins the new key.
        await rm(folder, { recursive: true, force: true })
        const readded = await connect(second)
        expect(readded.connection.welcome.away).toBe(true)
        await readded.close()

        const stoppedOther = await floti(['update-stop', '--stop'], second)
        expect(stoppedOther.code, stoppedOther.stderr).toBe(0)
        await other.exited
      }
    )
  }
)
