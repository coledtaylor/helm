import { describe, expect, it } from 'vitest'
import type { PaneNode } from '@helm/core/types'
import {
  dragShares,
  dropZoneAt,
  gridGeometry,
  minExtent,
  PANE_MIN_HEIGHT,
  PANE_MIN_WIDTH,
  sashesOf,
  splitAt,
  withShares,
  type PaneDropZone
} from './paneGeometry'

// 1 | 2
//   |---
//   | 3
const GRID: PaneNode = {
  axis: 'row',
  children: [{ group: 1 }, { axis: 'column', children: [{ group: 2 }, { group: 3 }], sizes: [0.3, 0.7] }],
  sizes: [0.5, 0.5]
}

describe('sashesOf', () => {
  it('names a divider for every gutter, by the split it is in and the child before it', () => {
    expect(sashesOf(GRID).map(({ key, axis }) => [key, axis])).toEqual([
      [':0', 'row'],
      ['1:0', 'column']
    ])
    expect(sashesOf({ group: 1 })).toEqual([])
  })
})

describe('gridGeometry', () => {
  it('shares each split’s room less its gutters, and tiles the box exactly', () => {
    const { panes, sashes, rooms } = gridGeometry(GRID, 1006, 606, 6)
    expect(panes.get(1)).toEqual({ left: 0, top: 0, width: 500, height: 606 })
    expect(sashes.get(':0')).toEqual({ left: 500, top: 0, width: 6, height: 606 })
    expect(panes.get(2)).toEqual({ left: 506, top: 0, width: 500, height: 180 })
    expect(sashes.get('1:0')).toEqual({ left: 506, top: 180, width: 500, height: 6 })
    expect(panes.get(3)).toEqual({ left: 506, top: 186, width: 500, height: 420 })
    expect(rooms.get('')).toBe(1000)
    expect(rooms.get('1')).toBe(600)
  })

  it('lands every edge on a whole pixel, with no gap or overlap, whatever the shares', () => {
    const row: PaneNode = {
      axis: 'row',
      children: [{ group: 1 }, { group: 2 }, { group: 3 }],
      sizes: [0.333, 0.3337, 0.3333]
    }
    const { panes, sashes } = gridGeometry(row, 1283, 700, 5)
    const edges = [panes.get(1)!, sashes.get(':0')!, panes.get(2)!, sashes.get(':1')!, panes.get(3)!]
    for (const box of edges) {
      expect(Number.isInteger(box.left) && Number.isInteger(box.width)).toBe(true)
    }
    for (let at = 1; at < edges.length; at += 1) {
      expect(edges[at]!.left).toBe(edges[at - 1]!.left + edges[at - 1]!.width)
    }
    expect(panes.get(3)!.left + panes.get(3)!.width).toBe(1283)
  })
})

describe('minExtent', () => {
  it('adds up along a split’s own axis and takes the largest across it', () => {
    expect(minExtent({ group: 1 }, 'row', 6)).toBe(PANE_MIN_WIDTH)
    expect(minExtent(GRID, 'row', 6)).toBe(2 * PANE_MIN_WIDTH + 6)
    expect(minExtent(GRID, 'column', 6)).toBe(2 * PANE_MIN_HEIGHT + 6)
  })
})

describe('dragShares', () => {
  it('moves only the two children either side of the divider', () => {
    const [first, second, third] = dragShares([0.25, 0.25, 0.5], 0, 100, 1000, [100, 100, 100])
    expect(first).toBeCloseTo(0.35)
    expect(second).toBeCloseTo(0.15)
    expect(third).toBe(0.5)
  })

  it('stops each side at the least its own panes need', () => {
    expect(dragShares([0.5, 0.5], 0, -400, 1000, [200, 300])).toEqual([0.2, 0.8])
    expect(dragShares([0.5, 0.5], 0, 400, 1000, [200, 300])).toEqual([0.7, expect.closeTo(0.3)])
  })

  it('leaves the divider where it is when the two are already too small for both', () => {
    expect(dragShares([0.5, 0.5], 0, 50, 300, [200, 200])).toEqual([0.5, 0.5])
    expect(dragShares([0.5, 0.5], 0, 50, 0, [200, 200])).toEqual([0.5, 0.5])
  })
})

describe('withShares and splitAt', () => {
  it('finds a split by path and gives it new shares, leaving the rest alone', () => {
    expect(splitAt(GRID, [1])?.sizes).toEqual([0.3, 0.7])
    expect(splitAt(GRID, [0])).toBeNull()
    expect(splitAt(GRID, [5])).toBeNull()
    const changed = withShares(GRID, [1], [0.6, 0.4])
    expect(splitAt(changed, [1])?.sizes).toEqual([0.6, 0.4])
    expect(splitAt(changed, [])?.sizes).toEqual([0.5, 0.5])
    expect(withShares({ group: 1 }, [], [1])).toEqual({ group: 1 })
  })
})

describe('dropZoneAt', () => {
  const all = (): boolean => true
  const zone = (x: number, y: number, allows: (zone: PaneDropZone) => boolean = all): PaneDropZone | null =>
    dropZoneAt(x, y, 900, 600, allows)

  it('is a side within a third of it, and the middle otherwise', () => {
    expect(zone(450, 300)).toBe('center')
    expect(zone(100, 300)).toBe('left')
    expect(zone(800, 300)).toBe('right')
    expect(zone(450, 50)).toBe('top')
    expect(zone(450, 550)).toBe('bottom')
  })

  it('takes the nearer side at a corner, measured as a share of each', () => {
    expect(zone(60, 150)).toBe('left')
    expect(zone(250, 30)).toBe('top')
  })

  it('passes over a side it may not use, for the next nearest and then the middle', () => {
    expect(zone(60, 150, (candidate) => candidate !== 'left')).toBe('top')
    expect(zone(100, 300, (candidate) => candidate !== 'left')).toBe('center')
    expect(zone(450, 300, (candidate) => candidate !== 'center')).toBeNull()
    expect(dropZoneAt(1, 1, 0, 600, all)).toBeNull()
  })
})
