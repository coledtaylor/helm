import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import type { HostTransport } from '@helm/core/types'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import {
  FLOTI,
  FLOTI_PLACES,
  REPO,
  endStartedProcesses,
  flotiAvailable,
  flotiEnv,
  startFlotiHost,
  startedProcesses,
  stopFlotiHost
} from '../../../test/floti-host'
import { startRemoteHost } from './remote-launcher'

/**
 * Reaching a host in a WSL distro the whole way: main's launcher starts the
 * `floti bridge` this checkout built, with test/fake-ssh's `wsl.mjs` as this
 * PC's `wsl.exe` and its `ssh.mjs` as ssh, to a `floti host` in this test's
 * own folders standing for the host in the distro. The handshake runs from
 * the bridge to that host, so the fakes carry only its bytes. Runs where
 * `floti` has been built.
 */

const PROGRAMS = {
  wsl: [process.execPath, join(REPO, 'test', 'fake-ssh', 'wsl.mjs')],
  ssh: [process.execPath, join(REPO, 'test', 'fake-ssh', 'ssh.mjs')]
}

afterEach(endStartedProcesses)

function connect(env: NodeJS.ProcessEnv, folder: string, transport: HostTransport) {
  return startRemoteHost(
    FLOTI_PLACES,
    {
      platform: process.platform,
      env,
      exists: existsSync,
      spawn: (command, args, options) => {
        const child = spawn(command, args, options)
        startedProcesses.push(child)
        return child
      },
      programs: PROGRAMS,
      appVersion: '0.0.0',
      log: () => undefined
    },
    { folder, transport, deviceName: 'this pc' }
  )
}

describe.runIf(flotiAvailable)('reaching a host in a WSL distro through floti', () => {
  it(
    'S4, S5: Helm reaches a distro with wsl.exe -d <distro> -- floti connect, and one on win-box through ssh and win-box’s wsl.exe, pinning its key with nothing asked',
    { timeout: PATIENCE * 4 },
    async () => {
      const root = await mkdtemp(join(inject(RUN_ROOT), 'wsl host '))
      const env = flotiEnv(root, process.env as Record<string, string>)
      const host = await startFlotiHost(env)
      const log = join(root, 'transport.jsonl')
      const transportEnv = {
        ...env,
        FAKE_SSH_FLOTI: FLOTI,
        FAKE_WSL_DISTROS: 'Debian,Ubuntu',
        FAKE_SSH_LOG: log
      }

      const here = await connect(transportEnv, join(root, 'client debian'), {
        kind: 'wsl',
        distro: 'Debian'
      })
      expect(here.connection.welcome).not.toHaveProperty('role')
      await here.close()

      const there = await connect(transportEnv, join(root, 'client ubuntu'), {
        kind: 'wsl',
        distro: 'Ubuntu',
        through: 'win-box'
      })
      expect(there.connection.welcome).not.toHaveProperty('role')
      await there.close()

      const runs = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map(
          (line) =>
            JSON.parse(line) as {
              program: string
              distro?: string
              line?: string
              target?: string
            }
        )
      // The first connection reads the host's key to pin, then connects.
      expect(runs.filter((run) => run.program === 'wsl').map((run) => [run.distro, run.line])).toEqual([
        ['Debian', 'floti connect --host-key'],
        ['Debian', 'floti connect'],
        ['Ubuntu', 'floti connect --host-key'],
        ['Ubuntu', 'floti connect']
      ])
      expect(runs.filter((run) => run.program === 'ssh').map((run) => [run.target, run.line])).toEqual([
        ['win-box', 'wsl.exe -d Ubuntu -- floti connect --host-key'],
        ['win-box', 'wsl.exe -d Ubuntu -- floti connect']
      ])

      await stopFlotiHost(host, env)
    }
  )
})
