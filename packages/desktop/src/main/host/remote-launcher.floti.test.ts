import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { flotiBinary, type HostChild, type HostPlaces } from './launcher'
import { startRemoteHost } from './remote-launcher'

/**
 * The desktop's one-step pairing against the real thing: the `floti` this
 * checkout built, a `floti host` in this test's own folders standing for the
 * host on another computer, and test/fake-ssh's custom-command transport
 * (`carry.mjs`) standing for ssh, which runs each line it is given here.
 *
 * It needs the built binary, which the Rust jobs build and the TypeScript
 * jobs do not, so it runs where `floti` has been built and is skipped
 * elsewhere; crates/host/tests/roles.rs proves the bridge's side of the same
 * pairing on every OS.
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
const FLOTI = flotiBinary(PLACES, { platform: process.platform, env: process.env })
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
    const child = spawn(FLOTI, args, { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.once('error', fail)
    child.once('exit', (code) => done({ code, stderr }))
  })
}

/** Starts `floti host` in `env`'s folders and resolves once it says it is listening. */
async function startHost(env: NodeJS.ProcessEnv): Promise<HostChild & { exited: Promise<void> }> {
  const child = spawn(FLOTI, ['host'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
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

describe.runIf(existsSync(FLOTI))('pairing with a host on another computer in one step, through floti', () => {
  it(
    'S6: the bridge Helm starts approves this device with the role picked through the same command, pins the host and connects as admin, the code in no command line or log',
    { timeout: PATIENCE * 3 },
    async () => {
      const root = await mkdtemp(join(inject(RUN_ROOT), 'one step pairing '))
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const hostEnv: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FLOTI_DATA_DIR: join(root, 'host', 'data'),
        FLOTI_LOG_DIR: join(root, 'host', 'logs'),
        FLOTI_CONFIG_DIR: join(root, 'host', 'config'),
        FLOTI_RUNTIME_DIR: join(root, 'run')
      }
      const host = await startHost(hostEnv)

      const transportLog = join(root, 'transport.jsonl')
      const appLog: string[] = []
      const codes: Array<[string, string | null]> = []
      const folder = join(root, 'this pc')
      const connected = await startRemoteHost(
        PLACES,
        {
          platform: process.platform,
          // What the login on the other side sees: the host's folders, and
          // which floti to run there.
          env: { ...hostEnv, FAKE_SSH_FLOTI: FLOTI, FAKE_SSH_LOG: transportLog },
          exists: existsSync,
          spawn: (command, args, options) => {
            const child = spawn(command, args, options)
            started.push(child)
            return child
          },
          appVersion: '0.0.0',
          log: (line) => appLog.push(line)
        },
        {
          folder,
          transport: { kind: 'command', program: process.execPath, args: [CARRY] },
          deviceName: 'my laptop',
          approve: 'admin',
          onPairing: (code, approvalFailed) => codes.push([code, approvalFailed])
        }
      )

      // Paired in the same step, as an admin, with nobody typing on the host.
      expect(connected.connection.welcome.role).toBe('admin')
      expect(connected.connection.welcome.away).toBe(true)
      expect(codes.length).toBe(1)
      const [[code, failed]] = codes as [[string, string | null]]
      expect(failed).toBeNull()
      const runs = readFileSync(transportLog, 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { line: string }).line)
      expect(runs).toContain('floti devices approve - --role admin')
      expect(readFileSync(transportLog, 'utf8')).not.toContain(code)
      expect(appLog.join('\n')).not.toContain(code)
      await connected.close()

      // Its key is pinned: the next connection is itself, asking nothing.
      const again = await startRemoteHost(
        PLACES,
        {
          platform: process.platform,
          env: { ...hostEnv, FAKE_SSH_FLOTI: FLOTI, FAKE_SSH_LOG: transportLog },
          exists: existsSync,
          spawn: (command, args, options) => {
            const child = spawn(command, args, options)
            started.push(child)
            return child
          },
          appVersion: '0.0.0',
          log: (line) => appLog.push(line)
        },
        {
          folder,
          transport: { kind: 'command', program: process.execPath, args: [CARRY] },
          deviceName: 'my laptop',
          approve: 'admin',
          onPairing: (next) => codes.push([next, null])
        }
      )
      expect(again.connection.welcome.role).toBe('admin')
      expect(codes.length).toBe(1)
      await again.close()

      // The host stops as an admin's update-stop stops it, keeper and all.
      const stopped = await floti(['update-stop', folder, '--stop'], hostEnv)
      expect(stopped.code, stopped.stderr).toBe(0)
      await host.exited
    }
  )
})
