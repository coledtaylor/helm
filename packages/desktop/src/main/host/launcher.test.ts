import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { FrameDecoder, encodeFrame } from './frame'
import {
  HOST_ALREADY_RUNNING_EXIT,
  HOST_RETRY_MS,
  HOST_START_DEADLINE_MS,
  LocalHostError,
  SOCKET_PATH_MAX,
  clientFolder,
  desktopArgs,
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
  repoRoot: 'C:\\src\\my helm',
  templatesDir: 'C:\\Users\\me\\AppData\\Local\\Helm\\dev\\helm-data\\templates',
  execPath: 'C:\\src\\my helm\\node_modules\\electron\\dist\\electron.exe',
  appPath: 'C:\\src\\my helm\\packages\\desktop'
}

/** How the host Helm starts is run: told which Helm started it. */
const HOST_PROGRAM = `host --desktop ${WIN_PLACES.execPath} --desktop-arg ${WIN_PLACES.appPath}`

/** A child process with in-memory pipes, whose program the test plays. */
class FakeChild extends EventEmitter implements HostChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  unrefed = false

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

  kill(): boolean {
    if (!this.running) return false
    this.killed = true
    this.signalCode = 'SIGTERM'
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  unref(): void {
    this.unrefed = true
  }

  /** Whether the program is still running: neither exited nor killed. */
  get running(): boolean {
    return this.exitCode === null && this.signalCode === null
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

/** A host that says it is listening, and runs until it is killed. */
const listens: Program = (child) => {
  child.stdout.write('Floti host is listening at \\\\.\\pipe\\floti-1f2e.\r\n')
  child.stdout.write('Floti host said something after, with key 0123abcd.\n')
}

const SOCKET_TOO_LONG = 'could not listen on /var/folders/x/T/floti-1f2e/floti.sock: path must be shorter than SUN_LEN'
const FROM_SSH = 'The Floti host starts at your sign-in, not from an SSH session, so it was not started.'

/**
 * A host that did not start: it says other things first, and its reason last,
 * on standard output. As with a real process, the exit can be seen before the
 * last of its output has been read.
 */
const saysWhyItDidNotStart =
  (reason: string): Program =>
  (child) => {
    child.stdout.write('Floti host said something first, with key 0123abcd.\n')
    queueMicrotask(() => {
      child.exitCode = 1
      child.emit('exit', 1, null)
      child.stdout.end(`Floti host did not start: ${reason}\n`)
      child.stderr.end()
    })
  }

/** A host that finds another still holding its folders, and exits saying so. */
const foldersHeld: Program = (child) => queueMicrotask(() => child.exit(HOST_ALREADY_RUNNING_EXIT))

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
          FLOTI_CONFIG_DIR: WIN_PLACES.dataDir,
          FLOTI_RUNTIME_DIR: `${WIN_PLACES.dataDir}\\host\\run`
        })
      }
    })

    it('leaves the installed app on the host’s own folders but the config folder, which holds Helm’s templates', () => {
      const env = hostEnvironment(
        { ...WIN_PLACES, appMode: 'installed', templatesDir: 'C:\\Users\\me\\.config\\helm\\templates' },
        { platform: 'win32', env: { PATH: 'x' }, tmpdir: () => 'C:\\Temp' }
      )
      expect(env).toEqual({ PATH: 'x', FLOTI_CONFIG_DIR: 'C:\\Users\\me\\.config\\helm' })
    })

    it('points the host’s config folder at the folder holding Helm’s templates folder in every run', () => {
      for (const appMode of ['installed', 'portable', 'dev', 'dev-live'] as const) {
        const env = hostEnvironment(
          { ...WIN_PLACES, dataDir: '/home/me/.config/Helm', appMode, templatesDir: '/home/me/.config/helm/templates' },
          { platform: 'linux', env: {}, tmpdir: () => '/tmp' }
        )
        expect(env['FLOTI_CONFIG_DIR']).toBe('/home/me/.config/helm')
      }
    })

    it('hands an unpackaged build’s host the node on PATH, and a packaged one none', () => {
      const env = { Path: 'C:\\Windows;relative\\bin;"C:\\Program Files\\nodejs";C:\\later' }
      const exists = (path: string): boolean =>
        path === 'C:\\Program Files\\nodejs\\node.exe' || path === 'C:\\later\\node.exe'
      const temp = (): string => 'C:\\Temp'
      for (const appMode of ['dev', 'dev-live'] as const) {
        expect(
          hostEnvironment({ ...WIN_PLACES, appMode }, { platform: 'win32', env, tmpdir: temp, exists })['FLOTI_NODE']
        ).toBe('C:\\Program Files\\nodejs\\node.exe')
      }
      for (const appMode of ['installed', 'portable'] as const) {
        expect(
          hostEnvironment({ ...WIN_PLACES, appMode, packaged: true }, { platform: 'win32', env, tmpdir: temp, exists })[
            'FLOTI_NODE'
          ]
        ).toBeUndefined()
      }
      expect(
        hostEnvironment(
          { ...WIN_PLACES, dataDir: '/home/me/helm-data' },
          { platform: 'linux', env: { PATH: '/usr/bin:/opt/node/bin' }, tmpdir: () => '/tmp', exists: (path) => path === '/opt/node/bin/node' }
        )['FLOTI_NODE']
      ).toBe('/opt/node/bin/node')
      // One the environment already names is kept, and no node anywhere passes none.
      expect(
        hostEnvironment(WIN_PLACES, {
          platform: 'win32',
          env: { ...env, FLOTI_NODE: 'D:\\node\\node.exe' },
          tmpdir: temp,
          exists
        })['FLOTI_NODE']
      ).toBe('D:\\node\\node.exe')
      expect(
        hostEnvironment(WIN_PLACES, { platform: 'win32', env, tmpdir: temp, exists: () => false })
      ).not.toHaveProperty('FLOTI_NODE')
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
      expect(mac).toMatch(/^\/var\/folders\/ab\/cdefgh\/T\/floti-[0-9a-f]{12}$/)
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
      expect(other).toMatch(/^\/tmp\/floti-[0-9a-f]{12}$/)
      expect(other!.slice(-12)).not.toBe(mac.slice(-12))

      // A Mac's own temp folder, as long as macOS makes it, with a test run's
      // folder inside it, as every test's `tmpdir()` is: the socket still fits.
      const nested = '/var/folders/76/wrkg31yx61g_4sqkvq4bnt_40000gn/T/helm-test-run-AbC123'
      const run = hostEnvironment(
        { ...WIN_PLACES, dataDir: `${nested}/helm world-XyZ789/app/helm-data` },
        { platform: 'darwin', env: {}, tmpdir: () => nested }
      )['FLOTI_RUNTIME_DIR']!
      expect(run.startsWith(`${nested}/`)).toBe(true)
      expect(Buffer.byteLength(`${run}/floti.sock`)).toBeLessThanOrEqual(SOCKET_PATH_MAX)
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

    await local.close()
    await bridge!.inputClosed()
    expect(bridge!.exitCode).toBe(0)
  })

  it('starts the host when none answers, waits until it is listening, connects, and lets go of it without stopping it', async () => {
    let announce: () => void = () => {}
    const waits: Program = (child) => {
      announce = () => listens(child)
    }
    const world = new World({ bridges: [exits(3), connects], hosts: [waits] })
    const starting = startLocalHost(WIN_PLACES, world.deps())

    await expect
      .poll(() => world.programs(), { timeout: PATIENCE })
      .toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`, HOST_PROGRAM])
    const host = world.spawned[1]!
    // Apart from Helm, with no input to close: the host's exit is its own.
    // Its standard output carries only the listening line Helm waits for.
    expect(host.options).toEqual({
      env: world.spawned[0]!.options.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      detached: true
    })
    expect(host.unrefed).toBe(false)
    announce()

    const local = await starting
    expect(world.programs()).toHaveLength(3)
    expect(local.startedHost).toBe(true)
    // Connected: Helm reads nothing more from it and does not wait for it to exit.
    expect(host.unrefed).toBe(true)
    expect(host.stdout.destroyed).toBe(true)

    await local.close()
    expect(world.spawned[2]!.exitCode).toBe(0)
    expect(host.running).toBe(true)
    expect(host.killed).toBe(false)
  })

  it('starts the host apart from Helm on macOS and Linux too', async () => {
    const world = new World({ bridges: [exits(3), connects] })
    const local = await startLocalHost(
      { ...WIN_PLACES, dataDir: '/home/me/.config/Helm', repoRoot: '/src/my helm' },
      world.deps({ platform: 'linux', env: {}, tmpdir: () => '/tmp' })
    )
    expect(world.spawned[1]!.options.detached).toBe(true)
    await local.close()
    expect(world.spawned[1]!.running).toBe(true)
  })

  it('tells the host the command that opens this Helm again: its program, and the app an unpackaged one runs', () => {
    expect(desktopArgs(WIN_PLACES)).toEqual(['--desktop', WIN_PLACES.execPath, '--desktop-arg', WIN_PLACES.appPath])
    expect(desktopArgs({ ...WIN_PLACES, packaged: true, execPath: 'C:\\Program Files\\Helm\\Helm.exe' })).toEqual([
      '--desktop',
      'C:\\Program Files\\Helm\\Helm.exe'
    ])
  })

  it('waits out a host that is still exiting with the folders, then starts one and connects', async () => {
    const world = new World({ bridges: [exits(3), connects], hosts: [foldersHeld, foldersHeld, listens] })
    const starting = startLocalHost(WIN_PLACES, world.deps())

    // Each try sets its listening deadline, then the wait before the next try.
    await expect.poll(() => world.timers.length, { timeout: PATIENCE }).toBe(2)
    expect(world.programs()).toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`, HOST_PROGRAM])
    world.timers[1]!()
    await expect.poll(() => world.timers.length, { timeout: PATIENCE }).toBe(4)
    world.timers[3]!()

    const local = await starting
    expect(local.startedHost).toBe(true)
    expect(world.programs()).toEqual([
      `bridge ${WIN_PLACES.dataDir}\\host-client`,
      HOST_PROGRAM,
      HOST_PROGRAM,
      HOST_PROGRAM,
      `bridge ${WIN_PLACES.dataDir}\\host-client`
    ])
    expect(world.log.filter((line) => line.includes('waiting for it to exit'))).toHaveLength(1)
    await local.close()
  })

  it('stops waiting for the folders once the start deadline has passed, and says so', async () => {
    const tries = Math.ceil(HOST_START_DEADLINE_MS / HOST_RETRY_MS) + 1
    const world = new World({ bridges: [exits(3)], hosts: Array.from({ length: tries }, () => foldersHeld) })
    const starting = refusal(startLocalHost(WIN_PLACES, world.deps()))

    for (let waited = 1; waited < tries; waited += 1) {
      await expect.poll(() => world.timers.length, { timeout: PATIENCE }).toBe(waited * 2)
      world.timers[waited * 2 - 1]!()
    }
    expect(await starting).toBe(
      `Another local host still had Helm's host folders after ${HOST_START_DEADLINE_MS / 1000} seconds${TURN_OFF}`
    )
    expect(world.programs()).toHaveLength(1 + tries)
  })

  it('starts the host when Helm has paired with none and no code waits, then enrols through the one it started', async () => {
    const world = new World({ bridges: [exits(4), connects] })
    const local = await startLocalHost(WIN_PLACES, world.deps())

    expect(world.programs()).toEqual([
      `bridge ${WIN_PLACES.dataDir}\\host-client`,
      HOST_PROGRAM,
      `bridge ${WIN_PLACES.dataDir}\\host-client`
    ])
    expect(local.startedHost).toBe(true)
    await local.close()
    expect(world.spawned[1]!.running).toBe(true)
  })

  it('says Helm is not paired when the host it would start is already running, with no code for Helm, and does not wait for it', async () => {
    const world = new World({
      bridges: [exits(4)],
      // A second host on the same folders refuses to start.
      hosts: [foldersHeld]
    })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `Helm is not paired with the local host, and the host offered no one-time code for it to enrol with${TURN_OFF}`
    )
    expect(world.programs()).toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`, HOST_PROGRAM])
  })

  it('says Helm is not paired when the host it started still offers no code, and ends that host', async () => {
    const world = new World({ bridges: [exits(4), exits(4)] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `Helm is not paired with the local host, and the host offered no one-time code for it to enrol with${TURN_OFF}`
    )
    expect(world.spawned[1]!.killed).toBe(true)
  })

  it.each([
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
    expect(world.spawned[1]!.killed).toBe(true)
    expect(world.spawned[1]!.running).toBe(false)
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

  it('says the host’s own reason when the host it started did not start, even when the reason arrives after its exit', async () => {
    const world = new World({ bridges: [exits(3)], hosts: [saysWhyItDidNotStart(SOCKET_TOO_LONG)] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `The local host did not start: ${SOCKET_TOO_LONG}${TURN_OFF}`
    )
  })

  it('says the host’s own reason, not that Helm is not paired, when the host it started for an unpaired Helm did not start', async () => {
    const world = new World({ bridges: [exits(4)], hosts: [saysWhyItDidNotStart(FROM_SSH)] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `The local host did not start: ${FROM_SSH.replace(/\.$/, '')}${TURN_OFF}`
    )
    expect(world.programs()).toEqual([`bridge ${WIN_PLACES.dataDir}\\host-client`, HOST_PROGRAM])
  })

  it('says only that the host stopped when it did not start without saying why, after an unpaired bridge too', async () => {
    const world = new World({ bridges: [exits(4)], hosts: [(child) => queueMicrotask(() => child.exit(1))] })
    expect(await refusal(startLocalHost(WIN_PLACES, world.deps()))).toBe(
      `The local host stopped before it was ready, with status 1${TURN_OFF}`
    )
  })

  it('ends a host that does not say it is listening by its deadline, and says so', async () => {
    const world = new World({ bridges: [exits(3)], hosts: [() => undefined] })
    const starting = refusal(startLocalHost(WIN_PLACES, world.deps()))
    await expect.poll(() => world.timers.length, { timeout: PATIENCE }).toBe(1)
    world.timers[0]!()
    expect(await starting).toBe(
      `The local host did not say it was listening within ${HOST_START_DEADLINE_MS / 1000} seconds${TURN_OFF}`
    )
    expect(world.spawned[1]!.killed).toBe(true)
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
    await local.close()
    expect(world.log.length).toBeGreaterThan(0)
    for (const line of world.log) {
      expect(line).not.toContain('7Q2K')
      expect(line).not.toContain('0123abcd')
      expect(line).not.toContain('floti bridge:')
    }
  })
})
