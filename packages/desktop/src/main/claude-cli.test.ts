import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installCandidates } from './claude-cli'

/** Finding `claude` where an install leaves it on each OS. */

describe('installCandidates', () => {
  it('looks in ~/.local/bin on every OS, for an .exe or .cmd first on Windows', () => {
    expect(installCandidates('win32', 'C:\\Users\\me')).toEqual([
      join('C:\\Users\\me', '.local', 'bin', 'claude.exe'),
      join('C:\\Users\\me', '.local', 'bin', 'claude.cmd'),
      join('C:\\Users\\me', '.local', 'bin', 'claude')
    ])
    expect(installCandidates('linux', '/home/me')).toEqual([join('/home/me', '.local', 'bin', 'claude')])
  })

  it("also looks where Homebrew installs on macOS, which a Finder-launched app's PATH lacks", () => {
    expect(installCandidates('darwin', '/Users/me')).toEqual([
      join('/Users/me', '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude'
    ])
  })
})
