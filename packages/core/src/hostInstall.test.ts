import { describe, expect, it } from 'vitest'
import {
  chooseSource,
  describeInstallFailure,
  installFolderFor,
  judgeProtocol,
  parseShortVersion,
  parseSums,
  parseSystemLine,
  parseVersionLine,
  saysNotFound
} from './hostInstall'
import { flotiLine, flotiPathProblem, remoteHostsProblem } from './hosts'

describe('what a host’s computer answers', () => {
  it('reads floti’s version line: its version, protocol, OS and CPU', () => {
    expect(parseVersionLine('floti 2.6.0 protocol 1.0 linux x64\n')).toEqual({
      version: '2.6.0',
      protocol: '1.0',
      protocolNumbers: { major: 1, minor: 0 },
      os: 'linux',
      cpu: 'x64'
    })
    expect(parseVersionLine('Welcome to build-box\nfloti 2.4.1-preview.6 protocol 1.2 windows arm64\r\n')?.protocol).toBe(
      '1.2'
    )
    expect(parseVersionLine('floti 0.1.0')).toBeNull()
    expect(parseShortVersion('floti 0.1.0\n')).toBe('0.1.0')
  })

  it('S8: names the OS and CPU uname or Windows’ cmd gives, in that computer’s own words', () => {
    expect(parseSystemLine('Linux x86_64\n')).toEqual({ os: 'linux', cpu: 'x64', label: 'Linux · x86_64' })
    expect(parseSystemLine('Darwin arm64')).toEqual({ os: 'macos', cpu: 'arm64', label: 'macOS · arm64' })
    expect(parseSystemLine('Linux aarch64')).toEqual({ os: 'linux', cpu: 'arm64', label: 'Linux · aarch64' })
    expect(parseSystemLine('Windows_NT AMD64\r\n')).toEqual({ os: 'windows', cpu: 'x64', label: 'Windows · AMD64' })
    expect(parseSystemLine('MINGW64_NT-10.0-26100 x86_64')?.os).toBe('windows')
    expect(parseSystemLine('FreeBSD arm64')).toEqual({ os: null, cpu: 'arm64', label: 'FreeBSD · arm64' })
    // A shell that is neither leaves cmd's variables as they are.
    expect(parseSystemLine('%OS% %PROCESSOR_ARCHITECTURE%')).toBeNull()
    expect(parseSystemLine('')).toBeNull()
  })

  it('tells a login with no floti from any other failure', () => {
    expect(saysNotFound(127, 'sh: 1: floti: not found')).toBe(true)
    expect(saysNotFound(1, 'bash: line 1: floti: command not found')).toBe(true)
    expect(
      saysNotFound(
        1,
        "'floti' is not recognized as an internal or external command,\noperable program or batch file."
      )
    ).toBe(true)
    expect(saysNotFound(null, 'sh: 1: floti: not found')).toBe(true)
    expect(saysNotFound(255, 'ssh: Could not resolve hostname lab: Name or service not known')).toBe(false)
    expect(saysNotFound(255, 'Warning: Identity file id not accessible: No such file or directory')).toBe(false)
    expect(saysNotFound(3, 'floti connect: no Floti host is running there.')).toBe(false)
  })
})

describe('P6: whether this Helm can talk to the floti there', () => {
  const ours = { major: 1, minor: 2 }
  it('accepts its own protocol and a host one minor ahead', () => {
    expect(judgeProtocol({ major: 1, minor: 2 }, ours)).toBe('ok')
    expect(judgeProtocol({ major: 1, minor: 3 }, ours)).toBe('ok')
  })
  it('S13: a host behind this Helm is too old, to be updated there', () => {
    expect(judgeProtocol({ major: 1, minor: 1 }, ours)).toBe('tooOld')
    expect(judgeProtocol({ major: 0, minor: 9 }, ours)).toBe('tooOld')
  })
  it('S19: a host further ahead is newer, and this Helm is the one to update', () => {
    expect(judgeProtocol({ major: 1, minor: 4 }, ours)).toBe('newer')
    expect(judgeProtocol({ major: 2, minor: 0 }, ours)).toBe('newer')
  })
})

