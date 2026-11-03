import { describe, expect, it } from 'vitest'
import {
  describeTransport,
  formatCommandLine,
  lineToTryByHand,
  LOCAL_HOST_KEY,
  remoteHostFromDraft,
  remoteHostsProblem,
  type RemoteHost,
  type RemoteHostDraft,
  splitCommandLine,
  sshTargetProblem,
  storedRemoteHosts,
  transportFix,
  withoutRemoteHost
} from './hosts'
import { DEFAULT_SETTINGS, quitChoice, quitEndsSessions } from './types'

const words = (line: string): string[] => {
  const split = splitCommandLine(line)
  if (!split.ok) throw new Error(split.error)
  return split.words
}

describe('splitCommandLine', () => {
  it('splits on whitespace, however much of it', () => {
    expect(words('  wsl.exe   -d\tUbuntu  ')).toEqual(['wsl.exe', '-d', 'Ubuntu'])
  })

  it('keeps a quoted stretch in one word, spaces and all, joined to what touches it', () => {
    expect(words('"C:\\Program Files\\Tunnel\\tunnel.exe" --host \'my box\' a"b c"d')).toEqual([
      'C:\\Program Files\\Tunnel\\tunnel.exe',
      '--host',
      'my box',
      'ab cd'
    ])
  })

  it('treats a backslash as an ordinary character, so a Windows path is typed as written', () => {
    expect(words('C:\\Windows\\System32\\wsl.exe -d Ubuntu')).toEqual(['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu'])
  })

  it('puts a quote in a word with the other kind around it, and keeps an empty quoted word', () => {
    expect(words(`say '"' "'" ""`)).toEqual(['say', '"', "'", ''])
  })

  it('expands nothing', () => {
    expect(words('ssh $HOST ~/bin/* `id` $(id)')).toEqual(['ssh', '$HOST', '~/bin/*', '`id`', '$(id)'])
  })

  it('refuses a quote left open, and a line with no words', () => {
    expect(splitCommandLine('tunnel "my box')).toEqual({ ok: false, error: 'A double quote is not closed.' })
    expect(splitCommandLine("tunnel 'my box")).toEqual({ ok: false, error: 'A single quote is not closed.' })
    expect(splitCommandLine('   ')).toEqual({ ok: false, error: 'Type the command that reaches the host.' })
  })
})

describe('formatCommandLine', () => {
  it('writes words that split back to the same words', () => {
    for (const list of [
      ['wsl.exe', '-d', 'Ubuntu'],
      ['C:\\Program Files\\x.exe', 'my box', ''],
      ['say', '"', "'", `both"and'`],
      ['a"b', "c'd"]
    ]) {
      expect(words(formatCommandLine(list))).toEqual(list)
    }
    expect(formatCommandLine(['wsl.exe', '-d', 'Ubuntu Dev'])).toBe('wsl.exe -d "Ubuntu Dev"')
  })
})

