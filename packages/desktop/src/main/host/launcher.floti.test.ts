import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { FLOTI_PLACES, endStartedProcesses, flotiAvailable, runFloti, startFlotiHost, startedProcesses } from '../../../test/floti-host'
import {
  LocalHostRefusedError,
  fromBeforeRestart,
  hostEnvironment,
  oldHostOffer,
  localHostRestartFrame,
  restartLocalHost,
  restartOffer,
  startLocalHost,
  type HostPlaces,
  type LauncherDeps,
  type LocalHost
} from './launcher'
import { PROTOCOL_VERSION, type ProtocolVersion } from './protocol'

/**
 * This PC's host and this Helm on either side of a protocol version, and
 * Restart host to update, against the real `floti` this checkout built (with
 * the `testkit` feature, as `pnpm test:e2e` builds it, so the host greets
 * with the protocol a test writes in its data folder), its host in this
 * test's own folders. Every host here is one the test started.
 */

// Every host here, the ones Helm's start path started included, was spawned
// by this test and is ended by its own pid.
afterEach(endStartedProcesses)

async function hostWorld(label: string, hostProtocol?: string) {
  const root = await mkdtemp(join(inject(RUN_ROOT), `${label} `))
  const places: HostPlaces = {
    ...FLOTI_PLACES,
    dataDir: join(root, 'helm-data'),
    templatesDir: join(root, 'config', 'templates')
  }
  const programs = { platform: process.platform, env: process.env, tmpdir, exists: existsSync }
  const env = hostEnvironment(places, programs)
  if (hostProtocol !== undefined) {
    // The host makes its own data folder, owner-only, on its first start; the
    // protocol it greets with is written there once it has.
    const first = await startFlotiHost(env)
    first.kill()
    await first.exited
    await writeFile(join(env['FLOTI_DATA_DIR']!, 'floti-test-host-protocol'), hostProtocol)
  }
  /** Each host Helm's start path started, settling once it has exited. */
  const startedHosts: Array<Promise<void>> = []
  const deps = (protocol?: ProtocolVersion): LauncherDeps => ({
    ...programs,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options)
      startedProcesses.push(child)
      if (args[0] === 'host') startedHosts.push(new Promise((done) => child.once('exit', () => done())))
      return child
    },
    appVersion: '0.0.0',
    log: () => undefined,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
    ...(protocol !== undefined ? { protocol } : {})
  })
  return { places, env, deps, startedHosts }
}

async function refusedWith(promise: Promise<unknown>): Promise<LocalHostRefusedError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(LocalHostRefusedError)
  return error as LocalHostRefusedError
}

