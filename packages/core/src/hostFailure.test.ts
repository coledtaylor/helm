import { describe, expect, it } from 'vitest'
import { classifyHostFailure, type HostFailureInput } from './hostFailure'
import { NO_HOST_LINE } from './hostInstall'
import type { HostTransport } from './hosts'

const SSH: HostTransport = { kind: 'ssh', target: 'build-box' }
const COMMAND: HostTransport = { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu', '--'] }

const classify = (lastLine: string, more: Partial<HostFailureInput> = {}) =>
  classifyHostFailure({ name: 'build-box', transport: SSH, lastLine, ...more })

describe('what went wrong reaching a host, one row of the design’s table each', () => {
  it('S10: this PC has no ssh', () => {
    const failure = classify('Helm could not run ssh on this PC (ENOENT).', { cause: { kind: 'transportMissing' } })
    expect(failure).toMatchObject({
      kind: 'noTransport',
      title: 'Helm could not find ssh on this PC',
      line: 'Helm could not run ssh on this PC (ENOENT).'
    })
    expect(failure.fix).toContain('Install the OpenSSH client (on Windows, Settings > System > Optional features)')
  })

  it('S9, S10: a command whose program is not on this PC names that program', () => {
    const failure = classifyHostFailure({
      name: 'lab',
      transport: COMMAND,
      lastLine: 'Helm could not run wsl.exe on this PC (ENOENT).',
      cause: { kind: 'transportMissing' }
    })
    expect(failure.title).toBe('Helm could not find wsl.exe on this PC')
  })

  it('S11: the name does not resolve', () => {
    const line = 'ssh: Could not resolve hostname build-box: Name or service not known'
    const failure = classify(line)
    expect(failure).toMatchObject({ kind: 'unresolved', title: 'ssh does not know build-box', saidBy: 'ssh said', line })
    expect(failure.fix).toContain('add a Host for it to ~/.ssh/config')
  })

  it('S12: timed out, refused or no route', () => {
    for (const line of [
      'ssh: connect to host 100.84.12.7 port 22: Connection timed out',
      'ssh: connect to host build-box port 22: Connection refused',
      'ssh: connect to host build-box port 22: No route to host'
    ]) {
      const failure = classify(line)
      expect(failure).toMatchObject({ kind: 'unreachable', title: 'Can’t reach build-box', line, chip: 'Unreachable' })
      expect(failure.fix).toContain('its SSH server is running')
      expect(failure.fix).toContain('ssh build-box')
    }
  })

  it('S13: ssh wants a password, passphrase or code', () => {
    const failure = classify('build-box: Permission denied (publickey,password).')
    expect(failure).toMatchObject({ kind: 'password', title: 'build-box wants a password', chip: 'Needs a key' })
    expect(failure.fix).toContain('loaded into the SSH agent, so ssh build-box gets in without asking')
  })

  it('S14: ssh has not seen the host’s key', () => {
    const said = 'No ED25519 host key is known for build-box and you have requested strict checking.\nHost key verification failed.'
    const failure = classify('Host key verification failed.', { said })
    expect(failure).toMatchObject({ kind: 'unknownKey', title: 'ssh does not trust build-box yet', line: 'Host key verification failed.' })
    expect(failure.fix).toBe('Run ssh build-box once in a terminal and check the fingerprint it shows. Helm never accepts a host key for you.')
  })

  it('S14: the host’s key changed, told from the lines before the last', () => {
    const said = [
      '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
      'Host key for build-box has changed and you have requested strict checking.',
      'Host key verification failed.'
    ].join('\n')
    expect(classify('Host key verification failed.', { said })).toMatchObject({
      kind: 'hostKeyChanged',
      title: 'build-box’s host key changed'
    })
  })

  it('S15: the login prints text before the command runs', () => {
    const failure = classify('Welcome to build-box!', { cause: { kind: 'loginOutput' } })
    expect(failure).toMatchObject({
      kind: 'loginOutput',
      title: 'build-box’s login printed text where floti’s connection goes',
      saidBy: 'The login printed',
      line: 'Welcome to build-box!'
    })
    expect(failure.fix).toContain('run only for interactive shells')
  })

  it('S16: no build for its OS or CPU', () => {
    const failure = classify('There is no floti for FreeBSD · arm64 yet.', { cause: { kind: 'noBuild', system: 'FreeBSD arm64' } })
    expect(failure).toMatchObject({ kind: 'noBuild', title: 'There is no floti for FreeBSD arm64 yet' })
  })

  it('S17: the install failed, with the script’s last line', () => {
    const failure = classify('floti-install: the SHA-256 does not match', {
      cause: { kind: 'install', step: 'install', folder: '~/.local/bin' }
    })
    expect(failure).toMatchObject({
      kind: 'installFailed',
      title: 'Installing floti on build-box failed',
      saidBy: 'The install script said',
      line: 'floti-install: the SHA-256 does not match'
    })
    expect(failure.fix).toBe('Run the install command in a terminal there to see all of its output, then try again.')
  })

  it('S18: its floti is newer than this Helm, naming both versions', () => {
    const failure = classify('floti 3.2.0 protocol 2.0 linux x64', {
      cause: { kind: 'newer', host: '3.2.0', ours: '3.0.0', by: 'version' }
    })
    expect(failure).toMatchObject({ kind: 'newer', title: 'build-box runs floti 3.2.0, newer than this Helm 3.0.0' })
    expect(failure.fix).toBe('Update Helm on this PC, then try again.')
  })

  it('S19: a connection that fails after the check shows floti’s line with its fix, never a pairing code', () => {
    const failure = classify(NO_HOST_LINE, { step: 'connect' })
    expect(failure).toMatchObject({ kind: 'notRunning', saidBy: 'floti said', line: NO_HOST_LINE })
    expect(JSON.stringify(failure)).not.toMatch(/pair|approve|code/i)
  })

  it('a line it does not know falls back to the transport’s own fix', () => {
    expect(classify('kex_exchange_identification: read: Connection reset by peer', { step: 'check' })).toMatchObject({
      kind: 'other',
      title: 'Helm could not check build-box',
      fix: 'Sign in with ssh build-box in a terminal, then try again.'
    })
  })

  it('S9: a command’s failure says the command said it, and its fix names the command', () => {
    const failure = classifyHostFailure({
      name: 'lab',
      transport: COMMAND,
      lastLine: 'wsl: There is no distribution with the supplied name.'
    })
    expect(failure.saidBy).toBe('The command said')
    expect(failure.fix).toContain('wsl.exe -d Ubuntu --')
  })
})
describe('what went wrong reaching a WSL distro', () => {
  const HERE: HostTransport = { kind: 'wsl', distro: 'Debian' }
  const THERE: HostTransport = {
    kind: 'wsl',
    distro: 'Ubuntu',
    through: 'win-box'
  }

  it('S10: the picked distro is not there: wsl.exe’s last line as written, and wsl --list as the fix', () => {
    const said = 'There is no distribution with the supplied name.\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    const lastLine = 'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
    const failure = classifyHostFailure({
      name: 'Debian',
      transport: HERE,
      lastLine,
      said,
      step: 'check'
    })
    expect(failure).toMatchObject({
      kind: 'noDistro',
      title: 'WSL has no distro named Debian on this PC',
      saidBy: 'wsl.exe said',
      line: lastLine
    })
    expect(failure.fix).toContain('wsl --list in a terminal shows the distros there')
    const there = classifyHostFailure({
      name: 'Ubuntu on win-box',
      transport: THERE,
      lastLine,
      said
    })
    expect(there.title).toBe('WSL has no distro named Ubuntu on win-box')
    expect(there.fix).toContain('wsl --list in a terminal on win-box')
  })

  it('S10: this PC has no WSL: its wsl.exe is not there, or says WSL is not installed; the fix is wsl --install', () => {
    const missing = classifyHostFailure({
      name: 'Debian',
      transport: HERE,
      lastLine: 'Helm could not run C:\\Windows\\System32\\wsl.exe on this PC (ENOENT).',
      cause: { kind: 'transportMissing' }
    })
    expect(missing).toMatchObject({
      kind: 'noWsl',
      title: 'WSL is not installed on this PC',
      chip: 'No WSL'
    })
    expect(missing.fix).toContain('wsl --install')
    const line = "The Windows Subsystem for Linux is not installed. You can install by running 'wsl.exe --install'."
    expect(classifyHostFailure({ name: 'Debian', transport: HERE, lastLine: line })).toMatchObject({
      kind: 'noWsl',
      line
    })
  })

  it('a distro through a PC that ssh cannot reach reads as ssh’s failure, naming that PC', () => {
    const line = 'ssh: Could not resolve hostname win-box: Name or service not known'
    const failure = classifyHostFailure({
      name: 'Ubuntu on win-box',
      transport: THERE,
      lastLine: line
    })
    expect(failure).toMatchObject({
      kind: 'unresolved',
      title: 'ssh does not know win-box',
      saidBy: 'ssh said'
    })
    const noSsh = classifyHostFailure({
      name: 'Ubuntu on win-box',
      transport: THERE,
      lastLine: 'Helm could not run ssh on this PC (ENOENT).',
      cause: { kind: 'transportMissing' }
    })
    expect(noSsh.kind).toBe('noTransport')
  })

  it('anything else falls back to running the transport by hand', () => {
    const failure = classifyHostFailure({
      name: 'Debian',
      transport: HERE,
      lastLine: 'something else'
    })
    expect(failure).toMatchObject({ kind: 'other', saidBy: 'wsl.exe said' })
    expect(failure.fix).toBe('Run wsl.exe -d Debian in a terminal to see what it needs, then try again.')
  })
})
