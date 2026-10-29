import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { FrameDecoder, encodeFrame } from './frame'
import {
  HOST_START_DEADLINE_MS,
  LocalHostError,
  SOCKET_PATH_MAX,
  clientFolder,
  flotiBinary,
  hostEnvironment,
  startLocalHost,
  type HostChild,
  type HostPlaces,
  type LauncherDeps,
  type SpawnOptions
} from './launcher'
import { PROTOCOL_VERSION } from './protocol'

const TURN_OFF = '; turn off “Run sessions in the local host” in Settings to use Helm’s own sessions.'

const WIN_PLACES: HostPlaces = {
  appMode: 'dev',
  dataDir: 'C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data',
  packaged: false,
  resourcesPath: 'C:\\Program Files\\Helm\\resources',
  repoRoot: 'C:\\src\\my helm'
}

/** A child process with in-memory pipes, whose program the test plays. */
class FakeChild extends EventEmitter implements HostChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly options: SpawnOptions
  ) {
    super()
  }

  exit(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
  }

  /** Resolves once Helm has closed this program's standard input. */
  inputClosed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stdin.writableFinished || this.stdin.readableEnded) resolve()
      else this.stdin.once('end', () => resolve()).resume()
    })
  }
}

type Program = (child: FakeChild) => void

/** A bridge connected to a host: it welcomes the hello and exits successfully when its input closes. */
const connects: Program = (child) => {
  const decoder = new FrameDecoder()
  child.stdin.on('data', (chunk: Uint8Array) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if ('message' in next && next.message.type === 'hello') {
        child.stdout.write(
          encodeFrame({
            type: 'welcome',
            protocol: {
              major: PROTOCOL_VERSION.major,
              minor: PROTOCOL_VERSION.minor
            },
            hostVersion: '0.4.1',
            capabilities: ['terminal'],
            backends: []
          })
        )
      }
    }
  })
  child.stdin.once('end', () => child.exit(0))
}

/** A bridge that says one line, which a real one would never put a secret in, and exits with `code`. */
const exits =
  (code: number): Program =>
  (child) => {
    child.stderr.write('floti bridge: something with code 7Q2K-9XZD in it\n')
    queueMicrotask(() => child.exit(code))
  }

/** A host that says it is listening, and stops when its input closes. */
const listens: Program = (child) => {
  child.stdout.write('Floti host is listening at \\\\.\\pipe\\floti-1f2e.\r\n')
  child.stdout.write('Floti host said something after, with key 0123abcd.\n')
  child.stdin.once('end', () => child.exit(0)).resume()
}

class World {
  readonly spawned: FakeChild[] = []
  readonly log: string[] = []
  readonly timers: Array<() => void> = []
  private readonly bridges: Program[]
  private readonly hosts: Program[]

  constructor(
    { bridges = [connects], hosts = [listens] }: { bridges?: Program[]; hosts?: Program[] } = {},
    private readonly present = true
  ) {
    this.bridges = [...bridges]
    this.hosts = [...hosts]
  }

  deps(overrides: Partial<LauncherDeps> = {}): LauncherDeps {
    return {
      platform: 'win32',
      env: { PATH: 'C:\\Windows' },
      tmpdir: () => 'C:\\Temp',
      exists: () => this.present,
      spawn: (command, args, options) => {
        const child = new FakeChild(command, args, options)
        this.spawned.push(child)
        const program = args[0] === 'bridge' ? this.bridges.shift() : this.hosts.shift()
        if (program === undefined) throw new Error(`nothing scripted for ${args.join(' ')}`)
        program(child)
        return child
      },
      appVersion: '2.4.0',
      log: (line) => this.log.push(line),
      setTimeout: (run) => {
        this.timers.push(run)
        return this.timers.length
      },
      clearTimeout: () => {},
      ...overrides
    }
  }

  programs(): string[] {
    return this.spawned.map((child) => child.args.join(' '))
  }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LocalHostError)
  return (error as Error).message
}

