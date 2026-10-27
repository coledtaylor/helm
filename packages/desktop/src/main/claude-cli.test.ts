import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeFakeClaude } from '../../test/world'
import { installCandidates, readClaudeVersion, resolveClaudeCommand } from './claude-cli'

/**
 * Finding `claude` where an install leaves it on each OS, and running the fake
 * one the tests use in the form this OS's install would have.
 */

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

describe('the fake claude', () => {
  let bin: string
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 'helm fake bin-'))
  })
  afterAll(() => rmSync(bin, { recursive: true, force: true }))

  it("is written as this OS's install would leave it, and runs from a path with spaces", async () => {
    const claude = writeFakeClaude(bin)
    expect(claude.endsWith(process.platform === 'win32' ? 'claude.cmd' : 'claude')).toBe(true)
    const command = resolveClaudeCommand(claude)
    expect(command).toMatchObject({ resolved: claude, shim: process.platform === 'win32' })
    expect(await readClaudeVersion(claude)).toMatch(/\d+\.\d+\.\d+/)
  })
})
