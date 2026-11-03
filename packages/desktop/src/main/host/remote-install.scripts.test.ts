import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseFileName, type FlotiOs, type HostTransport } from '@helm/core/types'
import { describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import { createRemoteInstaller, spawnTransportRun, type RemoteInstallDeps } from './remote-install'

/**
 * The install scripts Helm sends a host's computer, run for real on this one:
 * test/fake-ssh's custom-command transport (`carry.mjs`) stands for the login,
 * and HOME or LOCALAPPDATA is this test's own folder, so the install lands
 * there. `<floti> setup` is played by the fake, never run.
 */

const REPO = resolve(import.meta.dirname, '../../../../..')
const CARRY = join(REPO, 'test', 'fake-ssh', 'carry.mjs')
const TRANSPORT: HostTransport = { kind: 'command', program: process.execPath, args: [CARRY] }
const OS: FlotiOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
const VERSION = '9.9.9'

/** This OS with the other CPU: floti's name for it, and what `uname -sm` or Windows' cmd says. */
const OTHER_CPU = process.arch === 'arm64' ? 'x64' : 'arm64'
const OTHER_SYSTEM = {
  windows: OTHER_CPU === 'x64' ? 'Windows_NT AMD64' : 'Windows_NT ARM64',
  macos: OTHER_CPU === 'x64' ? 'Darwin x86_64' : 'Darwin arm64',
  linux: OTHER_CPU === 'x64' ? 'Linux x86_64' : 'Linux aarch64'
}[OS]

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function computer(name: string): Promise<{ root: string; env: NodeJS.ProcessEnv; installed: string }> {
  const root = await mkdtemp(join(inject(RUN_ROOT), `${name} `))
  const home = join(root, 'home dir')
  const local = join(home, 'AppData', 'Local')
  await mkdir(local, { recursive: true })
  const installed =
    OS === 'windows' ? join(local, 'Programs', 'Floti', 'bin', 'floti.exe') : join(home, '.local', 'bin', 'floti')
  return { root, env: { ...process.env, HOME: home, LOCALAPPDATA: local }, installed }
}

function installer(env: NodeJS.ProcessEnv, deps: Partial<RemoteInstallDeps>): ReturnType<typeof createRemoteInstaller> {
  return createRemoteInstaller({
    run: spawnTransportRun(spawn, env),
    platform: process.platform,
    arch: process.arch,
    version: VERSION,
    protocol: { major: 1, minor: 0 },
    ownBuild: async () => null,
    sums: async () => null,
    script: (os) => readFile(join(REPO, 'scripts', 'install', os === 'windows' ? 'install.ps1' : 'install.sh'), 'utf8'),
    releaseBase: () => 'https://example.invalid/no-download',
    log: () => undefined,
    ...deps
  })
}

/** Checks the computer, which has no floti, and installs what it offers. */
async function checkAndInstall(env: NodeJS.ProcessEnv, deps: Partial<RemoteInstallDeps>) {
  const each = installer({ ...env, FAKE_SSH_MISSING_LINE: 'floti ' }, deps)
  const check = await each.check({ transport: TRANSPORT })
  expect(check.kind).toBe('offer')
  return { check, outcome: await each.install(check.kind === 'offer' ? check.id : '') }
}

describe('the install scripts, run where floti goes', () => {
  it(
    'S10: copies this Helm’s own floti through the login, checks its SHA-256 there, puts it in the user’s own folder and runs setup there',
    { timeout: PATIENCE },
    async () => {
      const { root, env, installed } = await computer('copy')
      const own = join(root, 'own floti')
      const bytes = Buffer.from('this is floti\n'.repeat(4096))
      await writeFile(own, bytes)
      const { check, outcome } = await checkAndInstall(env, { ownBuild: async () => ({ path: own, sha256: sha256(bytes) }) })
      expect(check).toMatchObject({ offer: { how: 'copy', action: 'install' } })
      expect(outcome).toEqual({ ok: true, floti: installed, startsAtNextSignIn: false })
      expect((await readFile(installed)).equals(bytes)).toBe(true)
    }
  )

  it(
    'S15: a file whose SHA-256 does not match is not installed, the floti there keeps working, and the script’s last line says why',
    { timeout: PATIENCE },
    async () => {
      const { root, env, installed } = await computer('mismatch')
      const old = Buffer.from('the floti that works\n')
      await mkdir(resolve(installed, '..'), { recursive: true })
      await writeFile(installed, old)
      const own = join(root, 'own floti')
      await writeFile(own, 'a different floti\n')
      const { outcome } = await checkAndInstall(env, { ownBuild: async () => ({ path: own, sha256: 'e'.repeat(64) }) })
      expect(outcome).toMatchObject({ ok: false, step: 'install' })
      expect(outcome.ok ? '' : outcome.lastLine).toMatch(/^floti install: .*SHA-256/)
      expect((await readFile(installed)).equals(old)).toBe(true)
    }
  )

  it(
    'S11: a computer of another CPU fetches the release’s file itself, from the address Helm sends, and checks it against the published SHA-256',
    { timeout: PATIENCE },
    async () => {
      const { root, env, installed } = await computer('download')
      const release = join(root, 'release v9.9.9')
      await mkdir(release)
      const bytes = Buffer.from('floti for the other CPU\n')
      const file = releaseFileName(VERSION, OS, OTHER_CPU)
      await writeFile(join(release, file), bytes)
      const { check, outcome } = await checkAndInstall(
        { ...env, FAKE_SSH_SYSTEM: OTHER_SYSTEM },
        {
          sums: async () => new Map([[file, sha256(bytes)]]),
          releaseBase: () => pathToFileURL(release).href
        }
      )
      expect(check).toMatchObject({ offer: { how: 'download' } })
      expect(outcome).toEqual({ ok: true, floti: installed, startsAtNextSignIn: false })
      expect((await readFile(installed)).equals(bytes)).toBe(true)
    }
  )
})
