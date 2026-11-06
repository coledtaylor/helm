/**
 * Whether a parent's pane has room for its family view, and how much.
 *
 * Pure numbers, browser-safe, and measured as the terminal measures: a grid of
 * cells is `gridOf`, the one piece of arithmetic that `estimateGrid` (which
 * opens a pty at a pane's size) and this rule both run, so a pane the rule
 * calls wide enough for 80 columns is a pane a terminal fits 80 columns in.
 */

/** A size in CSS pixels. */
export interface PixelSize {
  width: number
  height: number
}

/** One terminal cell in CSS pixels, as the terminal's font measures it. */
export interface CellSize {
  width: number
  height: number
}

/** A terminal's columns and rows. */
export interface TerminalGrid {
  cols: number
  rows: number
}

/**
 * The strip the terminal's fit holds back for the overview ruler, which is
 * where the scrollbar is drawn: a flat 14 CSS pixels, and its own constant
 * rather than a measurement, so an estimate that is not this constant is a
 * column or two wide on every pane.
 */
export const RULER_RESERVE_PX = 14

/** The ruler's strip for a terminal that keeps `scrollback` lines: none when it keeps none. */
export function rulerReserve(scrollback: number): number {
  return scrollback === 0 ? 0 : RULER_RESERVE_PX
}

/**
 * How many cells fit in `size` with `cell` cells: a column count that leaves
 * the ruler's strip out and a row count that does not, neither under two
 * (a terminal of one column is not one any program can draw in).
 */
export function gridOf(size: PixelSize, cell: CellSize, scrollback: number): TerminalGrid {
  return {
    cols: Math.max(Math.floor((size.width - rulerReserve(scrollback)) / cell.width), 2),
    rows: Math.max(Math.floor(size.height / cell.height), 2)
  }
}

/** `size` less `x` on each side across and `y` on each side down. */
function inside(size: PixelSize, x: number, y: number): PixelSize {
  return { width: size.width - 2 * x, height: size.height - 2 * y }
}

/** The share of the pane's long side the parent's terminal keeps while any child is in its family. */
export const FAMILY_PARENT_SHARE = 0.55

/**
 * The hairline the family view draws between the parent and the children and
 * between one card and the next. It is part of the pane the children share, so
 * a card's terminal has that much less than an even split of the pane.
 */
export const FAMILY_HAIRLINE_PX = 1

/**
 * The gutter a session's terminal sits in, per side, in CSS pixels. The grid a
 * terminal fits is the box inside it (`TerminalPane` draws it as padding on a
 * wrapper), so a pane that is 80 columns wide by its own width holds fewer. A
 * parent's terminal has it on every side; a card's has less above and below,
 * to leave its header room.
 */
export const PARENT_GUTTER_PX = 10
export const CARD_GUTTER_X_PX = 10
export const CARD_GUTTER_Y_PX = 8

/** The columns the parent keeps, at the device's terminal font, for the family view to show. */
export const FAMILY_PARENT_MIN_COLS = 80

/** The least a shown child gets: this many columns by this many rows. */
export const FAMILY_CARD_MIN_COLS = 60
export const FAMILY_CARD_MIN_ROWS = 8

/**
 * Where the cards go: `column` is a column of them beside the parent, in a
 * pane that is as wide as it is tall or wider; `row` is a row of them below
 * it, in a pane taller than it is wide. The parent takes the pane's long side.
 */
export type FamilyAxis = 'column' | 'row'

/** What the room rule reads. */
export interface FamilyRoomInput {
  /** The pane body's size, the area under the strip and the crumb. */
  body: PixelSize
  /** One cell of this device's terminal font. */
  cell: CellSize
  /** A one-line header's height: a card's own, and a shrunk child's. */
  headerHeight: number
  /** Lines of scrollback the terminal keeps, which decides the ruler's strip. */
  scrollback: number
  /** The children in the family, as cards or headers. */
  children: number
  /**
   * How many of them want a card (`wantsCard`); the others are headers however
   * much room there is, and the header rows are counted for them. Every child
   * when left out.
   */
  wanting?: number
}

/** Why a pane shows the parent alone. */
export type FamilyNoRoom =
  /** The parent would keep fewer than 80 columns at its 55%. */
  | 'parent'
  /** Not one child could have 60 columns by 8 rows. */
  | 'cards'
  /** There is no child to show. */
  | 'children'

export type FamilyRoom =
  | { fits: false; axis: FamilyAxis; why: FamilyNoRoom }
  | {
      fits: true
      axis: FamilyAxis
      /** The parent's terminal at its 55%. */
      parent: TerminalGrid
      /**
       * How many children show as cards: as many as fit at 60 columns by 8
       * rows with a one-line header for each of the rest, and at least one.
       */
      cards: number
      /** How many of the rest show as one-line headers; any more are not drawn. */
      headers: number
      /** The least grid a card gets with this many cards. */
      card: TerminalGrid
    }

