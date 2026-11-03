import { describe, expect, it } from 'vitest'
import { FLOTI_TARGETS, SYSTEM_LINE, type HostTransport } from '@helm/core/types'
import { RELEASE_TARGETS } from '../../../scripts/floti-release.mjs'
import { createRemoteInstaller, installLine, lastLineOf, type RemoteInstallDeps, type TransportRun } from './remote-install'

/**
 * The desktop's check, offer and install on a host's computer, with the
 * transport faked: each run is recorded as the argv this PC would start, and
 * answered as that computer would answer the line.
 */

const SSH: HostTransport = { kind: 'ssh', target: 'me@build-box' }
const BATCH = ['ssh', '-o', 'BatchMode=yes', 'me@build-box']
const OWN_SHA = 'c'.repeat(64)
const LINUX_SHA = 'a'.repeat(64)

type Answer = Partial<TransportRun> | ((line: string, stdinFile: string | null) => Partial<TransportRun>)

interface World {
  installer: ReturnType<typeof createRemoteInstaller>
  /** Every run, in order: its argv and the file sent on its standard input. */
  runs: { argv: readonly string[]; line: string; stdinFile: string | null }[]
  lines: () => string[]
}

/** A computer that answers each line by the first rule whose prefix it starts with. */
function world(rules: [prefix: string, answer: Answer][], options: Partial<RemoteInstallDeps> = {}): World {
  const runs: World['runs'] = []
  const installer = createRemoteInstaller({
    run: async (argv, stdinFile) => {
      const line = argv.at(-1) ?? ''
      runs.push({ argv, line, stdinFile })
      const rule = rules.find(([prefix]) => line.startsWith(prefix))
      if (rule === undefined) return { code: 127, stdout: '', stderr: `sh: 1: ${line.split(' ')[0] ?? ''}: not found\n` }
      const answer = typeof rule[1] === 'function' ? rule[1](line, stdinFile) : rule[1]
      return { code: 0, stdout: '', stderr: '', ...answer }
    },
    platform: 'linux',
    arch: 'x64',
    version: '2.6.0',
    protocol: { major: 1, minor: 2 },
    ownBuild: async () => ({ path: '/opt/Helm/resources/floti', sha256: OWN_SHA }),
    sums: async () => new Map([['floti-2.6.0-linux-arm64', LINUX_SHA]]),
    script: async (os) => (os === 'windows' ? '# install.ps1\nInstall-Floti @args\n' : '# install.sh\nfloti_install "$@"\n'),
    releaseBase: (version) => `https://github.com/coledtaylor/helm/releases/download/v${version}`,
    newId: () => 'offer-1',
    log: () => undefined,
    ...options
  })
  return { installer, runs, lines: () => runs.map((run) => run.line) }
}

const NO_FLOTI: [string, Answer] = ['floti ', { code: 127, stderr: 'sh: 1: floti: not found\n' }]
const INSTALLED: [string, Answer] = ['sh -c ', { stdout: '/home/me/.local/bin/floti\n' }]
const SET_UP: [string, Answer] = ['/home/me/.local/bin/floti setup', { stdout: 'The Floti host is running, and starts at each sign-in.\n' }]

