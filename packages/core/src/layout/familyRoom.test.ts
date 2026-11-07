import { describe, expect, it } from 'vitest'
import {
  familyAxis,
  familyRoom,
  gridOf,
  CARD_GUTTER_X_PX,
  CARD_GUTTER_Y_PX,
  PARENT_GUTTER_PX,
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
/** What a card's terminal needs under its header besides 8 rows: the gutter it sits in. */
const CARD_GUTTER = 2 * CARD_GUTTER_Y_PX

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
  it('fits a pane the size of a 1920x1080 window’s, the parent at 55% keeping about 94 columns in its gutter and four children showing as cards before any shrinks', () => {
    const wide = room({ width: 1440, height: 860 }, 4)
    expect(wide).toMatchObject({ fits: true, axis: 'column', cards: 4, headers: 0 })
    if (!wide.fits) return
    expect(wide.parent.cols).toBe(94)
    expect(wide.card.cols).toBeGreaterThanOrEqual(60)
    expect(wide.card.rows).toBeGreaterThanOrEqual(8)
  })

  it('shows the parent alone in a pane the size of a 1366x768 window’s, whose 55% holds fewer than 80 columns', () => {
    expect(room({ width: 1000, height: 640 }, 3)).toEqual({ fits: false, axis: 'column', why: 'parent' })
  })

  it('judges the parent’s 80 columns at their edge, inside its gutter and the ruler: 80 fits and 79 does not', () => {
    // 55% of 1226 is 674.3; the gutter's 20 and the ruler's 14 leave 640.3 / 8 = 80.04 columns.
    const fits = room({ width: 1226, height: 700 }, 1)
    expect(fits.fits).toBe(true)
    if (fits.fits) expect(fits.parent.cols).toBe(80)
    // 55% of 1225 is 673.75: 639.75 / 8 = 79.97 columns.
    expect(room({ width: 1225, height: 700 }, 1)).toEqual({ fits: false, axis: 'column', why: 'parent' })
    expect(PARENT_GUTTER_PX).toBe(10)
  })

  it('judges a child’s 8 rows at their edge: a header and 8 rows in the card’s gutter fit, a pixel less does not', () => {
    const card = HEADER + CARD_GUTTER + 8 * DEFAULT_CELL.height
    expect(room({ width: 1500, height: card }, 1).fits).toBe(true)
    expect(room({ width: 1500, height: card - 1 }, 1)).toEqual({ fits: false, axis: 'column', why: 'cards' })
  })

  it('judges a child’s 60 columns in a row of cards at their edge: a card stands beside the others for each 60 columns and a ruler', () => {
    const one = 60 * DEFAULT_CELL.width + 2 * CARD_GUTTER_X_PX + 14
    // Two cards need the hairline between them as well.
    expect(room({ width: 2 * one, height: 1800 }, 3)).toMatchObject({ fits: true, axis: 'row', cards: 1, headers: 2 })
    expect(room({ width: 2 * one + 1, height: 1800 }, 3)).toMatchObject({ fits: true, axis: 'row', cards: 2, headers: 1 })
  })

  it('counts the hairline between cards in a column: two cards of a header and 8 rows need one pixel more than their own heights', () => {
    const two = 2 * (HEADER + CARD_GUTTER + 8 * DEFAULT_CELL.height)
    expect(room({ width: 1500, height: two }, 2)).toMatchObject({ fits: true, axis: 'column', cards: 1, headers: 1 })
    const both = room({ width: 1500, height: two + 1 }, 2)
    expect(both).toMatchObject({ fits: true, axis: 'column', cards: 2, headers: 0 })
    if (both.fits) expect(both.card.rows).toBe(8)
  })

  it('gives every card it counts the 60 columns and 8 rows it was counted for', () => {
    for (const body of [
      { width: 1500, height: 329 },
      { width: 1500, height: 860 },
      { width: 1029, height: 1800 },
      { width: 1400, height: 1900 }
    ]) {
      const answer = room(body, 6)
      expect(answer.fits).toBe(true)
      if (!answer.fits) continue
      expect(answer.card.cols).toBeGreaterThanOrEqual(60)
      expect(answer.card.rows).toBeGreaterThanOrEqual(8)
    }
  })

  it('shows the parent alone in a tall pane that is under 80 columns wide, though a card would fit', () => {
    const across = 60 * DEFAULT_CELL.width + 2 * CARD_GUTTER_X_PX + 14
    expect(room({ width: across, height: 1800 }, 1)).toEqual({ fits: false, axis: 'row', why: 'parent' })
  })

  it('lays the cards in a row under the parent in a taller pane, side by side as far as 60 columns each allow', () => {
    const tall = room({ width: 1100, height: 1400 }, 4)
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
    const used =
      crowded.cards * (HEADER + CARD_GUTTER + 8 * DEFAULT_CELL.height) + crowded.headers * HEADER + crowded.cards - 1
    expect(used).toBeLessThanOrEqual(860)
  })

  it('gives every child that is a header its row, though the pane had room for more cards than children that want one', () => {
    const body = { width: 1440, height: 860 }
    // Four children and room for four cards, but two have ended: two cards and two headers.
    const alone = familyRoom({ body, cell: DEFAULT_CELL, headerHeight: HEADER, scrollback: 10_000, children: 4 })
    const ended = familyRoom({
      body,
      cell: DEFAULT_CELL,
      headerHeight: HEADER,
      scrollback: 10_000,
      children: 4,
      wanting: 2
    })
    expect(alone).toMatchObject({ fits: true, cards: 4, headers: 0 })
    expect(ended).toMatchObject({ fits: true, cards: 4, headers: 2 })
    // The parent's terminal is the same either way.
    if (alone.fits && ended.fits) expect(ended.parent).toEqual(alone.parent)

    // The same in a tall pane, where the headers go under the row.
    const tall = familyRoom({
      body: { width: 1100, height: 1400 },
      cell: DEFAULT_CELL,
      headerHeight: HEADER,
      scrollback: 10_000,
      children: 4,
      wanting: 1
    })
    expect(tall).toMatchObject({ fits: true, axis: 'row', headers: 3 })
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