describe('which floti goes to a computer', () => {
  const sums = parseSums(
    [
      `${'a'.repeat(64)}  floti-2.6.0-linux-x64`,
      `${'B'.repeat(64)} *floti-2.6.0-windows-arm64.exe`,
      'not a sum line'
    ].join('\n')
  )
  const linux = { os: 'linux' as const, cpu: 'x64', label: 'Linux · x86_64' }

  it('reads sha256sum’s list, in text or binary mode', () => {
    expect([...sums]).toEqual([
      ['floti-2.6.0-linux-x64', 'a'.repeat(64)],
      ['floti-2.6.0-windows-arm64.exe', 'b'.repeat(64)]
    ])
  })

  it('S10: this Helm’s own floti when that computer’s OS and CPU are this PC’s', () => {
    expect(
      chooseSource({ system: linux, desktop: { platform: 'linux', arch: 'x64' }, ownBuild: true, version: '2.6.0', sums: null })
    ).toEqual({ how: 'copy' })
  })

  it('S11: the release’s build for that target, with the SHA-256 this Helm carries for it, when they differ', () => {
    expect(
      chooseSource({ system: linux, desktop: { platform: 'win32', arch: 'x64' }, ownBuild: true, version: '2.6.0', sums })
    ).toEqual({ how: 'download', file: 'floti-2.6.0-linux-x64', sha256: 'a'.repeat(64) })
    const windowsArm = { os: 'windows' as const, cpu: 'arm64', label: 'Windows · ARM64' }
    expect(
      chooseSource({ system: windowsArm, desktop: { platform: 'darwin', arch: 'arm64' }, ownBuild: true, version: '2.6.0', sums })
    ).toEqual({ how: 'download', file: 'floti-2.6.0-windows-arm64.exe', sha256: 'b'.repeat(64) })
  })

  it('S12: none for an OS or CPU no floti is built for, or with no published floti and a computer this build does not fit', () => {
    const freebsd = { os: null, cpu: 'arm64', label: 'FreeBSD · arm64' }
    const none = chooseSource({ system: freebsd, desktop: { platform: 'linux', arch: 'arm64' }, ownBuild: true, version: '2.6.0', sums })
    expect(none).toEqual({ how: 'none', reason: 'There is no floti for FreeBSD · arm64 yet.' })
    const macX64 = { os: 'macos' as const, cpu: 'x64', label: 'macOS · x86_64' }
    expect(chooseSource({ system: macX64, desktop: { platform: 'win32', arch: 'x64' }, ownBuild: true, version: '2.6.0', sums }).how).toBe(
      'none'
    )
    const dev = chooseSource({ system: linux, desktop: { platform: 'win32', arch: 'x64' }, ownBuild: true, version: '2.6.0', sums: null })
    expect(dev).toEqual({
      how: 'none',
      reason: 'This Helm 2.6.0 has no published floti to send, and its own floti is not for Linux · x86_64.'
    })
  })

  it('puts floti in the user’s own folder there', () => {
    expect(installFolderFor('linux')).toBe('~/.local/bin')
    expect(installFolderFor('macos')).toBe('~/.local/bin')
    expect(installFolderFor('windows')).toBe('%LOCALAPPDATA%\\Programs\\Floti\\bin')
  })

  it('S15: names the step that failed, and says a floti that was there still works', () => {
    expect(describeInstallFailure('install', 'build-box', '~/.local/bin')).toEqual({
      title: 'Installing floti on build-box failed',
      fix: 'Nothing replaced a floti that was there. Check that ~/.local/bin there can be written to and, for a download, that build-box reaches github.com, then try again.'
    })
    expect(describeInstallFailure('stop', 'build-box', '~/.local/bin').fix).toContain('its sessions are still running')
  })
})

describe('S16: the floti a host keeps by its full path', () => {
  it('starts every line with it, quoted as the bridge quotes it', () => {
    expect(flotiLine(undefined, 'version')).toBe('floti version')
    expect(flotiLine('/home/me/.local/bin/floti', 'setup')).toBe('/home/me/.local/bin/floti setup')
    expect(flotiLine('C:\\Users\\Me Too\\AppData\\Local\\Programs\\Floti\\bin\\floti.exe', 'version')).toBe(
      '"C:\\Users\\Me Too\\AppData\\Local\\Programs\\Floti\\bin\\floti.exe" version'
    )
  })

  it('keeps only a full path a shell reads as one word, as the bridge does', () => {
    expect(flotiPathProblem('/home/me/.local/bin/floti')).toBeNull()
    expect(flotiPathProblem('C:/Users/me/floti.exe')).toBeNull()
    expect(flotiPathProblem('.local/bin/floti')).toContain('not a full path')
    expect(flotiPathProblem('/home/$USER/floti')).toContain('a character a shell')
    const host = { id: 'h', name: 'build-box', transport: { kind: 'ssh' as const, target: 'build-box' } }
    expect(remoteHostsProblem([{ ...host, floti: '/home/me/.local/bin/floti' }])).toBeNull()
    expect(remoteHostsProblem([{ ...host, floti: 'floti' }])).toContain('expected the floti path for "build-box"')
  })
})
