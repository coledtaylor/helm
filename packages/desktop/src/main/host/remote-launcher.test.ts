import type { HostTransport } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeChild, connects, type Program } from '../../../test/fake-child'
import { FrameDecoder, encodeFrame } from './frame'
import { BRIDGE_EXIT, type HostPlaces } from './launcher'
import {
  KEY_CHANGED_LINE,
  RemoteHostError,
  openRemotePageBridge,
  remoteClientFolder,
  startRemoteHost,
  type RemoteLauncherDeps
} from './remote-launcher'

const PLACES: HostPlaces = {
  appMode: 'dev',
  dataDir: 'C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data',
  packaged: false,
  resourcesPath: 'C:\\Program Files\\Helm\\resources',
  repoRoot: 'C:\\src\\my helm',
  templatesDir: 'C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\templates',
  execPath: 'C:\\src\\my helm\\node_modules\\electron\\dist\\electron.exe',
  appPath: 'C:\\src\\my helm\\packages\\desktop'
}
const FLOTI = 'C:\\src\\my helm\\target\\debug\\floti.exe'
const FOLDER = 'C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\remote-hosts\\0123456789abcdef'
const SSH: HostTransport = { kind: 'ssh', target: 'me@build-box' }
const COMMAND: HostTransport = {
  kind: 'command',
  program: 'C:\\Windows\\System32\\wsl.exe',
  args: ['-d', 'Ubuntu 24.04', '--']
}

/** The user's own environment, which the bridge and its ssh get as it is. */
const USER_ENV = { PATH: 'C:\\Windows', SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent' }

function world(programs: Program[]) {
  const spawned: FakeChild[] = []
  /** Everything written on each bridge's standard input, from the start. */
  const input: Uint8Array[][] = []
  const log: string[] = []
  const deps: RemoteLauncherDeps = {
    platform: 'win32',
    env: USER_ENV,
    exists: () => true,
    spawn: (command, args, options) => {
      const child = new FakeChild(command, args, options)
      spawned.push(child)
      const written: Uint8Array[] = []
      input.push(written)
      child.stdin.on('data', (chunk: Uint8Array) => written.push(chunk))
      const program = programs.shift()
      if (program === undefined) throw new Error(`nothing scripted for ${args.join(' ')}`)
      program(child)
      return child
    },
    appVersion: '2.4.0',
    log: (line) => log.push(line)
  }
  return { deps, spawned, input, log }
}

/** A bridge whose transport wrote `lines` on standard error and ended with `code`. */
const endsWith =
  (code: number, ...lines: string[]): Program =>
  (child) => {
    for (const line of lines) child.stderr.write(`${line}\r\n`)
    queueMicrotask(() => child.exit(code))
  }

async function remoteError(promise: Promise<unknown>): Promise<RemoteHostError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(RemoteHostError)
  return error as RemoteHostError
}