describe('installing floti on a host’s computer, from the desktop', () => {
  it('names each release target as the release script does', () => {
    expect(FLOTI_TARGETS.map(({ name, os, cpu, platform, arch }) => ({ name, os, cpu, platform, arch }))).toEqual(
      RELEASE_TARGETS.map(({ name, os, cpu, platform, arch }) => ({ name, os, cpu, platform, arch }))
    )
  })

  it('S8: checks in batch mode with floti version, then names the OS and CPU, and offers an install saying what and where, changing nothing', async () => {
    const w = world([NO_FLOTI, [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }]])
    const check = await w.installer.check({ transport: SSH })
    expect(w.runs.map((run) => run.argv)).toEqual([
      [...BATCH, 'floti version'],
      [...BATCH, SYSTEM_LINE]
    ])
    expect(w.runs.every((run) => run.stdinFile === null)).toBe(true)
    expect(check).toEqual({
      kind: 'offer',
      id: 'offer-1',
      offer: {
        system: { os: 'linux', cpu: 'x64', label: 'Linux · x86_64' },
        found: null,
        action: 'install',
        how: 'copy',
        version: '2.6.0',
        folder: '~/.local/bin',
        sessions: null
      }
    })
  })

  it('S8: through a command, with the line as its last argument and floti’s missing line from Windows’ cmd', async () => {
    const command: HostTransport = { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] }
    const w = world([
      [
        'floti ',
        { code: 1, stderr: "'floti' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n" }
      ],
      [SYSTEM_LINE, { stdout: 'Windows_NT ARM64\r\n' }]
    ])
    const check = await w.installer.check({ transport: command })
    expect(w.runs.map((run) => run.argv)).toEqual([
      ['wsl.exe', '-d', 'Ubuntu', '--', 'floti version'],
      ['wsl.exe', '-d', 'Ubuntu', '--', SYSTEM_LINE]
    ])
    expect(check).toMatchObject({ kind: 'noBuild' })
  })

  it('S9: a cancelled offer runs nothing more there, and cannot be installed after', async () => {
    const w = world([NO_FLOTI, [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }]])
    const check = await w.installer.check({ transport: SSH })
    w.installer.cancel(check.kind === 'offer' ? check.id : '')
    await expect(w.installer.install('offer-1')).rejects.toThrow('no longer open')
    expect(w.lines()).toEqual(['floti version', SYSTEM_LINE])
  })

  it('S10: copies this Helm’s own floti over the same login, with its SHA-256 for the script to check there, then runs setup there', async () => {
    const w = world([SET_UP, NO_FLOTI, [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }], INSTALLED])
    await w.installer.check({ transport: SSH })
    const outcome = await w.installer.install('offer-1')
    expect(outcome).toEqual({ ok: true, floti: '/home/me/.local/bin/floti', startsAtNextSignIn: false })
    const [put, setup] = w.runs.slice(2)
    expect(put?.argv.slice(0, 4)).toEqual(BATCH)
    expect(put?.stdinFile).toBe('/opt/Helm/resources/floti')
    expect(put?.line).toBe(
      `sh -c '# install.sh\nfloti_install "$@"\n' floti-install '2.6.0' 'floti-2.6.0-linux-x64' '${OWN_SHA}' '-'`
    )
    expect(setup?.argv).toEqual([...BATCH, '/home/me/.local/bin/floti setup'])
    expect(w.runs.length).toBe(4)
  })

  it('S11: a computer of another OS or CPU is sent the release’s address and SHA-256 to fetch from itself, and this PC runs nothing but the transport', async () => {
    const w = world([SET_UP, NO_FLOTI, [SYSTEM_LINE, { stdout: 'Linux aarch64\n' }], INSTALLED])
    const check = await w.installer.check({ transport: SSH })
    expect(check).toMatchObject({ kind: 'offer', offer: { how: 'download', system: { label: 'Linux · aarch64' } } })
    expect(await w.installer.install('offer-1')).toMatchObject({ ok: true })
    const put = w.runs[2]
    expect(put?.stdinFile).toBeNull()
    expect(put?.line).toContain(
      `'2.6.0' 'floti-2.6.0-linux-arm64' '${LINUX_SHA}' 'https://github.com/coledtaylor/helm/releases/download/v2.6.0'`
    )
    // Every program this PC started was the user's ssh.
    expect(w.runs.every((run) => run.argv.slice(0, 4).join(' ') === BATCH.join(' '))).toBe(true)
  })

  it('S12: says there is no floti it can install for an OS no floti is built for, and keeps no offer', async () => {
    const w = world([NO_FLOTI, [SYSTEM_LINE, { stdout: 'FreeBSD arm64\n' }]])
    expect(await w.installer.check({ transport: SSH })).toEqual({
      kind: 'noBuild',
      system: { os: null, cpu: 'arm64', label: 'FreeBSD · arm64' },
      reason: 'There is no floti for FreeBSD · arm64 yet.'
    })
    await expect(w.installer.install('offer-1')).rejects.toThrow()
  })

  it('S12: a build with no published floti offers nothing for a computer its own floti does not fit', async () => {
    const w = world([NO_FLOTI, [SYSTEM_LINE, { stdout: 'Darwin arm64\n' }]], { sums: async () => null })
    const check = await w.installer.check({ transport: SSH })
    expect(check).toMatchObject({ kind: 'noBuild', reason: expect.stringContaining('no published floti') })
  })

  it('a floti this Helm can talk to is ready: nothing is offered', async () => {
    const w = world([['floti version', { stdout: 'floti 2.5.0 protocol 1.2 linux x64\n' }]])
    expect(await w.installer.check({ transport: SSH })).toEqual({
      kind: 'ready',
      found: { version: '2.5.0', protocol: '1.2' }
    })
    expect(w.lines()).toEqual(['floti version'])
  })

  it('S13: a floti too old to talk to is offered an update naming the version found, with how many sessions it ends', async () => {
    const w = world([
      ['floti version', { stdout: 'floti 2.1.0 protocol 1.0 linux x64\n' }],
      ['floti update-stop --ask', { stdout: '2\n' }]
    ])
    const check = await w.installer.check({ transport: SSH })
    expect(check).toMatchObject({
      kind: 'offer',
      offer: {
        action: 'update',
        found: { version: '2.1.0', protocol: '1.0' },
        system: { os: 'linux', cpu: 'x64' },
        how: 'copy',
        sessions: 2
      }
    })
    expect(w.lines()).toEqual(['floti version', 'floti update-stop --ask'])
  })

  it('S13: a floti from before floti version is too old, its version from --version, its sessions unknown', async () => {
    const w = world([
      ['floti version', { code: 2, stderr: 'usage: floti host [--desktop <program>]\n' }],
      [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }],
      ['floti --version', { stdout: 'floti 0.1.0\n' }],
      ['floti update-stop --ask', { code: 2, stderr: 'usage: floti host\n' }]
    ])
    expect(await w.installer.check({ transport: SSH })).toMatchObject({
      kind: 'offer',
      offer: { action: 'update', found: { version: '0.1.0', protocol: null }, sessions: null }
    })
  })

  it('S19: a newer floti says to update this Helm and offers nothing', async () => {
    const w = world([['floti version', { stdout: 'floti 3.0.0 protocol 2.0 linux x64\n' }]])
    expect(await w.installer.check({ transport: SSH })).toEqual({
      kind: 'newer',
      found: { version: '3.0.0', protocol: '2.0' },
      ours: '1.2'
    })
  })

  it('S14: an update stops the old host for the update before anything is replaced, by the path the host keeps', async () => {
    const floti = '/home/me/.local/bin/floti'
    const w = world([
      [`${floti} version`, { stdout: 'floti 2.1.0 protocol 1.0 linux x64\n' }],
      [`${floti} update-stop --ask`, { stdout: '3\n' }],
      [`${floti} update-stop --stop`, {}],
      SET_UP,
      INSTALLED
    ])
    const check = await w.installer.check({ transport: SSH, floti })
    expect(check).toMatchObject({ offer: { sessions: 3 } })
    // Nothing is stopped or copied before the yes.
    expect(w.lines()).toEqual([`${floti} version`, `${floti} update-stop --ask`])
    expect(await w.installer.install('offer-1')).toMatchObject({ ok: true, floti })
    expect(w.lines().slice(2).map((line) => line.split(' ').slice(0, 2).join(' '))).toEqual([
      `${floti} update-stop`,
      "sh -c",
      `${floti} setup`
    ])
  })

  it('S14: without a yes, an update stops nothing and copies nothing', async () => {
    const w = world([
      ['floti version', { stdout: 'floti 2.1.0 protocol 1.0 linux x64\n' }],
      ['floti update-stop --ask', { stdout: '1\n' }]
    ])
    await w.installer.check({ transport: SSH })
    w.installer.cancel('offer-1')
    expect(w.lines()).not.toContain('floti update-stop --stop')
    expect(w.runs.some((run) => run.stdinFile !== null)).toBe(false)
  })

  it('S14: a stop that fails replaces nothing, and says the last line written there', async () => {
    const w = world([
      ['floti version', { stdout: 'floti 2.1.0 protocol 1.0 linux x64\n' }],
      ['floti update-stop --ask', { stdout: '1\n' }],
      ['floti update-stop --stop', { code: 1, stderr: 'floti update-stop: the host did not stop within 60 s\n' }]
    ])
    await w.installer.check({ transport: SSH })
    expect(await w.installer.install('offer-1')).toEqual({
      ok: false,
      step: 'stop',
      lastLine: 'floti update-stop: the host did not stop within 60 s'
    })
    expect(w.lines().some((line) => line.startsWith('sh -c'))).toBe(false)
  })

  it('S15: an install that fails there ends with its last line, unedited, and runs no setup', async () => {
    const w = world([
      NO_FLOTI,
      [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }],
      ['sh -c ', { code: 1, stderr: 'floti install: floti-2.6.0-linux-x64 did not match its SHA-256, so it was not installed.\n' }]
    ])
    await w.installer.check({ transport: SSH })
    expect(await w.installer.install('offer-1')).toEqual({
      ok: false,
      step: 'install',
      lastLine: 'floti install: floti-2.6.0-linux-x64 did not match its SHA-256, so it was not installed.'
    })
    expect(w.lines().some((line) => line.endsWith(' setup'))).toBe(false)
  })

  it('S15: a setup that fails there says its last line', async () => {
    const w = world([
      ['/home/me/.local/bin/floti setup', { code: 1, stderr: 'floti setup: schtasks: Access is denied.\n' }],
      NO_FLOTI,
      [SYSTEM_LINE, { stdout: 'Linux x86_64\n' }],
      INSTALLED
    ])
    await w.installer.check({ transport: SSH })
    expect(await w.installer.install('offer-1')).toEqual({
      ok: false,
      step: 'setup',
      lastLine: 'floti setup: schtasks: Access is denied.'
    })
  })

  it('S17: a setup that registered the host with nobody signed in there is an install that worked, starting at the next sign-in', async () => {
    const w = world(
      [
        [
          '"C:\\Users\\me\\AppData\\Local\\Programs\\Floti\\bin\\floti.exe" setup',
          { code: 10, stdout: 'The Floti host starts at the next sign-in.\r\n' }
        ],
        ['floti ', { code: 1, stderr: "'floti' is not recognized as an internal or external command,\r\n" }],
        [SYSTEM_LINE, { stdout: 'Windows_NT AMD64\r\n' }],
        ['powershell ', { stdout: 'C:\\Users\\me\\AppData\\Local\\Programs\\Floti\\bin\\floti.exe\r\n' }]
      ],
      { platform: 'win32', arch: 'x64' }
    )
    expect(await w.installer.check({ transport: SSH })).toMatchObject({
      offer: { how: 'copy', folder: '%LOCALAPPDATA%\\Programs\\Floti\\bin' }
    })
    expect(await w.installer.install('offer-1')).toEqual({
      ok: true,
      floti: 'C:\\Users\\me\\AppData\\Local\\Programs\\Floti\\bin\\floti.exe',
      startsAtNextSignIn: true
    })
  })

  it('a check whose transport fails says ssh’s own last line', async () => {
    const w = world([['floti ', { code: 255, stderr: 'me@build-box: Permission denied (publickey,password).\n' }]])
    expect(await w.installer.check({ transport: SSH })).toEqual({
      kind: 'failed',
      lastLine: 'me@build-box: Permission denied (publickey,password).'
    })
    expect(w.lines()).toEqual(['floti version'])
  })
})

