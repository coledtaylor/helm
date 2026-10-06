import { describe, expect, it } from 'vitest'
import { activatePage, addPage, EMPTY_STRIP, movePage, pagesOf, removePage, type PageStrip } from './browserStrip'

/** Pages added in order, each by the user: at the end, in front. */
const strip = (...ids: number[]): PageStrip =>
  ids.reduce((current, id) => addPage(current, id, { after: null, background: false }), EMPTY_STRIP)

describe('browser strip', () => {
  it('lands a page after the pages its opener already opened, so a run of middle clicks reads in order', () => {
    let s = strip(1, 2)
    s = addPage(s, 10, { after: 1, background: true })
    s = addPage(s, 11, { after: 1, background: true })
    s = addPage(s, 12, { after: 1, background: true })
    expect(s.order).toEqual([1, 10, 11, 12, 2])
    expect(s.active).toBe(2)
  })

  it('puts a page whose opener is gone at the end, and the first page in front whatever it asked', () => {
    expect(addPage(strip(1), 2, { after: 99, background: false }).order).toEqual([1, 2])
    expect(addPage(EMPTY_STRIP, 5, { after: null, background: true }).active).toBe(5)
  })

  it('brings a page it already holds forward rather than adding it twice', () => {
    const s = strip(1, 2)
    expect(addPage(s, 1, { after: null, background: false })).toMatchObject({ order: [1, 2], active: 1 })
    expect(addPage(s, 1, { after: null, background: true })).toBe(s)
  })

  it('on closing the page in front, picks its opener, else the page to its right, else to its left', () => {
    const opened = addPage(strip(1, 2, 3), 4, { after: 1, background: false })
    expect(opened.order).toEqual([1, 4, 2, 3])
    expect(removePage(opened, 4).active).toBe(1)

    const plain = activatePage(strip(1, 2, 3), 2)
    expect(removePage(plain, 2).active).toBe(3)
    expect(removePage(strip(1, 2, 3), 3).active).toBe(2)
    expect(removePage(strip(1), 1)).toMatchObject({ order: [], active: null })
  })

  it('leaves the front alone when a page behind it closes, and forgets what the closed page opened', () => {
    let s = addPage(strip(1), 2, { after: 1, background: true })
    s = removePage(s, 1)
    expect(s).toMatchObject({ order: [2], active: 2 })
    expect(s.openers.size).toBe(0)
    expect(removePage(strip(1, 2), 1).active).toBe(2)
  })

  it('puts a page brought back where it was, held to the ends of the strip', () => {
    const three = strip(1, 2, 3)
    expect(addPage(three, 9, { after: null, background: false, at: 1 })).toMatchObject({
      order: [1, 9, 2, 3],
      active: 9
    })
    expect(addPage(three, 9, { after: null, background: false, at: 7 }).order).toEqual([1, 2, 3, 9])
    expect(addPage(three, 9, { after: null, background: false, at: -1 }).order).toEqual([9, 1, 2, 3])
  })

  it('moves a page to an index counted after it has left, and brings it forward', () => {
    expect(movePage(strip(1, 2, 3), 1, 2)).toMatchObject({ order: [2, 3, 1], active: 1 })
    expect(movePage(strip(1, 2, 3), 3, 0).order).toEqual([3, 1, 2])
    expect(movePage(strip(1, 2), 9, 0)).toEqual(strip(1, 2))
  })

  it('draws only pages main holds, appending one it was not told about, and keeps a front that exists', () => {
    const s = strip(1, 2, 3)
    expect(pagesOf(s, new Set([3, 1, 7]))).toEqual({ order: [1, 3, 7], active: 3 })
    expect(pagesOf(activatePage(s, 2), new Set([1, 3]))).toEqual({ order: [1, 3], active: 3 })
    expect(pagesOf(EMPTY_STRIP, new Set())).toEqual({ order: [], active: null })
  })
})
