import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { classifyHostFailure, type HostCheck, type HostTransport } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { createRemoteInstaller, spawnTransportRun } from './remote-install'

/**
 * The add-a-host check through a real transport process: test/fake-ssh's
 * `ssh.mjs`, run under Node as the user's command, playing each of ssh's
 * failures with ssh's own words and status, and a program that is not on this
 * PC at all. What the dialog shows for each is `classifyHostFailure` of what
 * the check said. Nothing reaches another computer or `~/.ssh`.
 */

const REPO = resolve(import.meta.dirname, '../../../../..')
const SSH_FAKE = join(REPO, 'test', 'fake-ssh', 'ssh.mjs')
/** The fake ssh as the user's own command: `node ssh.mjs build-box <line>`. */
const FAKE: HostTransport = { kind: 'command', program: process.execPath, args: [SSH_FAKE, 'build-box'] }

function installer(env: NodeJS.ProcessEnv) {
  return createRemoteInstaller({
    run: spawnTransportRun(spawn, env),
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

const failureOf = (check: HostCheck, transport: HostTransport = FAKE) => {
  if (check.kind !== 'failed') throw new Error(`expected a failed check, got ${check.kind}`)
  return classifyHostFailure({
    name: 'build-box',
    transport,
    lastLine: check.lastLine,
    said: check.said,
    cause: check.cause === undefined ? undefined : { kind: check.cause },
    step: 'check'
  })
}

describe('the add-a-host check through the fake ssh', () => {
  it.each([
    ['unresolved', 'unresolved', 'ssh: Could not resolve hostname build-box: Name or service not known'],
    ['timeout', 'unreachable', 'ssh: connect to host build-box port 22: Connection timed out'],
    ['refused', 'unreachable', 'ssh: connect to host build-box port 22: Connection refused'],
    ['noroute', 'unreachable', 'ssh: connect to host build-box port 22: No route to host'],
    ['denied', 'password', 'build-box: Permission denied (publickey,password).'],
    ['unknownkey', 'unknownKey', 'Host key verification failed.'],
    ['changedkey', 'hostKeyChanged', 'Host key verification failed.']
  ])('S11 to S14: ssh failing as %s is said as %s, with ssh’s last line unedited', async (fail, kind, line) => {
    const check = await installer({ ...process.env, FAKE_SSH_FAIL: fail }).check({ transport: FAKE })
    expect(failureOf(check)).toMatchObject({ kind, line })
  })

  it('S15: a login that prints text before floti’s line is said as login output, with the first line it printed', async () => {
    const env = {
      ...process.env,
      FAKE_SSH_LOGIN_TEXT: 'Welcome to build-box!',
      FAKE_SSH_FLOTI_VERSION: 'floti 2.6.0 protocol 1.2 linux x64'
    }
    const check = await installer(env).check({ transport: FAKE })
    expect(failureOf(check)).toMatchObject({ kind: 'loginOutput', line: 'Welcome to build-box!' })
  })

  it('S5: the same computer without the login text is ready, with its OS and CPU', async () => {
    const env = { ...process.env, FAKE_SSH_FLOTI_VERSION: 'floti 2.6.0 protocol 1.2 linux x64' }
    expect(await installer(env).check({ transport: FAKE })).toMatchObject({
      kind: 'ready',
      found: { version: '2.6.0' },
      system: { label: 'Linux · x64' }
    })
  })

  it('S10: a transport program that is not on this PC is said as missing, and nothing more is run', async () => {
    const missing: HostTransport = { kind: 'command', program: join(REPO, 'no such program here'), args: [] }
    const check = await installer(process.env).check({ transport: missing })
    expect(check).toMatchObject({ kind: 'failed', cause: 'transportMissing' })
    expect(failureOf(check, missing).kind).toBe('noTransport')
  })

  it('S8: Cancel stops a check under way: the run it started ends', async () => {
    const forever: HostTransport = { kind: 'command', program: process.execPath, args: ['-e', 'setInterval(() => {}, 1 << 30)'] }
    const controller = new AbortController()
    const checking = installer(process.env).check({ transport: forever }, controller.signal)
    controller.abort()
    expect(await checking).toMatchObject({ kind: 'failed' })
  })
})
