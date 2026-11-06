import { describe, expect, it } from 'vitest'
import {
  familyAxis,
  familyRoom,
  gridOf,
  type CellSize,
  type FamilyRoom,
  type PixelSize
} from './familyRoom'

/** The default 14px terminal font: a cell 8 by 17 CSS pixels. */
const DEFAULT_CELL: CellSize = { width: 8, height: 17 }
/** A 20px font. */
const LARGE_CELL: CellSize = { width: 11, height: 24 }
/** A card's header is one line, 28px. */
const HEADER = 28

const room = (
  body: PixelSize,
  children: number,
  patch: { cell?: CellSize; scrollback?: number } = {}
): FamilyRoom =>
  familyRoom({
    body,
    cell: patch.cell ?? DEFAULT_CELL,
    headerHeight: HEADER,
    scrollback: patch.scrollback ?? 10_000,
    children
  })

describe('gridOf', () => {
  it('counts the cells that fit, leaving the ruler’s 14px out of the columns only', () => {
    expect(gridOf({ width: 800, height: 600 }, DEFAULT_CELL, 10_000)).toEqual({ cols: 98, rows: 35 })
  })

  it('leaves no strip for the ruler in a terminal that keeps no scrollback', () => {
    expect(gridOf({ width: 800, height: 600 }, DEFAULT_CELL, 0)).toEqual({ cols: 100, rows: 35 })
  })

  it('never answers fewer than two columns or two rows', () => {
    expect(gridOf({ width: 3, height: 3 }, DEFAULT_CELL, 10_000)).toEqual({ cols: 2, rows: 2 })
  })
})

describe('familyAxis', () => {
  it('puts the cards in a column beside the parent in a pane as wide as it is tall or wider, and in a row below it in a taller one', () => {
    expect(familyAxis({ width: 1400, height: 800 })).toBe('column')
    expect(familyAxis({ width: 900, height: 900 })).toBe('column')
    expect(familyAxis({ width: 700, height: 1000 })).toBe('row')
  })
})

describe('familyRoom', () => {
  it('fits a pane the size of a 1920x1080 window’s, the parent at 55% keeping about 99 columns and up to five children showing as cards', () => {
    const wide = room({ width: 1440, height: 860 }, 5)
    expect(wide).toMatchObject({ fits: true, axis: 'column', cards: 5, headers: 0 })
    if (!wide.fits) return
    expect(wide.parent.cols).toBeGreaterThanOrEqual(80)
    expect(wide.card.cols).toBeGreaterThanOrEqual(60)
    expect(wide.card.rows).toBeGreaterThanOrEqual(8)
  })

  it('shows the parent alone in a pane the size of a 1366x768 window’s, whose 55% holds fewer than 80 columns', () => {
    expect(room({ width: 1000, height: 640 }, 3)).toEqual({ fits: false, axis: 'column', why: 'parent' })
  })

  it('judges the parent’s 80 columns at their edge: 80 fits and 79 does not', () => {
    // 55% of 1190 is 654.5 and 14 of it is the ruler's: 640.5 / 8 = 80.06 columns.
    expect(room({ width: 1190, height: 700 }, 1).fits).toBe(true)
    // 55% of 1188 is 653.4: 639.4 / 8 = 79.9 columns.
    expect(room({ width: 1188, height: 700 }, 1)).toEqual({ fits: false, axis: 'column', why: 'parent' })
  })

  it('judges a child’s 8 rows at their edge: a header and 8 rows fit, a pixel less does not', () => {
    const card = HEADER + 8 * DEFAULT_CELL.height
    expect(room({ width: 1500, height: card }, 1).fits).toBe(true)
    expect(room({ width: 1500, height: card - 1 }, 1)).toEqual({ fits: false, axis: 'column', why: 'cards' })
  })

  it('judges a child’s 60 columns in a row of cards at their edge: a card stands beside the others for each 60 columns and a ruler', () => {
    const one = 60 * DEFAULT_CELL.width + 14
    expect(room({ width: 2 * one - 1, height: 1800 }, 3)).toMatchObject({ fits: true, axis: 'row', cards: 1, headers: 2 })
    expect(room({ width: 2 * one, height: 1800 }, 3)).toMatchObject({ fits: true, axis: 'row', cards: 2, headers: 1 })
  })

  it('shows the parent alone in a tall pane that is under 80 columns wide, though a card would fit', () => {
    const across = 60 * DEFAULT_CELL.width + 14
    expect(room({ width: across, height: 1800 }, 1)).toEqual({ fits: false, axis: 'row', why: 'parent' })
  })

  it('lays the cards in a row under the parent in a taller pane, side by side as far as 60 columns each allow', () => {
    const tall = room({ width: 1000, height: 1400 }, 4)
    expect(tall).toMatchObject({ fits: true, axis: 'row', cards: 2 })
    if (!tall.fits) return
    expect(tall.card.cols).toBeGreaterThanOrEqual(60)
    // The rest are one-line headers under the row.
    expect(tall.headers).toBe(2)
  })

  it('needs more pixels for the same floors at a larger terminal font, so a pane that held the family at the default shows the parent alone', () => {
    const body = { width: 1440, height: 860 }
    expect(room(body, 3).fits).toBe(true)
    expect(room(body, 3, { cell: LARGE_CELL })).toEqual({ fits: false, axis: 'column', why: 'parent' })
    // Wide enough for 80 columns at the larger font.
    expect(room({ width: 1700, height: 860 }, 3, { cell: LARGE_CELL }).fits).toBe(true)
  })

  it('says there is nothing to show with no children, however much room there is', () => {
    expect(room({ width: 1440, height: 860 }, 0)).toEqual({ fits: false, axis: 'column', why: 'children' })
  })

  it('shrinks the children that do not fit at 8 rows to headers, and draws as many headers as the room has left', () => {
    const crowded = room({ width: 1440, height: 860 }, 12)
    expect(crowded).toMatchObject({ fits: true, axis: 'column' })
    if (!crowded.fits) return
    expect(crowded.cards).toBeGreaterThanOrEqual(1)
    expect(crowded.cards).toBeLessThan(12)
    // Every header and every card's minimum height is inside the pane.
    const used = crowded.cards * (HEADER + 8 * DEFAULT_CELL.height) + crowded.headers * HEADER
    expect(used).toBeLessThanOrEqual(860)
  })

  it('keeps the parent’s terminal at the same columns and rows however many children there are, as cards or headers', () => {
    const body = { width: 1440, height: 860 }
    const parents = [1, 2, 3, 5, 8, 12, 30].map((children) => {
      const answer = room(body, children)
      return answer.fits ? answer.parent : null
    })
    expect(parents.every((parent) => parent !== null)).toBe(true)
    expect(new Set(parents.map((parent) => JSON.stringify(parent))).size).toBe(1)
  })

  it('does not take the family view away when children start or end: whether it fits never depends on how many there are', () => {
    for (const body of [
      { width: 1440, height: 860 },
      { width: 1000, height: 640 },
      { width: 700, height: 1100 }
    ]) {
      const fits = [1, 2, 6, 40].map((children) => room(body, children).fits)
      expect(new Set(fits).size).toBe(1)
    }
  })

  it('comes back when the pane gains room and goes when it loses it, and judges the same body the same', () => {
    const split = { width: 600, height: 860 }
    const maximized = { width: 1440, height: 860 }
    expect(room(split, 2).fits).toBe(false)
    expect(room(maximized, 2).fits).toBe(true)
    expect(room(split, 2)).toEqual(room(split, 2))
  })
})