describe.runIf(flotiAvailable)('this PC’s host and this Helm on either version', { timeout: PATIENCE * 4 }, () => {
  it('S6: the same version connects', async () => {
    const world = await hostWorld('same version')
    await startFlotiHost(world.env)
    const local = await startLocalHost(world.places, world.deps())
    expect(local.connection.welcome.protocol).toEqual({ major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor })
    await local.close()
  })

  it('S6: a Helm one minor behind its host connects', async () => {
    const world = await hostWorld('one minor behind', `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor + 1}`)
    await startFlotiHost(world.env)
    const local = await startLocalHost(world.places, world.deps())
    expect(local.connection.welcome.protocol).toEqual({ major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor })
    await local.close()
  })

  it('S7: a Helm newer than its host is refused, naming both versions, and told to update the host', async () => {
    const world = await hostWorld('newer helm')
    await startFlotiHost(world.env)
    const newer = { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 1 }
    const error = await refusedWith(startLocalHost(world.places, world.deps(newer)))
    expect(error.refused).toEqual({
      host: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
      client: newer,
      update: 'host'
    })
    expect(error.message).toContain(`${newer.major}.${newer.minor}`)
    expect(error.message).toContain('Update the host')
  })

  it('S8: a Helm more than one minor behind, or on an older major, is refused and told to update itself', async () => {
    const world = await hostWorld('older helm', `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor + 2}`)
    await startFlotiHost(world.env)
    const behind = await refusedWith(startLocalHost(world.places, world.deps()))
    expect(behind.refused.update).toBe('client')
    const olderMajor = await refusedWith(
      startLocalHost(world.places, world.deps({ major: PROTOCOL_VERSION.major - 1, minor: 9 }))
    )
    expect(olderMajor.refused.update).toBe('client')
  })

  it('S7 and S12: a host that refuses this Helm still answers the restart ask, and Restart host to update replaces it', async () => {
    const world = await hostWorld('restart')
    const old = await startFlotiHost(world.env)
    const newer = { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 1 }
    await refusedWith(startLocalHost(world.places, world.deps(newer)))

    const asked = await localHostRestartFrame(world.places, world.deps(), false)
    expect(asked).not.toBeNull()
    const version = (await runFloti(['--version'], world.env)).stdout.trim()
    expect(version).toBe(`floti ${asked!.hostVersion}`)
    expect(restartOffer(asked!)).toEqual({ hostVersion: asked!.hostVersion, sessions: 0, ends: 0 })

    await restartLocalHost(world.places, world.deps())
    await old.exited
    // Nothing answers now; the start the link makes next starts the floti Helm carries.
    expect(await localHostRestartFrame(world.places, world.deps(), false)).toBeNull()
    const local = await startLocalHost(world.places, world.deps())
    expect(local.startedHost).toBe(true)
    await local.close()
  })

  it('S12: a plain terminal running in the old host keeps running through Restart host to update, and the new host gives its screen back', async () => {
    const world = await hostWorld('restart with a terminal')
    const old = await startFlotiHost(world.env)
    const before = await startLocalHost(world.places, world.deps())
    const folder = await mkdtemp(join(inject(RUN_ROOT), 'terminal folder '))
    const opened = await before.connection.request('pterm:open', {
      path: folder,
      cols: 100,
      rows: 30,
      shell: null,
      separate: true
    })
    const first = screen(before.connection, opened.id)
    const marker = 'floti-restart-marker'
    first.stream.write(new TextEncoder().encode(`echo ${marker}\r`))
    await expect.poll(() => first.text(), { timeout: PATIENCE }).toContain(marker)

    const asked = await localHostRestartFrame(world.places, world.deps(), false)
    // The carried floti speaks the keeper's link version, so nothing ends.
    expect(restartOffer(asked!)).toEqual({ hostVersion: asked!.hostVersion, sessions: 0, ends: 0 })
    await restartLocalHost(world.places, world.deps())
    await old.exited
    await before.close()

    const after = await startLocalHost(world.places, world.deps())
    expect(after.startedHost).toBe(true)
    // The same terminal, taken back from the keeper, its screen drawn again.
    const second = screen(after.connection, opened.id)
    await expect.poll(() => second.text(), { timeout: PATIENCE }).toContain(marker)
    expect(second.closed()).toBeNull()

    // A deliberate stop ends the terminal and the keeper before the host
    // exits, so once it has exited this test leaves nothing running.
    expect(world.startedHosts).toHaveLength(1)
    await after.connection.request('host:stop', { reason: 'stop' })
    await world.startedHosts[0]
    await after.close()
  })

  it('S15: Restart host to update ends a protocol-1.x host like a crash, and the carried floti takes its terminal back with its screen', async () => {
    const world = await hostWorld('restart a protocol 1 host', '1.4')
    const data = world.env['FLOTI_DATA_DIR']!
    // 2.4.1-preview.7's keeper names no link version.
    await writeFile(join(data, 'floti-test-keeper-link-version'), 'none')
    const old = await startFlotiHost(world.env)
    // A Helm of that release reaches it and opens a terminal.
    const before = await startLocalHost(world.places, world.deps({ major: 1, minor: 4 }))
    const folder = await mkdtemp(join(inject(RUN_ROOT), 'terminal folder '))
    const opened = await before.connection.request('pterm:open', {
      path: folder,
      cols: 100,
      rows: 30,
      shell: null,
      separate: true
    })
    const first = screen(before.connection, opened.id)
    const marker = 'floti-old-host-marker'
    first.stream.write(new TextEncoder().encode(`echo ${marker}\r`))
    await expect.poll(() => first.text(), { timeout: PATIENCE }).toContain(marker)

    // This Helm is refused, naming protocol 1.4, and offered the restart as ending nothing.
    const refused = (await refusedWith(startLocalHost(world.places, world.deps()))).refused
    expect(fromBeforeRestart(refused)).toBe(true)
    expect(oldHostOffer(refused)).toEqual({
      hostVersion: 'protocol 1.4',
      sessions: null,
      ends: 0
    })

    expect(await restartLocalHost(world.places, world.deps(), refused)).toBeNull()
    await old.exited
    await before.close()

    // The carried floti, greeting with this Helm's protocol, starts on the same folders.
    await rm(join(data, 'floti-test-host-protocol'))
    await rm(join(data, 'floti-test-keeper-link-version'))
    const after = await startLocalHost(world.places, world.deps())
    expect(after.startedHost).toBe(true)
    const second = screen(after.connection, opened.id)
    await expect.poll(() => second.text(), { timeout: PATIENCE }).toContain(marker)
    expect(second.closed()).toBeNull()

    expect(world.startedHosts).toHaveLength(1)
    await after.connection.request('host:stop', { reason: 'stop' })
    await world.startedHosts[0]
    await after.close()
  })
})

/** A plain terminal's stream on `connection`: what it drew, as text, and how it closed. */
function screen(connection: LocalHost['connection'], id: number) {
  let text = ''
  let closed: string | null = null
  const decoder = new TextDecoder()
  const stream = connection.openStream(
    'pterm:data',
    { id },
    {
      data: (bytes) => {
        text += decoder.decode(bytes, { stream: true })
      },
      close: (reason) => {
        closed = reason ?? 'closed'
      }
    }
  )
  return { stream, text: () => text, closed: () => closed }
}
