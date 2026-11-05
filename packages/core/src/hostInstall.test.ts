import { describe, expect, it } from 'vitest'
import {
  chooseSource,
  compareVersions,
  describeInstallFailure,
  hostFlotiOlder,
  installFolderFor,
  judgeProtocol,
  localHostVersions,
  localHostVersionsSentence,
  parseShortVersion,
  parseSums,
  parseSystemLine,
  parseVersionLine,
  restartHostDetail,
  restartHostQuestion,
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

describe('S9: whether this PC’s host runs an older floti than this Helm', () => {
  it('orders releases by their numbers, and a prerelease before its release', () => {
    expect(compareVersions('2.4.0', '2.4.1')).toBe(-1)
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
    expect(compareVersions('2.4.1-preview.7', '2.4.1')).toBe(-1)
    expect(compareVersions('2.4.1-preview.7', '2.4.1-preview.10')).toBe(-1)
    expect(compareVersions('2.4.1-preview.7', '2.4.0')).toBe(1)
    expect(compareVersions('2.4.1-preview', '2.4.1-preview.1')).toBe(-1)
    expect(compareVersions('2.4.1-1', '2.4.1-alpha')).toBe(-1)
    expect(compareVersions('2.4.1+build.3', '2.4.1')).toBe(0)
  })

  it('S9: a host on an earlier floti, a prerelease included, is older', () => {
    expect(hostFlotiOlder('2.4.0', '2.4.1')).toBe(true)
    expect(hostFlotiOlder('2.4.1-preview.6', '2.4.1-preview.7')).toBe(true)
  })

  it('S10: the same floti, a newer one, or one that does not read is never older', () => {
    expect(hostFlotiOlder('2.4.1-preview.7', '2.4.1-preview.7')).toBe(false)
    expect(hostFlotiOlder('2.5.0', '2.4.1')).toBe(false)
    expect(hostFlotiOlder('dev', '2.4.1')).toBe(false)
    expect(compareVersions('dev', '2.4.1')).toBeNull()
  })
})

describe('S12 and S13: the restart question says first what ends', () => {
  it('S12: a host whose sessions the carried floti takes over says no session ends', () => {
    const offer = { hostVersion: '2.4.0', sessions: 3, ends: 0 }
    expect(restartHostQuestion(offer, '2.4.1')).toBe('Restart this PC’s host on floti 2.4.1? No session ends.')
    expect(restartHostDetail(offer)).toContain('keeps running, with its screen')
  })

  it('S13: one whose keeper the carried floti cannot speak to names how many sessions end', () => {
    const offer = { hostVersion: '2.4.0', sessions: 2, ends: 2 }
    expect(restartHostQuestion(offer, '2.4.1')).toBe('Restart this PC’s host on floti 2.4.1, ending 2 sessions?')
    expect(restartHostQuestion({ ...offer, sessions: 1, ends: 1 }, '2.4.1')).toBe(
      'Restart this PC’s host on floti 2.4.1, ending 1 session?'
    )
    expect(restartHostDetail(offer)).toContain('offers them back once')
  })
})

describe('which of this PC’s host and this Helm is behind', () => {
  it('S7: a refusal saying to update the host marks this PC’s host older, naming both protocols', () => {
    expect(
      localHostVersions({ refused: { host: { major: 2, minor: 0 }, client: { major: 2, minor: 1 }, update: 'host' } }, '2.5.0')
    ).toEqual({ older: 'host', host: 'protocol 2.0', helm: 'protocol 2.1', stopFromMenu: false })
  })

  it('S8: a refusal saying to update the client says this Helm is the one behind', () => {
    expect(
      localHostVersions({ refused: { host: { major: 2, minor: 2 }, client: { major: 2, minor: 0 }, update: 'client' } }, '2.4.1')
    ).toEqual({ older: 'helm', host: 'protocol 2.2', helm: 'protocol 2.0' })
  })

  it('S15: a host on protocol 1.x is stopped from its notification-area menu rather than restarted', () => {
    expect(
      localHostVersions({ refused: { host: { major: 1, minor: 4 }, client: { major: 2, minor: 0 }, update: 'host' } }, '2.4.1')
    ).toEqual({ older: 'host', host: 'protocol 1.4', helm: 'protocol 2.0', stopFromMenu: true })
  })

  it('S9: a welcome naming an earlier floti marks the host older; S10: the same floti, nothing', () => {
    expect(localHostVersions({ hostVersion: '2.4.1-preview.6' }, '2.4.1-preview.7')).toEqual({
      older: 'host',
      host: '2.4.1-preview.6',
      helm: '2.4.1-preview.7',
      stopFromMenu: false
    })
    expect(localHostVersions({ hostVersion: '2.4.1-preview.7' }, '2.4.1-preview.7')).toBeNull()
  })
})

describe('what is said of this PC’s host’s version', () => {
  it('S9: an older host names both flotis and offers the restart', () => {
    expect(localHostVersionsSentence({ older: 'host', host: '2.4.0', helm: '2.4.1', stopFromMenu: false })).toBe(
      'This PC’s host runs floti 2.4.0, older than the floti 2.4.1 this Helm carries. Restart host to update says first what it ends.'
    )
  })

  it('S8: a Helm behind its host is told to update Helm on this PC', () => {
    expect(localHostVersionsSentence({ older: 'helm', host: 'protocol 2.2', helm: 'protocol 2.0' })).toContain(
      'runs Floti protocol 2.2, newer than the Floti protocol 2.0 this Helm speaks, so Helm cannot connect to it. Update Helm on this PC.'
    )
  })

  it('S15: a host on protocol 1.x is told to stop through Stop host in its notification-area menu, which ends its sessions, after which Helm starts the host it carries and History offers them to resume', () => {
    const sentence = localHostVersionsSentence({
      older: 'host',
      host: 'protocol 1.4',
      helm: 'protocol 2.0',
      stopFromMenu: true
    })
    expect(sentence).toContain('runs Floti protocol 1.4, older than the Floti protocol 2.0 this Helm carries')
    expect(sentence).toContain('Stop it with Stop host in its notification-area menu, which ends its sessions')
    expect(sentence).toContain('Helm then starts the floti it carries, and History offers each ended session to resume.')
  })
})
