import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, sanitizeSessionName, uniqueSessionName } from './session'

describe('buildClaudeArgs', () => {
  it('names every session, so /resume shows something recognisable', () => {
    expect(buildClaudeArgs({ cwd: 'C:\\repos\\alpha', name: 'alpha' })).toEqual(['-n', 'alpha'])
  })

  it('appends extra args after the generated flags', () => {
    expect(
      buildClaudeArgs({ cwd: 'C:\\repos\\alpha', name: 'alpha', extraArgs: ['--model', 'opus'] })
    ).toEqual(['-n', 'alpha', '--model', 'opus'])
  })

  it('sanitises the name on the way into argv, not only in the UI', () => {
    expect(buildClaudeArgs({ cwd: 'C:\\x', name: '  ' })).toEqual(['-n', 'session'])
  })
})

describe('sanitizeSessionName', () => {
  it('keeps an ordinary name untouched', () => {
    expect(sanitizeSessionName('atlas accruals')).toBe('atlas accruals')
  })

  it('leaves spaces alone - the name is one argv entry, not a shell word', () => {
    expect(sanitizeSessionName('cloud sync audit')).toBe('cloud sync audit')
  })

  it('replaces control and zero-width characters, which are invisible in a name', () => {
    expect(sanitizeSessionName('alpha\u0000\u001bbeta')).toBe('alpha beta')
    expect(sanitizeSessionName('alpha\u200bbeta')).toBe('alpha beta')
  })

  it('collapses the whitespace that leaves behind', () => {
    expect(sanitizeSessionName('  alpha \t\n beta  ')).toBe('alpha beta')
  })

  it('falls back rather than handing the CLI an empty -n value', () => {
    expect(sanitizeSessionName('')).toBe('session')
    expect(sanitizeSessionName('\u0007\u0007')).toBe('session')
  })

  it('caps the length so a pasted path does not become the tab title', () => {
    const name = sanitizeSessionName('x'.repeat(200))
    expect(name).toHaveLength(60)
  })

  it('keeps non-ASCII, which is a legitimate name and not a control character', () => {
    expect(sanitizeSessionName('會計 🚀')).toBe('會計 🚀')
  })
})

describe('uniqueSessionName', () => {
  it('uses the base name when nothing has taken it', () => {
    expect(uniqueSessionName('helm', [])).toBe('helm')
  })

  it('counts up past the names already in use', () => {
    expect(uniqueSessionName('helm', ['helm'])).toBe('helm 2')
    expect(uniqueSessionName('helm', ['helm', 'helm 2', 'helm 3'])).toBe('helm 4')
  })

  it('fills a gap rather than always taking the highest', () => {
    expect(uniqueSessionName('helm', ['helm', 'helm 3'])).toBe('helm 2')
  })

  it('compares case-insensitively, because a person reads these', () => {
    expect(uniqueSessionName('Helm', ['helm'])).toBe('Helm 2')
  })

  it('terminates for a base already at the length cap', () => {
    const long = 'x'.repeat(60)
    const name = uniqueSessionName(long, [long])

    expect(name).not.toBe(long)
    expect(name.length).toBeLessThanOrEqual(60)
    expect(name.endsWith(' 2')).toBe(true)
  })
})
