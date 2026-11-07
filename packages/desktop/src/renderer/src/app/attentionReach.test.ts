import { describe, expect, it } from 'vitest'
import { stackWidth } from './attentionReach'

describe('how wide the attention stack may be', () => {
  it('is no wider than the room left of the panes, so a browser view never cuts a toast off', () => {
    expect(stackWidth(312, 1280)).toBe(300)
    expect(stackWidth(420, 1280)).toBe(408)
  })

  it('is limited by the window alone when the sidebar is hidden or the panes are not drawn', () => {
    expect(stackWidth(null, 1280)).toBe(1264)
    expect(stackWidth(null, 300)).toBe(284)
  })

  it('stays inside a narrow window and never goes negative', () => {
    expect(stackWidth(312, 200)).toBe(184)
    expect(stackWidth(10, 1280)).toBe(0)
  })
})