/** The axis a pane of `body` lays its family out on. */
export function familyAxis(body: PixelSize): FamilyAxis {
  return body.width >= body.height ? 'column' : 'row'
}

/**
 * The room rule. The family view shows while the parent keeps at least 80
 * columns at its fixed 55% and at least one child gets 60 columns by 8 rows;
 * otherwise the parent shows alone and fills the pane. Whether it fits
 * depends on the pane and the font and never on how many children there are,
 * so a child starting or ending cannot take the family view away; only how
 * many of them are cards does.
 *
 * The parent's share is the same for every count of cards and headers, which
 * is what keeps its terminal from reflowing as cards shrink, swap, end or
 * close.
 */
export function familyRoom(input: FamilyRoomInput): FamilyRoom {
  const { body, cell, headerHeight, scrollback } = input
  const axis = familyAxis(body)
  const share = FAMILY_PARENT_SHARE
  const parent = gridOf(
    inside(
      axis === 'column'
        ? { width: body.width * share, height: body.height }
        : { width: body.width, height: body.height * share },
      PARENT_GUTTER_PX,
      PARENT_GUTTER_PX
    ),
    cell,
    scrollback
  )
  if (parent.cols < FAMILY_PARENT_MIN_COLS) return { fits: false, axis, why: 'parent' }

  const children = Math.max(0, Math.floor(input.children))
  const wanting = Math.min(children, Math.max(0, Math.floor(input.wanting ?? children)))
  // What a card's terminal needs below its header: 8 rows and its gutter.
  const cardRows = FAMILY_CARD_MIN_ROWS * cell.height + 2 * CARD_GUTTER_Y_PX
  const cardMinHeight = headerHeight + cardRows
  /** The grid a card's terminal gets in `size`, the box under its header. */
  const cardGrid = (size: PixelSize): TerminalGrid =>
    gridOf(inside(size, CARD_GUTTER_X_PX, CARD_GUTTER_Y_PX), cell, scrollback)
  const hairline = FAMILY_HAIRLINE_PX
  // The children's side of the first hairline.
  const rest = body.height * (1 - share) - hairline

  if (axis === 'column') {
    const cardsWidth = body.width * (1 - share) - hairline
    if (cardGrid({ width: cardsWidth, height: body.height }).cols < FAMILY_CARD_MIN_COLS) {
      return { fits: false, axis, why: 'cards' }
    }
    if (cardMinHeight > body.height) return { fits: false, axis, why: 'cards' }
    if (children === 0) return { fits: false, axis, why: 'children' }
    // The most cards that leave a one-line header's room for every other child,
    // each card after the first with a hairline above it.
    const byRoom = Math.floor((body.height - children * headerHeight + hairline) / (cardRows + hairline))
    const cards = Math.min(children, Math.max(1, byRoom))
    // The cards actually drawn: a child that wants no card is a header, and the
    // headers take the height the cards it leaves unused would have had.
    const drawn = Math.min(cards, wanting)
    const between = Math.max(0, drawn - 1) * hairline
    const headers = Math.min(
      children - drawn,
      Math.floor((body.height - drawn * cardMinHeight - between) / headerHeight)
    )
    const each = (body.height - headers * headerHeight - between) / Math.max(1, drawn)
    return {
      fits: true,
      axis,
      parent,
      cards,
      headers,
      card: cardGrid({ width: cardsWidth, height: each - headerHeight })
    }
  }

  // A row below the parent: cards side by side, each at least 60 columns wide.
  const cardMinWidth = FAMILY_CARD_MIN_COLS * cell.width + 2 * CARD_GUTTER_X_PX + rulerReserve(scrollback)
  const wide = Math.floor((body.width + hairline) / (cardMinWidth + hairline))
  if (wide < 1 || cardMinHeight > rest) return { fits: false, axis, why: 'cards' }
  if (children === 0) return { fits: false, axis, why: 'children' }
  const cards = Math.min(children, wide)
  const drawn = Math.min(cards, wanting)
  // The headers under the row take height from the cards, down to 8 rows.
  const headers = Math.min(
    children - drawn,
    Math.floor((rest - (drawn > 0 ? cardMinHeight : 0)) / headerHeight)
  )
  return {
    fits: true,
    axis,
    parent,
    cards,
    headers,
    card: cardGrid({
      width: (body.width - (cards - 1) * hairline) / cards,
      height: rest - headers * headerHeight - headerHeight
    })
  }
}
