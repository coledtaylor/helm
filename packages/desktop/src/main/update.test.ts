import { describe, expect, it, vi } from 'vitest'
import { isNewer } from './update'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

describe('isNewer', () => {
  it('is true only for a strictly higher release', () => {
    expect(isNewer('1.2.0', '1.2.0')).toBe(false)
    expect(isNewer('1.2.0', '1.2.1')).toBe(true)
    expect(isNewer('1.2.0', '1.3.0')).toBe(true)
    expect(isNewer('1.2.0', '2.0.0')).toBe(true)
    expect(isNewer('1.2.0', '1.1.9')).toBe(false)
    expect(isNewer('1.10.0', '1.9.0')).toBe(false)
  })

  it('never nags about a tag it cannot read', () => {
    expect(isNewer('1.2.0', 'latest')).toBe(false)
    expect(isNewer('not a version', '9.9.9')).toBe(false)
  })
})