describe('the last line written there', () => {
  it('passes over the CLIXML PowerShell writes to a redirected standard error', () => {
    const stderr =
      'floti install: floti.exe did not match its SHA-256, so it was not installed.\r\n#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"></Obj></Objs>'
    expect(lastLineOf({ code: 1, stdout: '', stderr })).toBe(
      'floti install: floti.exe did not match its SHA-256, so it was not installed.'
    )
  })
})

describe('the install line', () => {
  it('quotes the script and its arguments for a POSIX shell, so sh -c gets them as they are', () => {
    expect(installLine('linux', "echo 'it'\n", ['a b', "it's"])).toBe(
      `sh -c 'echo '\\''it'\\''\n' floti-install 'a b' 'it'\\''s'`
    )
  })

  it('sends PowerShell the script with its comments left out, encoded, inside cmd’s limit', async () => {
    const { readFile } = await import('node:fs/promises')
    const { resolve } = await import('node:path')
    const script = await readFile(resolve(import.meta.dirname, '../../../../../scripts/install/install.ps1'), 'utf8')
    const line = installLine('windows', script, ['2.6.0', 'floti-2.6.0-windows-x64.exe', 'f'.repeat(64), '-'])
    expect(line.startsWith('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ')).toBe(true)
    expect(line.length).toBeLessThan(8000)
    const decoded = Buffer.from(line.split(' ').at(-1) ?? '', 'base64').toString('utf16le')
    expect(decoded).not.toContain('# ')
    expect(decoded.trimEnd().endsWith(`} '2.6.0' 'floti-2.6.0-windows-x64.exe' '${'f'.repeat(64)}' '-'`)).toBe(true)
  })
})