describe('how a host is reached, said', () => {
  it('says ssh and the target, or the command, and the fix for each', () => {
    expect(describeTransport({ kind: 'ssh', target: 'you@build-box' })).toBe('ssh you@build-box')
    expect(describeTransport({ kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu Dev'] })).toBe(
      'wsl.exe -d "Ubuntu Dev"'
    )
    expect(transportFix({ kind: 'ssh', target: 'build-box' })).toBe(
      'Sign in with ssh build-box in a terminal, then try again.'
    )
  })

  it('S5: the line to try by hand is the transport as typed followed by floti connect, or the path floti was installed at', () => {
    expect(lineToTryByHand({ transport: { kind: 'ssh', target: 'build-box' } })).toBe('ssh build-box floti connect')
    expect(lineToTryByHand({ transport: { kind: 'command', program: 'wsl.exe', args: ['-d', 'Ubuntu Dev', '--'] } })).toBe(
      'wsl.exe -d "Ubuntu Dev" -- floti connect'
    )
    expect(
      lineToTryByHand({ transport: { kind: 'ssh', target: 'you@build-box' }, floti: '/home/you/.local/bin/floti' })
    ).toBe('ssh you@build-box /home/you/.local/bin/floti connect')
  })
})

describe('sshTargetProblem', () => {
  it('takes any one word ssh accepts as a target', () => {
    for (const target of ['build-box', 'you@build-box', 'you@10.0.0.4', 'ssh://you@build-box:2222']) {
      expect(sshTargetProblem(target)).toBeNull()
    }
  })

  it('refuses a target ssh would read as an option, one with spaces, and none', () => {
    expect(sshTargetProblem('-oProxyCommand=evil')).toContain('dash')
    expect(sshTargetProblem('build box')).toContain('spaces')
    expect(sshTargetProblem('')).toContain('Type the ssh target')
  })
})

describe('remoteHostFromDraft', () => {
  const draft = (patch: Partial<RemoteHostDraft>): RemoteHostDraft => ({
    name: '',
    via: 'ssh',
    target: '',
    command: '',
    ...patch
  })
  const existing: RemoteHost[] = [{ id: 'a', name: 'build-box', transport: { kind: 'ssh', target: 'build-box' } }]

  it('takes the ssh target as typed, and as the name when none is given', () => {
    expect(remoteHostFromDraft(draft({ target: '  you@lab  ' }), existing, 'b')).toEqual({
      ok: true,
      host: {
        id: 'b',
        name: 'you@lab',
        transport: { kind: 'ssh', target: 'you@lab' }
      }
    })
  })

  it('splits a command into its program and arguments', () => {
    expect(remoteHostFromDraft(draft({ name: 'wsl', via: 'command', command: 'wsl.exe -d "Ubuntu Dev" --' }), [], 'b')).toEqual({
      ok: true,
      host: {
        id: 'b',
        name: 'wsl',
        transport: {
          kind: 'command',
          program: 'wsl.exe',
          args: ['-d', 'Ubuntu Dev', '--']
        }
      }
    })
  })

  it('S5: adds a host with its name and how it is reached, and no role', () => {
    const added = remoteHostFromDraft(draft({ target: 'lab' }), [], 'b')
    expect(added).toEqual({
      ok: true,
      host: { id: 'b', name: 'lab', transport: { kind: 'ssh', target: 'lab' } }
    })
    expect(added.ok && 'role' in added.host).toBe(false)
  })

  it('S5: a host an earlier version saved with a role loads with the role dropped', () => {
    const host = {
      id: 'b',
      name: 'lab',
      transport: { kind: 'ssh', target: 'lab' }
    }
    const stored = [{ ...host, role: 'operator' }, { ...host, id: 'c', name: 'other', role: 'viewer' }, { ...host, id: 'd', name: 'plain' }]
    const loaded = storedRemoteHosts(stored)
    expect(loaded).toEqual([host, { ...host, id: 'c', name: 'other' }, { ...host, id: 'd', name: 'plain' }])
    expect(remoteHostsProblem(loaded)).toBeNull()
    // A value that is not a host list is left for the validator to name.
    expect(storedRemoteHosts('nonsense')).toBe('nonsense')
  })

  it('says what to fix rather than adding a host it could not use', () => {
    expect(remoteHostFromDraft(draft({ target: '-oX' }), [], 'b')).toMatchObject({ ok: false })
    expect(remoteHostFromDraft(draft({ via: 'command', command: '' }), [], 'b')).toMatchObject({ ok: false })
    expect(remoteHostFromDraft(draft({ via: 'command', command: 'tunnel' }), [], 'b')).toEqual({
      ok: false,
      error: 'Give the host a name.'
    })
    expect(remoteHostFromDraft(draft({ name: 'Build-Box', target: 'other' }), existing, 'b')).toEqual({
      ok: false,
      error: 'There is already a host named Build-Box.'
    })
    expect(remoteHostFromDraft(draft({ name: 'this pc', target: 'other' }), [], 'b')).toMatchObject({ ok: false })
    expect(remoteHostFromDraft(draft({ target: 'other' }), [], LOCAL_HOST_KEY)).toMatchObject({ ok: false })
  })
})

describe('quitting, per host', () => {
  it('ends this PC’s sessions and keeps a remote host’s until the setting says otherwise', () => {
    expect(quitChoice(DEFAULT_SETTINGS)).toBe('end')
    expect(quitChoice(DEFAULT_SETTINGS, 'build')).toBe('keep')
    const set = { quitSessions: { local: 'keep', build: 'end' } } as const
    expect(quitEndsSessions(set)).toBe(false)
    expect(quitEndsSessions(set, 'build')).toBe(true)
    expect(quitEndsSessions(set, 'other')).toBe(false)
  })

  it('forgets a removed host and its quit choice, and nothing else', () => {
    const hosts: RemoteHost[] = [
      { id: 'a', name: 'a', transport: { kind: 'ssh', target: 'a' } },
      { id: 'b', name: 'b', transport: { kind: 'ssh', target: 'b' } }
    ]
    expect(withoutRemoteHost({ hosts, quitSessions: { local: 'keep', a: 'end', b: 'end' } }, 'a')).toEqual({
      hosts: [hosts[1]],
      quitSessions: { local: 'keep', b: 'end' }
    })
  })
})
