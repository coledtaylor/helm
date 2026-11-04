import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  classifyHostFailure,
  SYSTEM_LINE,
  type HostCheck,
  type HostTransport,
  type RemoteHost,
  type RemoteHostConnection
} from '@helm/core/types'
import { describe, expect, inject, it } from 'vitest'
import { RUN_ROOT } from '../../../../../test/run-root'
import { createRemoteInstaller, spawnTransportRun } from './remote-install'
import type { TransportPrograms } from './remote-launcher'
import { listWslDistros } from './wsl-distros'

/**
 * WSL distros through real transport processes: test/fake-ssh's `wsl.mjs`
 * as this PC's `wsl.exe`, and its `ssh.mjs` as this PC's ssh, whose line
 * naming `wsl.exe` runs the same fake "on the Windows PC". Each run is
 * recorded in the test's own log. Nothing runs the real wsl.exe or ssh,
 * touches a distro or reaches another computer.
 */

const REPO = resolve(import.meta.dirname, '../../../../..')
const PROGRAMS = {
  wsl: [process.execPath, join(REPO, 'test', 'fake-ssh', 'wsl.mjs')],
  ssh: [process.execPath, join(REPO, 'test', 'fake-ssh', 'ssh.mjs')]
} satisfies TransportPrograms

const DEBIAN: HostTransport = { kind: 'wsl', distro: 'Debian' }
const UBUNTU_ON_WIN_BOX: HostTransport = {
  kind: 'wsl',
  distro: 'Ubuntu',
  through: 'win-box'
}

interface Recorded {
  program: 'ssh' | 'wsl'
  argv: string[]
  distro?: string | null
  line?: string | null
  target?: string | null
}

/** A log in this test's own folder, and what was recorded in it. */
async function transportLog(name: string): Promise<{ path: string; runs: () => Recorded[] }> {
  const root = await mkdtemp(join(inject(RUN_ROOT), `${name} `))
  const path = join(root, 'transport.jsonl')
  return {
    path,
    runs: () =>
      existsSync(path)
        ? readFileSync(path, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => JSON.parse(line) as Recorded)
        : []
  }
}

function installer(env: NodeJS.ProcessEnv) {
  return createRemoteInstaller({
    run: spawnTransportRun(spawn, env),
    programs: PROGRAMS,
    platform: process.platform,
    arch: process.arch,
    version: '2.6.0',
    protocol: { major: 1, minor: 2 },
    ownBuild: async () => null,
    sums: async () => null,
    script: async () => '',
    releaseBase: () => '',
    log: () => undefined
  })
}

const failureOf = (check: HostCheck, transport: HostTransport) => {
  if (check.kind !== 'failed') throw new Error(`expected a failed check, got ${check.kind}`)
  return classifyHostFailure({
    name: 'Debian',
    transport,
    lastLine: check.lastLine,
    said: check.said,
    cause: check.cause === undefined ? undefined : { kind: check.cause },
    step: 'check'
  })
}

const WIN_BOX: RemoteHost = {
  id: 'h-win',
  name: 'win-box',
  transport: { kind: 'ssh', target: 'win-box' },
  system: { os: 'Windows', cpu: 'x86_64' }
}
const BUILD_BOX: RemoteHost = {
  id: 'h-build',
  name: 'build-box',
  transport: { kind: 'ssh', target: 'build-box' },
  system: { os: 'Linux', cpu: 'x86_64' }
}
const CONNECTED: RemoteHostConnection = { state: 'connected' }

function lister(env: NodeJS.ProcessEnv, hosts: RemoteHost[], states: Record<string, RemoteHostConnection>) {
  return listWslDistros({
    run: spawnTransportRun(spawn, env),
    platform: 'win32',
    programs: PROGRAMS,
    hosts: () => hosts,
    states: () => states
  })
}

