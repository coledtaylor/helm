import { describe, expect, it } from 'vitest'
import type { CellProbe, ScreenProbe } from '../shared/protocol'
import { firstDifference } from './screen-compare'

const blank: CellProbe = {
  chars: '',
  width: 1,
  fgMode: 0,
  bgMode: 0,
  fg: 0,
  bg: 0,
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
  dim: false
}

function screen(edit: (cells: CellProbe[][]) => void = () => undefined, over: Partial<ScreenProbe> = {}): ScreenProbe {
  const cells = Array.from({ length: 2 }, () => Array.from({ length: 3 }, () => ({ ...blank })))
  edit(cells)
  return { cols: 3, rows: 2, bufferType: 'normal', cursorX: 0, cursorY: 0, cells, ...over }
}

describe('comparing a live screen with a redrawn one', () => {
  it('finds nothing between two screens that are the same', () => {
    expect(firstDifference(screen(), screen())).toBeNull()
  })

  it('names the first differing cell, the field and both values', () => {
    const live = screen((cells) => {
      cells[1]![2] = { ...blank, chars: 'x', fgMode: 2, fg: 0xc71585, bold: true }
    })
    const redrawn = screen((cells) => {
      cells[1]![2] = { ...blank, chars: 'x', fgMode: 1, fg: 162, bold: true }
    })
    expect(firstDifference(live, redrawn)).toBe(
      'row 1 col 2 (fgMode): live "x" width 1 fg #c71585 bg default bold, redrawn "x" width 1 fg palette 162 bg default bold'
    )
  })

  it('takes an erased cell and a written space as the same blank, in the same colours', () => {
    const erased = screen((cells) => {
      cells[0]![0] = { ...blank, chars: '', bgMode: 2, bg: 0xc71585 }
    })
    const written = screen((cells) => {
      cells[0]![0] = { ...blank, chars: ' ', bgMode: 2, bg: 0xc71585 }
    })
    expect(firstDifference(erased, written)).toBeNull()
    expect(firstDifference(erased, screen())).toMatch(/^row 0 col 0 \(bgMode\)/)
  })

  it('says when the grid, the buffer or the cursor differ', () => {
    expect(firstDifference(screen(), screen(undefined, { cols: 4 }))).toBe('grid: live 3x2, redrawn 4x2')
    expect(firstDifference(screen(), screen(undefined, { bufferType: 'alternate' }))).toBe(
      'buffer: live normal, redrawn alternate'
    )
    expect(firstDifference(screen(undefined, { cursorX: 2, cursorY: 1 }), screen())).toBe(
      'cursor: live row 1 col 2, redrawn row 0 col 0'
    )
  })
})
