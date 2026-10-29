import type { CellProbe, ScreenProbe } from '../shared/protocol'

/**
 * Where two terminals' screens first differ, said so a failure names the cell
 * and both values: the grid, the buffer, the cursor, then each cell from the
 * top left. Null when they are the same.
 */

const CELL_FIELDS: ReadonlyArray<keyof CellProbe> = [
  'chars',
  'width',
  'fgMode',
  'bgMode',
  'fg',
  'bg',
  'bold',
  'italic',
  'underline',
  'inverse',
  'dim'
]

export function firstDifference(live: ScreenProbe, other: ScreenProbe): string | null {
  if (live.cols !== other.cols || live.rows !== other.rows) {
    return `grid: live ${String(live.cols)}x${String(live.rows)}, redrawn ${String(other.cols)}x${String(other.rows)}`
  }
  if (live.bufferType !== other.bufferType) {
    return `buffer: live ${live.bufferType}, redrawn ${other.bufferType}`
  }
  for (let row = 0; row < live.rows; row++) {
    for (let col = 0; col < live.cols; col++) {
      const a = live.cells[row]?.[col]
      const b = other.cells[row]?.[col]
      if (a === undefined || b === undefined) {
        if (a !== b) return `row ${String(row)} col ${String(col)}: live ${describe(a)}, redrawn ${describe(b)}`
        continue
      }
      const field = CELL_FIELDS.find((name) => (name === 'chars' ? blank(a) !== blank(b) : a[name] !== b[name]))
      if (field !== undefined) {
        return `row ${String(row)} col ${String(col)} (${field}): live ${describe(a)}, redrawn ${describe(b)}`
      }
    }
  }
  if (live.cursorX !== other.cursorX || live.cursorY !== other.cursorY) {
    return `cursor: live row ${String(live.cursorY)} col ${String(live.cursorX)}, redrawn row ${String(other.cursorY)} col ${String(other.cursorX)}`
  }
  return null
}

/**
 * A cell's characters, with an erased cell and a written space as one: both
 * are a blank cell, painted in its background. An erase (`EL`, `ECH`) leaves
 * the first and a redraw may write the second for the same screen.
 */
function blank(cell: CellProbe): string {
  return cell.chars === '' ? ' ' : cell.chars
}

function describe(cell: CellProbe | undefined): string {
  if (cell === undefined) return 'no cell'
  const colour = (mode: number, value: number): string =>
    mode === 2 ? `#${value.toString(16).padStart(6, '0')}` : mode === 1 ? `palette ${String(value)}` : 'default'
  const attributes = (['bold', 'italic', 'underline', 'inverse', 'dim'] as const).filter((name) => cell[name])
  return `${JSON.stringify(cell.chars)} width ${String(cell.width)} fg ${colour(cell.fgMode, cell.fg)} bg ${colour(
    cell.bgMode,
    cell.bg
  )}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}`
}
