import { describe, expect, it } from 'vitest'
import { commandTone } from './sessionstate'

describe('commandTone', () => {
  it('is success while the command runs', () => {
    expect(commandTone('running')).toBe('text-success')
  })

  it('is fg-subtle once it ended, and when its state is not known', () => {
    expect(commandTone('ended')).toBe('text-fg-subtle')
    expect(commandTone(null)).toBe('text-fg-subtle')
  })

  it('is danger for a command that exited with a code other than 0', () => {
    expect(commandTone('failed')).toBe('text-danger')
  })
})
