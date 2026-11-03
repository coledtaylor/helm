import { describe, expect, it } from 'vitest'
import { describeAgents, type AgentStatus } from './hostAgents'

const installed = (signedIn: AgentStatus['signedIn'], more: Partial<AgentStatus> = {}): AgentStatus => ({
  installed: true,
  version: '2.1.241 (Claude Code)',
  semver: '2.1.241',
  signedIn,
  signInSignal: 'credentials file',
  error: null,
  ...more
})

const missing: AgentStatus = {
  installed: false,
  version: null,
  semver: null,
  signedIn: { state: 'unknown' },
  signInSignal: 'not installed',
  error: 'claude was not found on PATH'
}

describe('the agents on a host being added', () => {
  it('S22: Claude Code installed and signed in, with the version it reported', () => {
    expect(describeAgents({ 'claude-code': installed({ state: 'known', value: true }) }, 'linux')).toEqual([
      { id: 'claude-code', name: 'Claude Code', version: 'claude 2.1.241', installed: true, signIn: 'signedIn', fix: null }
    ])
  })

  it('S23: not installed names the line to install it there, by that computer’s OS', () => {
    expect(describeAgents({ 'claude-code': missing }, 'linux')[0]).toMatchObject({
      installed: false,
      fix: 'Install it there with curl -fsSL https://claude.ai/install.sh | bash'
    })
    expect(describeAgents({ 'claude-code': missing }, 'windows')[0]?.fix).toBe(
      'Install it there with irm https://claude.ai/install.ps1 | iex'
    )
  })

  it('S23: not signed in names its login command', () => {
    expect(describeAgents({ 'claude-code': installed({ state: 'known', value: false }) }, 'linux')[0]).toMatchObject({
      signIn: 'notSignedIn',
      fix: 'Sign in by running claude there once, in a terminal. Helm never handles its sign-in.'
    })
  })

  it('S23: a sign-in it cannot tell is Unknown, saying why', () => {
    const row = describeAgents(
      { 'claude-code': installed({ state: 'unknown' }, { signInSignal: 'no sign-in check' }) },
      'macos'
    )[0]
    expect(row).toMatchObject({ signIn: 'unknown' })
    expect(row?.fix).toContain('no sign-in check')
  })

  it('an agent Helm has no table entry for is listed by its id, with no command named', () => {
    expect(describeAgents({ other: { ...missing } }, 'linux')).toEqual([
      { id: 'other', name: 'other', version: null, installed: false, signIn: 'unknown', fix: 'other is not installed there.' }
    ])
  })
})