describe('the WSL distros Add a host lists', () => {
  it('S1: this PC’s distros are found through its own wsl.exe --list --quiet, with no ssh run', async () => {
    const log = await transportLog('wsl list here')
    const lists = await lister(
      {
        ...process.env,
        FAKE_WSL_DISTROS: 'Ubuntu,Debian',
        FAKE_SSH_LOG: log.path
      },
      [],
      {}
    )
    expect(lists).toEqual([
      {
        through: null,
        pcName: 'this PC',
        distros: ['Ubuntu', 'Debian'],
        said: null
      }
    ])
    expect(log.runs().map((run) => run.program)).toEqual(['wsl'])
    expect(log.runs()[0]?.argv).toEqual(['--list', '--quiet'])
  })

  it('S2: a connected Windows host’s distros come through ssh and its own wsl.exe, read from UTF-16LE; a Linux host and a host not connected list none', async () => {
    const log = await transportLog('wsl list there')
    const env = {
      ...process.env,
      FAKE_WSL_DISTROS: 'Ubuntu',
      FAKE_SSH_LOG: log.path
    }
    const OTHER_WINDOWS: RemoteHost = {
      ...WIN_BOX,
      id: 'h-off',
      name: 'off-box',
      transport: { kind: 'ssh', target: 'off-box' }
    }
    const lists = await lister(env, [WIN_BOX, BUILD_BOX, OTHER_WINDOWS], {
      [WIN_BOX.id]: CONNECTED,
      [BUILD_BOX.id]: CONNECTED,
      [OTHER_WINDOWS.id]: { state: 'retrying' }
    })
    expect(lists).toEqual([
      { through: null, pcName: 'this PC', distros: ['Ubuntu'], said: null },
      {
        through: 'win-box',
        pcName: 'win-box',
        distros: ['Ubuntu'],
        said: null
      }
    ])
    const ssh = log.runs().filter((run) => run.program === 'ssh')
    expect(ssh).toEqual([
      expect.objectContaining({
        target: 'win-box',
        line: 'wsl.exe --list --quiet'
      })
    ])
  })

  it('S2: a PC with no WSL, or none installed, says so in wsl.exe’s own words, readable', async () => {
    const none = await lister({ ...process.env, FAKE_WSL_NOT_INSTALLED: '1' }, [], {})
    expect(none).toEqual([
      {
        through: null,
        pcName: 'this PC',
        distros: [],
        said: 'For more information please visit https://aka.ms/wslinstall'
      }
    ])
    const empty = await lister({ ...process.env }, [WIN_BOX], {
      [WIN_BOX.id]: CONNECTED
    })
    expect(empty.map((list) => list.distros)).toEqual([[], []])
    // Through ssh wsl.exe writes UTF-16LE; it is read as text either way.
    for (const list of empty) expect(list.said).toBe("and 'wsl.exe --install <Distro>' to install.")
  })
})

describe('checking a WSL distro through wsl.exe', () => {
  it('S3: this PC’s distro is checked with wsl.exe -d Debian -- floti version, then its system line reaches the distro’s shell unaltered', async () => {
    const log = await transportLog('wsl check here')
    const env = {
      ...process.env,
      FAKE_WSL_DISTROS: 'Debian',
      FAKE_SSH_MISSING_LINE: 'floti',
      FAKE_SSH_LOG: log.path
    }
    const check = await installer(env).check({ transport: DEBIAN })
    expect(check).toMatchObject({ system: { os: 'linux', cpu: 'x64' } })
    const runs = log.runs()
    expect(runs.map((run) => [run.program, run.distro, run.line])).toEqual([
      ['wsl', 'Debian', 'floti version'],
      ['wsl', 'Debian', SYSTEM_LINE]
    ])
  })

  it('S5: a distro on win-box is checked through ssh -o BatchMode=yes win-box and win-box’s wsl.exe, the line reaching the distro unaltered by cmd', async () => {
    const log = await transportLog('wsl check there')
    const env = {
      ...process.env,
      FAKE_WSL_DISTROS: 'Ubuntu',
      FAKE_SSH_MISSING_LINE: 'floti',
      FAKE_SSH_LOG: log.path
    }
    const check = await installer(env).check({ transport: UBUNTU_ON_WIN_BOX })
    expect(check).toMatchObject({ system: { os: 'linux' } })
    const runs = log.runs()
    expect(runs.filter((run) => run.program === 'ssh').map((run) => run.argv.slice(0, 3))).toEqual([
      ['-o', 'BatchMode=yes', 'win-box'],
      ['-o', 'BatchMode=yes', 'win-box']
    ])
    expect(runs.filter((run) => run.program === 'wsl').map((run) => [run.distro, run.line])).toEqual([
      ['Ubuntu', 'floti version'],
      ['Ubuntu', SYSTEM_LINE]
    ])
  })

  it('S4: a distro with floti is ready, with floti’s version and the distro’s system', async () => {
    const env = {
      ...process.env,
      FAKE_WSL_DISTROS: 'Debian',
      FAKE_SSH_FLOTI_VERSION: 'floti 2.6.0 protocol 1.2 linux x64'
    }
    expect(await installer(env).check({ transport: DEBIAN })).toMatchObject({
      kind: 'ready',
      found: { version: '2.6.0' },
      system: { label: 'Linux · x64' }
    })
  })

  it.each([
    ['this PC', DEBIAN],
    ['win-box', UBUNTU_ON_WIN_BOX]
  ])(
    'S10: a distro that no longer exists on %s is said as no distro, with wsl.exe’s last line readable and the fix',
    async (_, transport) => {
      const check = await installer({
        ...process.env,
        FAKE_WSL_DISTROS: 'Other'
      }).check({ transport })
      const failure = failureOf(check, transport)
      expect(failure).toMatchObject({
        kind: 'noDistro',
        line: 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
      })
      // wsl.exe wrote it, through ssh too.
      expect(failure.saidBy).toBe('wsl.exe said')
      expect(failure.fix).toContain('wsl --list')
    }
  )

  it('S10: a PC where WSL is not installed is said so, with wsl --install as the fix', async () => {
    const check = await installer({
      ...process.env,
      FAKE_WSL_NOT_INSTALLED: '1'
    }).check({ transport: DEBIAN })
    const failure = failureOf(check, DEBIAN)
    expect(failure.kind).toBe('noWsl')
    expect(failure.line).toBe('For more information please visit https://aka.ms/wslinstall')
    expect(failure.fix).toContain('wsl --install')
  })
})
