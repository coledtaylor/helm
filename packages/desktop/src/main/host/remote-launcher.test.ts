import type { HostTransport } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeChild, connects, type Program } from '../../../test/fake-child'
import { FrameDecoder } from './frame'
import { BRIDGE_EXIT, type HostPlaces } from './launcher'
import {
  RemoteHostError,
  openRemotePageBridge,
  pairingCodeOf,
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
const PAIRING_LINE =
  'floti bridge: pairing code 7Q2K-9XZD, expires in 600 seconds: run "floti devices approve 7Q2K-9XZD" on the host.'

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

/**
 * A bridge that says it is waiting for approval and answers nothing until
 * `approved` settles, then connects: the hello waits in the pipe meanwhile.
 */
const pairsThen =
  (approved: Promise<void>): Program =>
  (child) => {
    child.stderr.write(`${PAIRING_LINE}\n`)
    const write = child.stdout.write.bind(child.stdout)
    const held: Uint8Array[] = []
    let open = false
    child.stdout.write = ((chunk: Uint8Array) => {
      if (open) return write(chunk)
      held.push(chunk)
      return true
    }) as typeof child.stdout.write
    void approved.then(() => {
      open = true
      for (const chunk of held) write(chunk)
    })
    connects(child)
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
      deviceName: 'my laptop',
      approve: null,
      onPairing: () => undefined
    })

    const [bridge] = w.spawned
    expect(bridge?.command).toBe(FLOTI)
    expect(bridge?.args).toEqual([
      'bridge',
      FOLDER,
      '--pair',
      'my laptop',
      '--',
      'ssh',
      '-o',
      'BatchMode=yes',
      'me@build-box'
    ])
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
      deviceName: 'my laptop',
      approve: null,
      onPairing: () => undefined
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
      deviceName: 'my laptop',
      approve: null,
      onPairing: () => undefined
    })
    expect(w.spawned[0]?.args).toEqual([
      'bridge',
      FOLDER,
      '--pair',
      'my laptop',
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
      startRemoteHost(PLACES, w.deps, { folder: FOLDER, transport: SSH, deviceName: 'my laptop', approve: null, onPairing: () => undefined })
    )
    expect(error.lastLine).toBe(line)
  })

  it('says that no Floti host runs there in floti connect’s own words', async () => {
    const w = world([endsWith(BRIDGE_EXIT.unreachable, 'floti connect: no Floti host is running there.')])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, { folder: FOLDER, transport: SSH, deviceName: 'my laptop', approve: null, onPairing: () => undefined })
    )
    expect(error.lastLine).toBe('floti connect: no Floti host is running there.')
  })

  it('S10: hands the pairing code to the caller only, never to the log, and connects once approved', async () => {
    let approve: () => void = () => undefined
    const approved = new Promise<void>((resolve) => {
      approve = resolve
    })
    const w = world([pairsThen(approved)])
    const codes: string[] = []
    const connecting = startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my laptop',
      approve: null,
      onPairing: (code) => codes.push(code)
    })
    await expect.poll(() => codes).toEqual(['7Q2K-9XZD'])
    approve()
    const host = await connecting
    await host.close()
    expect(w.log.join('\n')).not.toContain('7Q2K-9XZD')
  })

  it('S6: approves this device in the same step with the role picked, after --pair', async () => {
    const w = world([connects])
    const host = await startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my laptop',
      approve: 'operator',
      onPairing: () => undefined
    })
    expect(w.spawned[0]?.args).toEqual([
      'bridge',
      FOLDER,
      '--pair',
      'my laptop',
      '--approve',
      'operator',
      '--',
      'ssh',
      '-o',
      'BatchMode=yes',
      'me@build-box'
    ])
    await host.close()
  })

  it('S6: an approval that failed hands on the line it wrote with the code shown again, and the first code with none', async () => {
    let approve: () => void = () => undefined
    const approved = new Promise<void>((resolve) => {
      approve = resolve
    })
    const failed = 'floti devices: this device is not an admin here.'
    const w = world([
      (child) => {
        pairsThen(approved)(child)
        child.stderr.write(`${failed}\n${PAIRING_LINE}\n`)
      }
    ])
    const told: Array<[string, string | null]> = []
    const connecting = startRemoteHost(PLACES, w.deps, {
      folder: FOLDER,
      transport: SSH,
      deviceName: 'my laptop',
      approve: 'admin',
      onPairing: (code, approvalFailed) => told.push([code, approvalFailed])
    })
    await expect
      .poll(() => told)
      .toEqual([
        ['7Q2K-9XZD', null],
        ['7Q2K-9XZD', failed]
      ])
    approve()
    await (await connecting).close()
    expect(w.log.join('\n')).not.toContain('7Q2K-9XZD')
  })

  it('a pairing that expired shows the bridge’s own line, not the code', async () => {
    const w = world([
      endsWith(
        BRIDGE_EXIT.pairingExpired,
        PAIRING_LINE,
        'floti bridge: nobody approved the request to pair before it expired; nothing was pinned.'
      )
    ])
    const error = await remoteError(
      startRemoteHost(PLACES, w.deps, { folder: FOLDER, transport: SSH, deviceName: 'my laptop', approve: null, onPairing: () => undefined })
    )
    expect(error.lastLine).toBe('floti bridge: nobody approved the request to pair before it expired; nothing was pinned.')
  })

  it('a window’s own bridge goes through the same transport and never asks to pair', async () => {
    const w = world([endsWith(BRIDGE_EXIT.transportEnded, 'Connection to build-box closed by remote host.')])
    const bridge = openRemotePageBridge(PLACES, w.deps, { folder: FOLDER, transport: SSH }, () => undefined)
    expect(w.spawned[0]?.args).toEqual(['bridge', FOLDER, '--', 'ssh', '-o', 'BatchMode=yes', 'me@build-box'])
    await expect(bridge.ended).resolves.toBe('Connection to build-box closed by remote host.')
  })

  it('keeps each host’s keys in a folder of its own inside Helm’s data, whatever its id', () => {
    const one = remoteClientFolder(PLACES, 'win32', 'h-build')
    const other = remoteClientFolder(PLACES, 'win32', '..\\..\\escape')
    expect(one).toMatch(/^C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\remote-hosts\\[0-9a-f]{16}$/)
    expect(other).toMatch(/^C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\remote-hosts\\[0-9a-f]{16}$/)
    expect(one).not.toBe(other)
    expect(remoteClientFolder(PLACES, 'win32', 'h-build')).toBe(one)
  })

  it('reads the code from the pairing line and nothing else', () => {
    expect(pairingCodeOf(PAIRING_LINE)).toBe('7Q2K-9XZD')
    expect(pairingCodeOf('me@build-box: Permission denied (publickey).')).toBeNull()
  })
})
