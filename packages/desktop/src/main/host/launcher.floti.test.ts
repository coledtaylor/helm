import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { FLOTI_PLACES, endStartedProcesses, flotiAvailable, runFloti, startFlotiHost, startedProcesses } from '../../../test/floti-host'
import {
  LocalHostRefusedError,
  hostEnvironment,
  localHostRestartFrame,
  restartLocalHost,
  restartOffer,
  startLocalHost,
  type HostPlaces,
  type LauncherDeps
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
  const deps = (protocol?: ProtocolVersion): LauncherDeps => ({
    ...programs,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options)
      startedProcesses.push(child)
      return child
    },
    appVersion: '0.0.0',
    log: () => undefined,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
    ...(protocol !== undefined ? { protocol } : {})
  })
  return { places, env, deps }
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
})
