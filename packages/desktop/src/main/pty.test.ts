import { afterEach, describe, expect, it, vi } from 'vitest'
import { ptyEnv } from './pty'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ptyEnv', () => {
  it('tells a hosted program the terminal shows hyperlinks, whatever Helm inherited', () => {
    expect(ptyEnv().FORCE_HYPERLINK).toBe('1')

    // The pane opens them either way; a program told otherwise would only
    // print its links as plain text.
    vi.stubEnv('FORCE_HYPERLINK', '0')
    expect(ptyEnv().FORCE_HYPERLINK).toBe('1')
  })
})