describe('reaching a host on another computer', () => {
  it('S6: runs the user’s own ssh in batch mode with the target as typed and adds no other option', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my laptop'
    })

    const [bridge] = w.spawned
    expect(bridge?.command).toBe(FLOTI)
    expect(bridge?.args).toEqual(['bridge', FOLDER, '--', 'ssh', '-o', 'BatchMode=yes', 'me@build-box'])
    // Nothing that would skip a host-key check, and no file of the user's named.
    expect(bridge?.args.join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile|known_hosts|IdentityFile|\.ssh/)
    // The user's environment as it is: their agent, their PATH; no Floti folders of this run.
    expect(bridge?.options.env).toBe(USER_ENV)
    expect(bridge?.options.windowsHide).toBe(true)
    expect(host.startedHost).toBe(false)
    await host.close()
  })

  it('S6: types nothing into the transport: all the bridge is given is protocol frames', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my laptop'
    })
    await host.close()
    const decoder = new FrameDecoder()
    for (const chunk of w.input[0] ?? []) decoder.push(chunk)
    const frames: string[] = []
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      frames.push('message' in next ? next.message.type : 'not a frame')
    }
    // The hello, and nothing a person would type: no password, no yes.
    expect(frames).toEqual(['hello'])
  })

  it('S4: runs a custom command as its program and arguments, with no shell', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: COMMAND,
      deviceName: 'my laptop'
    })
    expect(w.spawned[0]?.args).toEqual([
      'bridge',
      FOLDER,
      '--',
      'C:\\Windows\\System32\\wsl.exe',
      '-d',
      'Ubuntu 24.04',
      '--'
    ])
    expect(w.spawned[0]?.options).not.toHaveProperty('shell')
    await host.close()
  })

  it.each([
    ['a password', 'me@build-box: Permission denied (publickey,password).'],
    ['a host key to accept', 'Host key verification failed.'],
    ['a host it cannot reach', 'ssh: connect to host build-box port 22: Connection timed out'],
    ['a name it cannot resolve', 'ssh: Could not resolve hostname build-box: No such host is known. ']
  ])('S6: ssh that needs %s fails with its last line, unedited', async (_need, line) => {
    const w = world([endsWith(BRIDGE_EXIT.transportEnded, 'debug: an earlier line', line)])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, {
        folder: FOLDER,
        transport: SSH,
        deviceName: 'my laptop'
      })
    )
    expect(error.lastLine).toBe(line)
  })

  it('says that no Floti host runs there in floti connect’s own words', async () => {
    const w = world([endsWith(BRIDGE_EXIT.unreachable, 'floti connect: no Floti host is running there.')])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, {
        folder: FOLDER,
        transport: SSH,
        deviceName: 'my laptop'
      })
    )
    expect(error.lastLine).toBe('floti connect: no Floti host is running there.')
  })

  it('S4: a window’s own bridge goes through the same transport and the same client folder', async () => {
    const w = world([endsWith(BRIDGE_EXIT.transportEnded, 'Connection to build-box closed by remote host.')])
    const bridge = openRemotePageBridge(PLACES, w.deps, { folder: FOLDER, transport: SSH }, () => undefined)
    expect(w.spawned[0]?.args).toEqual(['bridge', FOLDER, '--', 'ssh', '-o', 'BatchMode=yes', 'me@build-box'])
    await expect(bridge.ended).resolves.toBe('Connection to build-box closed by remote host.')
  })

  it('S7: a host that proves another key than the one pinned is said to have changed its key, in the bridge’s own words', async () => {
    const line = 'floti bridge: the host proved key SHA256:new, not SHA256:pinned, which this client pinned for it.'
    const w = world([endsWith(BRIDGE_EXIT.hostNotProven, line)])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, {
        folder: FOLDER,
        transport: SSH,
        deviceName: 'my laptop'
      })
    )
    expect(error.keyChanged).toBe(true)
    expect(error.lastLine).toBe(line)
    // With nothing written, it still says the key changed.
    const quiet = world([endsWith(BRIDGE_EXIT.hostNotProven)])
    const said = await remoteError(
      startRemoteHost(PLACES, quiet.deps, {
        folder: FOLDER,
        transport: SSH,
        deviceName: 'my laptop'
      })
    )
    expect(said).toMatchObject({
      keyChanged: true,
      lastLine: KEY_CHANGED_LINE
    })
    // Any other failure is no changed key.
    const other = world([endsWith(BRIDGE_EXIT.transportEnded, 'Host key verification failed.')])
    expect(
      (
        await remoteError(
          startRemoteHost(PLACES, other.deps, {
            folder: FOLDER,
            transport: SSH,
            deviceName: 'my laptop'
          })
        )
      ).keyChanged
    ).toBe(false)
  })

  it('S4: names this device with the computer’s name in its hello, and passes the bridge nothing but its folder and the transport', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my-laptop'
    })
    await host.close()
    const decoder = new FrameDecoder()
    for (const chunk of w.input[0] ?? []) decoder.push(chunk)
    const first = decoder.next()
    expect(
      first !== null && 'message' in first && first.message.type === 'hello' ? first.message.client : null
    ).toEqual({
      name: 'Helm 2.4.0',
      kind: 'desktop',
      deviceName: 'my-laptop'
    })
    expect(w.spawned[0]?.args.join(' ')).not.toMatch(/--pair|--approve|devices/)
  })

  it('keeps each host’s keys in a folder of its own inside Helm’s data, whatever its id', () => {
    const one = remoteClientFolder(PLACES, 'win32', 'h-build')
    const other = remoteClientFolder(PLACES, 'win32', '..\\..\\escape')
    expect(one).toMatch(/^C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\remote-hosts\\[0-9a-f]{16}$/)
    expect(other).toMatch(/^C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\remote-hosts\\[0-9a-f]{16}$/)
    expect(one).not.toBe(other)
    expect(remoteClientFolder(PLACES, 'win32', 'h-build')).toBe(one)
  })
})

describe('the floti a host keeps, and a host that refuses this Helm', () => {
  it('S16: gives the bridge the full path of the floti Helm installed there, before the transport', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      floti: '/home/me/.local/bin/floti',
      deviceName: 'my laptop'
    })
    expect(w.spawned[0]?.args).toEqual([
      'bridge',
      FOLDER,
      '--floti',
      '/home/me/.local/bin/floti',
      '--',
      'ssh',
      '-o',
      'BatchMode=yes',
      'me@build-box'
    ])
    await host.close()
  })

  it('S18: a host that refuses the hello hands on both protocol versions and the side to update', async () => {
    const refuses: Program = (child) => {
      const decoder = new FrameDecoder()
      child.stdin.on('data', (chunk: Uint8Array) => {
        decoder.push(chunk)
        for (let next = decoder.next(); next !== null; next = decoder.next()) {
          if ('message' in next && next.message.type === 'hello') {
            child.stdout.write(
              encodeFrame({
                type: 'refused',
                host: { major: 0, minor: 9 },
                client: { major: 1, minor: 0 },
                update: 'host',
                message: 'This host speaks protocol 0.9 and Helm speaks 1.0: update floti there.'
              })
            )
          }
        }
      })
      child.stdin.once('end', () => child.exit(BRIDGE_EXIT.closed))
    }
    const w = world([refuses])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, {
        folder: FOLDER,
        transport: SSH,
        deviceName: 'my laptop'
      })
    )
    expect(error.refused).toEqual({ host: '0.9', client: '1.0', update: 'host' })
  })
})
