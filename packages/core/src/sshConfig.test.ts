import { describe, expect, it } from 'vitest'
import { firstSeen, globSegmentMatcher, includePath, isGlobSegment, parseSshConfig } from './sshConfig'

describe('reading the Host names of an ssh config', () => {
  it('S3: lists each Host name, several to a line, with the keyword in any case and the = form', () => {
    const text = [
      'Host build-box',
      '  HostName 100.84.12.7',
      '  User me',
      'host studio-mac homelab',
      'HOST=lab',
      'Host = "quoted name"'
    ].join('\n')
    expect(parseSshConfig(text)).toEqual({ hosts: ['build-box', 'studio-mac', 'homelab', 'lab', 'quoted name'], includes: [] })
  })

  it('S3, S4: leaves out every name holding *, ? or !', () => {
    const text = 'Host *\nHost *.corp build-? !bastion real-one\nHost web?\n'
    expect(parseSshConfig(text).hosts).toEqual(['real-one'])
  })

  it('S4: reads nothing but Host and Include lines: comments, Match blocks and every other keyword are passed over', () => {
    const text = [
      '# Host commented-out',
      'Match host build-box',
      '  IdentityFile ~/.ssh/id_ed25519',
      '  ProxyCommand ssh -W %h:%p jump',
      'HostName secret.example',
      'HostKeyAlias alias',
      'Include config.d/*',
      'Include ~/other "with space"'
    ].join('\r\n')
    expect(parseSshConfig(text)).toEqual({ hosts: [], includes: ['config.d/*', '~/other', 'with space'] })
  })

  it('S4: an empty config names nothing', () => {
    expect(parseSshConfig('')).toEqual({ hosts: [], includes: [] })
  })

  it('keeps each name once, in the order first seen', () => {
    expect(firstSeen(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })
})

describe('the files an Include line names', () => {
  it('S3: reads a relative path under ~/.ssh, ~ as the home folder, and an absolute path as itself', () => {
    expect(includePath('config.d/work', '/home/me/.ssh', '/home/me')).toBe('/home/me/.ssh/config.d/work')
    expect(includePath('~/ssh-extra', '/home/me/.ssh', '/home/me')).toBe('/home/me/ssh-extra')
    expect(includePath('/etc/ssh/extra', '/home/me/.ssh', '/home/me')).toBe('/etc/ssh/extra')
    expect(includePath('config.d\\work', 'C:\\Users\\me\\.ssh', 'C:\\Users\\me')).toBe('C:/Users/me/.ssh/config.d\\work')
    expect(includePath('C:\\keys\\more', 'C:\\Users\\me\\.ssh', 'C:\\Users\\me')).toBe('C:/keys/more')
  })

  it('S3: matches a glob segment as glob(3) does, leaving dot files to a pattern that names the dot', () => {
    expect(isGlobSegment('*.conf')).toBe(true)
    expect(isGlobSegment('work')).toBe(false)
    const conf = globSegmentMatcher('*.conf')
    expect(conf('a.conf')).toBe(true)
    expect(conf('a.conf.bak')).toBe(false)
    expect(conf('.hidden.conf')).toBe(false)
    expect(globSegmentMatcher('host-?')('host-1')).toBe(true)
    expect(globSegmentMatcher('[ab]*')('beta')).toBe(true)
    expect(globSegmentMatcher('[!ab]*')('beta')).toBe(false)
    expect(globSegmentMatcher('.*')('.hidden')).toBe(true)
  })
})