describe('the local host launcher', { timeout: PATIENCE }, () => {
  describe('where it looks for floti', () => {
    it('looks beside a packaged build’s resources, and in the checkout’s debug build otherwise', () => {
      expect(flotiBinary({ ...WIN_PLACES, packaged: true }, { platform: 'win32', env: {} })).toBe(
        'C:\\Program Files\\Helm\\resources\\floti.exe'
      )
      expect(flotiBinary(WIN_PLACES, { platform: 'win32', env: {} })).toBe('C:\\src\\my helm\\target\\debug\\floti.exe')
      expect(
        flotiBinary(WIN_PLACES, {
          platform: 'win32',
          env: { CARGO_TARGET_DIR: 'D:\\cargo target' }
        })
      ).toBe('D:\\cargo target\\debug\\floti.exe')
      const mac: HostPlaces = {
        ...WIN_PLACES,
        resourcesPath: '/Applications/Helm.app/Contents/Resources',
        repoRoot: '/src/helm'
      }
      expect(flotiBinary({ ...mac, packaged: true }, { platform: 'darwin', env: {} })).toBe(
        '/Applications/Helm.app/Contents/Resources/floti'
      )
      expect(flotiBinary(mac, { platform: 'linux', env: {} })).toBe('/src/helm/target/debug/floti')
    })

    it('keeps the client’s keys in host-client inside Helm’s data directory', () => {
      expect(clientFolder(WIN_PLACES, 'win32')).toBe(`${WIN_PLACES.dataDir}\\host-client`)
      expect(clientFolder({ ...WIN_PLACES, dataDir: '/home/me/.config/Helm' }, 'linux')).toBe(
        '/home/me/.config/Helm/host-client'
      )
    })
  })

  describe('which folders the host uses', () => {
    it('moves every host folder inside Helm’s data directory for every run but the installed app', () => {
      for (const appMode of ['dev', 'portable', 'dev-live'] as const) {
        expect(
          hostEnvironment(
            { ...WIN_PLACES, appMode },
            { platform: 'win32', env: { PATH: 'x' }, tmpdir: () => 'C:\\Temp' }
          )
        ).toEqual({
          PATH: 'x',
          FLOTI_DATA_DIR: `${WIN_PLACES.dataDir}\\host\\data`,
          FLOTI_LOG_DIR: `${WIN_PLACES.dataDir}\\host\\logs`,
          FLOTI_CONFIG_DIR: `${WIN_PLACES.dataDir}\\host\\config`,
          FLOTI_RUNTIME_DIR: `${WIN_PLACES.dataDir}\\host\\run`
        })
      }
    })

    it('leaves the installed app on the host’s own folders', () => {
      const env = hostEnvironment(
        { ...WIN_PLACES, appMode: 'installed' },
        { platform: 'win32', env: { PATH: 'x' }, tmpdir: () => 'C:\\Temp' }
      )
      expect(env).toEqual({ PATH: 'x' })
    })

    it('keeps the socket under the macOS and Linux path limit when the data directory is too deep for it', () => {
      const shallow = {
        ...WIN_PLACES,
        dataDir: '/Users/me/Library/Application Support/Helm Dev/dev/helm-data'
      }
      expect(
        hostEnvironment(shallow, {
          platform: 'darwin',
          env: {},
          tmpdir: () => '/var/folders/x/T'
        })['FLOTI_RUNTIME_DIR']
      ).toBe(`${shallow.dataDir}/host/run`)

      const deep = {
        ...WIN_PLACES,
        dataDir: `/private/var/folders/ab/T/helm-test-run/world with a space ${'x'.repeat(60)}/helm-data`
      }
      const mac = hostEnvironment(deep, {
        platform: 'darwin',
        env: {},
        tmpdir: () => '/var/folders/ab/cdefgh/T'
      })['FLOTI_RUNTIME_DIR']!
      expect(mac).toMatch(/^\/var\/folders\/ab\/cdefgh\/T\/helm-floti-[0-9a-f]{16}$/)
      expect(Buffer.byteLength(`${mac}/floti.sock`)).toBeLessThanOrEqual(SOCKET_PATH_MAX)
      const linux = hostEnvironment(deep, {
        platform: 'linux',
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        tmpdir: () => '/tmp'
      })['FLOTI_RUNTIME_DIR']
      expect(linux).toBe(mac.replace('/var/folders/ab/cdefgh/T', '/run/user/1000'))
      const other = hostEnvironment(
        { ...deep, dataDir: `${deep.dataDir}-2` },
        { platform: 'linux', env: {}, tmpdir: () => '/tmp' }
      )['FLOTI_RUNTIME_DIR']
      expect(other).toMatch(/^\/tmp\/helm-floti-[0-9a-f]{16}$/)
      expect(other!.slice(-16)).not.toBe(mac.slice(-16))
    })
  })

  it('connects through a host that is already running, and starts none', async () => {
    const world = new World()
    const local = await startLocalHost(WIN_PLACES, world.deps())
    expect(world.programs()).toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`])
    const [bridge] = world.spawned
    expect(bridge!.command).toBe('C:\\src\\my helm\\target\\debug\\floti.exe')
    expect(bridge!.options).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    expect(bridge!.options.env['FLOTI_DATA_DIR']).toBe(`${WIN_PLACES.dataDir}\\host\\data`)
    expect(local.startedHost).toBe(false)
    expect(local.connection.welcome.hostVersion).toBe('0.4.1')

    await local.stop()
    await bridge!.inputClosed()
    expect(bridge!.exitCode).toBe(0)
  })

  it('starts the host when none answers, waits until it is listening, connects, and stops it by closing its input', async () => {
    let announce: () => void = () => {}
    const waits: Program = (child) => {
      announce = () => listens(child)
    }
    const world = new World({ bridges: [exits(3), connects], hosts: [waits] })
    const starting = startLocalHost(WIN_PLACES, world.deps())

    await expect
      .poll(() => world.programs(), { timeout: PATIENCE })
      .toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`, 'host --until-stdin-closes'])
    const host = world.spawned[1]!
    expect(host.options).toMatchObject({
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    expect(host.options.env).toEqual(world.spawned[0]!.options.env)
    expect(host.stdin.writableEnded).toBe(false)
    announce()

    const local = await starting
    expect(world.programs()).toHaveLength(3)
    expect(local.startedHost).toBe(true)
    expect(host.stdin.writableEnded).toBe(false)

    await local.stop()
    expect(world.spawned[2]!.exitCode).toBe(0)
    expect(host.stdin.writableEnded).toBe(true)
    expect(host.exitCode).toBe(0)
  })

  it.each([
    [4, 'Helm is not paired with the local host, and the host offered no one-time code for it to enrol with'],
    [5, 'The local host did not prove the key Helm expected, so Helm did not connect to it'],
    [6, 'The local host closed the connection'],
    [1, 'The connection to the local host failed: floti bridge exited with status 1']
  ])(
    'refuses with one sentence of its own when the bridge exits with status %i, starting no host',
    async (code, sentence) => {
      const world = new World({ bridges: [exits(code)] })
      expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(`${sentence}${TURN_OFF}`)
      expect(world.programs()).toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`])
    }
  )

  it('says the local host program could not be found, and runs nothing', async () => {
    const world = new World({}, false)
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `Helm could not find the local host program at C:\\src\\my helm\\target\\debug\\floti.exe${TURN_OFF}`
    )
    expect(world.spawned).toEqual([])
  })

  it('says the program could not be run when starting it fails', async () => {
    const world = new World({
      bridges: [
        (child) => {
          queueMicrotask(() => {
            child.stdout.destroy()
            child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
          })
        }
      ]
    })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `Helm could not run the local host program at C:\\src\\my helm\\target\\debug\\floti.exe (EACCES)${TURN_OFF}`
    )
  })

  it('says the host it started did not answer, and stops it, when the bridge still finds no host', async () => {
    const world = new World({ bridges: [exits(3), exits(3)] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `The local host Helm started did not answer on its socket${TURN_OFF}`
    )
    expect(world.spawned[1]!.stdin.writableEnded).toBe(true)
    expect(world.spawned[1]!.exitCode).toBe(0)
  })

  it('says the host stopped before it was ready when it exits without listening', async () => {
    const world = new World({
      bridges: [exits(3)],
      hosts: [(child) => queueMicrotask(() => child.exit(1))]
    })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `The local host stopped before it was ready, with status 1${TURN_OFF}`
    )
    expect(world.programs()).toHaveLength(2)
  })

  it('stops a host that does not say it is listening by its deadline, and says so', async () => {
    const world = new World({
      bridges: [exits(3)],
      hosts: [(child) => child.stdin.once('end', () => child.exit(0)).resume()]
    })
    const starting = refusal(startLocalHost(WIN_PLACES, world.deps()))
    await expect.poll(() => world.timers.length, { timeout: PATIENCE }).toBe(1)
    world.timers[0]!()
    expect(await starting).toBe(
      `The local host did not say it was listening within ${HOST_START_DEADLINE_MS / 1000} seconds${TURN_OFF}`
    )
    expect(world.spawned[1]!.exitCode).toBe(0)
  })

  it('passes on the host’s refusal of the hello as its sentence', async () => {
    const refuses: Program = (child) => {
      child.stdin.once('data', () => {
        child.stdout.write(
          encodeFrame({
            type: 'refused',
            host: { major: 2, minor: 0 },
            client: { major: 1, minor: 0 },
            update: 'client',
            message: 'This host speaks protocol 2.0 and Helm speaks 1.0: update Helm.'
          })
        )
      })
      child.stdin.once('end', () => child.exit(6)).resume()
    }
    const world = new World({ bridges: [refuses] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `This host speaks protocol 2.0 and Helm speaks 1.0: update Helm${TURN_OFF}`
    )
  })

  it('logs nothing either program prints', async () => {
    const world = new World({ bridges: [exits(3), connects] })
    const local = await startLocalHost(WIN_PLACES, world.deps())
    await local.stop()
    expect(world.log.length).toBeGreaterThan(0)
    for (const line of world.log) {
      expect(line).not.toContain('7Q2K')
      expect(line).not.toContain('0123abcd')
      expect(line).not.toContain('floti bridge:')
    }
  })
})
