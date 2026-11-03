import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RemoteHost } from '@helm/core/types'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import {
  CARRY,
  FLOTI,
  FLOTI_PLACES,
  connectThroughCarry,
  endStartedProcesses,
  flotiAvailable,
  runFloti,
  startFlotiHost,
  stopFlotiHost
} from '../../../test/floti-host'
import { doctorHosts, recordDoctorHosts } from './doctor-hosts'
import { hostEnvironment, type HostPlaces } from './launcher'

/**
 * What Helm records for `floti doctor`, checked by the real one: the `floti`
 * this checkout built, its host in this test's own folders as Helm's data
 * folder puts them, and two hosts on other computers this device added, one
 * reached through test/fake-ssh's `carry.mjs` and one whose command fails.
 * Runs where `floti` has been built.
 */

afterEach(endStartedProcesses)

describe.runIf(flotiAvailable)('the hosts floti doctor checks', () => {
  it(
    'S6: Helm records the hosts this device added, and floti doctor checks each with this PC\'s host, one line each, failing when one does not answer',
    { timeout: PATIENCE * 4 },
    async () => {
      const root = await mkdtemp(join(inject(RUN_ROOT), 'doctor hosts '))
      const places: HostPlaces = { ...FLOTI_PLACES, dataDir: join(root, 'helm-data'), templatesDir: join(root, 'config', 'templates') }
      const deps = { platform: process.platform, env: process.env, tmpdir, exists: existsSync, spawn }
      // The environment Helm's own host runs with, as `floti doctor` in a terminal would have it.
      const env = { ...hostEnvironment(places, deps), FAKE_SSH_FLOTI: FLOTI }
      const host = await startFlotiHost(env)

      const folderOf = (id: string): string => join(places.dataDir, 'hosts', id)
      const hosts: RemoteHost[] = [
        { id: 'one', name: 'build-box', transport: { kind: 'command', program: process.execPath, args: [CARRY] } },
        {
          id: 'two',
          name: 'gone-box',
          transport: {
            kind: 'command',
            program: process.execPath,
            args: ['-e', "process.stderr.write('gone-box: Connection refused\\n'); process.exit(255)"]
          }
        }
      ]
      // This device connected to both once, which pinned their keys; gone-box's
      // command has failed since.
      for (const id of ['one', 'two']) await (await connectThroughCarry(env, folderOf(id))).close()

      await recordDoctorHosts(places, deps, doctorHosts(hosts, folderOf))

      const doctor = await runFloti(['doctor'], env)
      const lines = doctor.stdout.trim().split(/\r?\n/)
      expect(lines, doctor.stderr).toHaveLength(3)
      expect(lines[0]).toMatch(/^This PC: answers, floti \S+, \d+ ms round trip$/)
      expect(lines[1]).toMatch(/^build-box: answers, floti \S+, \d+ ms round trip$/)
      // What its command said, unedited, and the line to try by hand.
      expect(lines[2]).toMatch(/^gone-box: does not answer: gone-box: Connection refused \| try by hand: .+ floti connect$/)
      expect(doctor.code).toBe(1)

      // With gone-box removed on this device, every host answers.
      await recordDoctorHosts(places, deps, doctorHosts(hosts.slice(0, 1), folderOf))
      const again = await runFloti(['doctor'], env)
      expect(again.stdout.trim().split(/\r?\n/)).toHaveLength(2)
      expect(again.code, again.stdout).toBe(0)

      await stopFlotiHost(host, env)
    }
  )
})
