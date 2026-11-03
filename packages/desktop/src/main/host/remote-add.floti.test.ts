import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import type { HostTransport, RemoteHost } from '@helm/core/types'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { flotiBinary, type HostChild, type HostPlaces, type LocalHost } from './launcher'
import { createClientFolderRemoteAdder } from './remote-add'
import { remoteClientFolder, startRemoteHost } from './remote-launcher'

/**
 * Adding a host on another computer, the whole way, against the real thing:
 * main's adder (`createClientFolderRemoteAdder`, the one `desktop.ts` uses)
 * connects through the `floti` this checkout built, in the new host's own
 * client folder under a data directory in this test's folder, to a
 * `floti host` in this test's own folders standing for the host on another
 * computer, reached through test/fake-ssh's custom-command transport
 * (`carry.mjs`), which runs each line it is given here.
 *
 * It needs the built binary, which the Rust jobs build and the TypeScript
 * jobs do not, so it runs where `floti` has been built and is skipped
 * elsewhere; `remote-add.test.ts` proves the adder's steps on every OS.
 */

const REPO = resolve(import.meta.dirname, '../../../../..')
const BUILT: HostPlaces = {
  appMode: 'dev',
  dataDir: REPO,
  packaged: false,
  resourcesPath: REPO,
  repoRoot: REPO,
  templatesDir: REPO,
  execPath: process.execPath,
  appPath: REPO
}
const FLOTI = flotiBinary(BUILT, { platform: process.platform, env: process.env })
const CARRY = join(REPO, 'test', 'fake-ssh', 'carry.mjs')
const LISTENING = /^Floti host is listening at /m
const TRANSPORT: HostTransport = { kind: 'command', program: process.execPath, args: [CARRY] }

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

/** The lines the transport was given to run on the host's computer, in order. */
function transportRuns(log: string): string[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (JSON.parse(line) as { line: string }).line)
}

describe.runIf(existsSync(FLOTI))('adding a host on another computer by connecting to it, through floti', () => {
  it(
    'S2, S5, S8: Add connects through the command, pins the key in the host’s own client folder and hands the connection on; a host that cannot be reached adds nothing and leaves no folder; removed and added again, it pins afresh',
    { timeout: PATIENCE * 4 },
    async () => {
      const root = await mkdtemp(join(inject(RUN_ROOT), 'adding a host '))
      const home = join(root, 'home')
      await mkdir(home, { recursive: true })
      const dataDir = join(root, 'helm data')
      const places: HostPlaces = { ...BUILT, dataDir }
      const transportLog = join(root, 'transport.jsonl')
      const hostEnv = (name: string): NodeJS.ProcessEnv => ({
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FLOTI_DATA_DIR: join(root, name, 'data'),
        FLOTI_LOG_DIR: join(root, name, 'logs'),
        FLOTI_CONFIG_DIR: join(root, name, 'config'),
        FLOTI_RUNTIME_DIR: join(root, 'run')
      })
      const ids = ['h-first', 'h-unreachable', 'h-again']
      const hosts: RemoteHost[] = []
      const adderFor = (env: NodeJS.ProcessEnv) =>
        createClientFolderRemoteAdder({
          places,
          launcher: {
            platform: process.platform,
            // What the login on the other side sees: the host's folders, and
            // which floti to run there.
            env: { ...env, FAKE_SSH_FLOTI: FLOTI, FAKE_SSH_LOG: transportLog },
            exists: existsSync,
            spawn: (command, args, options) => {
              const child = spawn(command, args, options)
              started.push(child)
              return child
            },
            appVersion: '0.0.0',
            log: () => undefined
          },
          deviceName: 'my laptop',
          hosts: () => hosts,
          log: () => undefined,
          newId: () => ids.shift() ?? 'h-extra'
        })
      const folderOf = (id: string) => remoteClientFolder(places, process.platform, id)
      const kept: { host: RemoteHost; connected: LocalHost }[] = []
      const keep = (host: RemoteHost, connected: LocalHost) => {
        hosts.push(host)
        kept.push({ host, connected })
      }

      // S5: the add connects, pins the host's key in its own client folder,
      // and only then hands the host and its connection on, with no pairing.
      const first = hostEnv('first')
      const host = await startHost(first)
      const added = await adderFor(first).add({ attempt: 'a1', name: 'build-box', transport: TRANSPORT }, keep)
      expect(added.kind).toBe('added')
      if (added.kind !== 'added') return
      expect(added.host).toEqual({ id: 'h-first', name: 'build-box', transport: TRANSPORT })
      expect(added.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(added).not.toHaveProperty('role')
      expect(kept.map((entry) => entry.host.id)).toEqual(['h-first'])
      const link = kept[0]!.connected
      expect(link.connection.welcome).not.toHaveProperty('role')
      expect(existsSync(folderOf('h-first'))).toBe(true)
      // Nothing ran there but floti connect.
      expect(transportRuns(transportLog).every((line) => line.startsWith('floti connect'))).toBe(true)
      await link.close()
      // The link connects to the same pinned host from that folder.
      const again = await startRemoteHost(
        places,
        {
          platform: process.platform,
          env: { ...first, FAKE_SSH_FLOTI: FLOTI, FAKE_SSH_LOG: transportLog },
          exists: existsSync,
          spawn: (command, args, options) => {
            const child = spawn(command, args, options)
            started.push(child)
            return child
          },
          appVersion: '0.0.0',
          log: () => undefined
        },
        { folder: folderOf('h-first'), transport: TRANSPORT, deviceName: 'my laptop' }
      )
      await again.close()
      const stopped = await floti(['update-stop', '--stop'], first)
      expect(stopped.code, stopped.stderr).toBe(0)
      await host.exited

      // S8: with no host running there, the add fails with floti's own last
      // line, hands nothing on and leaves no client folder behind.
      const failed = await adderFor(first).add({ attempt: 'a2', name: 'lab', transport: TRANSPORT }, keep)
      expect(failed.kind).toBe('failed')
      if (failed.kind === 'failed') expect(failed.lastLine).not.toBe('')
      expect(kept).toHaveLength(1)
      expect(existsSync(folderOf('h-unreachable'))).toBe(false)

      // S2: removed (its client folder forgotten), the same computer now
      // proving another key is added again and pinned afresh.
      hosts.splice(0)
      await rm(folderOf('h-first'), { recursive: true, force: true })
      const second = hostEnv('second')
      const other = await startHost(second)
      const readded = await adderFor(second).add({ attempt: 'a3', name: 'build-box', transport: TRANSPORT }, keep)
      expect(readded.kind).toBe('added')
      await kept[1]?.connected.close()
      // Only the host now added has a client folder here.
      expect(readdirSync(join(dataDir, 'remote-hosts'))).toEqual([basename(folderOf('h-again'))])
      const stoppedOther = await floti(['update-stop', '--stop'], second)
      expect(stoppedOther.code, stoppedOther.stderr).toBe(0)
      await other.exited
    }
  )
})
