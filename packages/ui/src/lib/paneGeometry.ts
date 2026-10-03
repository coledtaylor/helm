import { isSplit, type PaneAxis, type PaneEdge, type PaneNode } from '@helm/core/types'

/**
 * Pixels for the pane tree: where each pane and each divider goes, how far a
 * divider may be dragged, and which part of a pane a dragged tab is over.
 *
 * Pure, so the arithmetic is tested without a window. `PaneGrid` writes what
 * comes out of here straight onto the DOM.
 */

/**
 * The smallest a pane is dragged or split to: a strip, a crumb and a few rows
 * of terminal, and a strip wide enough for a tab and the pane's own buttons.
 * A window made smaller than its panes need shrinks them anyway; this bounds
 * what a gesture may do, not what a monitor may.
 */
export const PANE_MIN_WIDTH = 200
export const PANE_MIN_HEIGHT = 140

/**
 * Sent on `window` whenever the panes are moved or resized. A pane can move
 * without changing size - the one after a divider - and `ResizeObserver` only
 * hears about size, so anything drawn natively over a pane (the browser's
 * view) listens for this as well.
 */
export const PANES_MOVED_EVENT = 'helm:panes-moved'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** A divider: the gutter after child `index` of the split at `path`. */
export interface SashRef {
  /** Stable while the tree's shape is: `path` and `index`. */
  key: string
  path: readonly number[]
  index: number
  /** The split's axis. A row's divider stands upright and drags sideways. */
  axis: PaneAxis
}

export interface GridGeometry {
  panes: Map<number, Box>
  sashes: Map<string, Box>
  /** Each split's room along its axis, gutters taken out, by `pathKey`. */
  rooms: Map<string, number>
}

export const pathKey = (path: readonly number[]): string => path.join('.')

/** Every divider in a tree, in reading order. Shape only, so it is known at render time. */
export function sashesOf(node: PaneNode, path: readonly number[] = []): SashRef[] {
  if (!isSplit(node)) return []
  return node.children.flatMap((child, index) => [
    ...sashesOf(child, [...path, index]),
    ...(index < node.children.length - 1
      ? [{ key: `${pathKey(path)}:${String(index)}`, path, index, axis: node.axis }]
      : [])
  ])
}

/**
 * Where everything goes in a box `width` by `height`, with `gap` pixels of
 * gutter between neighbours.
 *
 * Each split shares its room, less its gutters, by its shares. Every edge is
 * rounded once, where it is computed, and a pane's size is the difference
 * between its rounded edges - so a pane, the gutter after it and the pane after
 * that tile without a gap or an overlap, and every hairline lands on a whole
 * pixel.
 */
export function gridGeometry(root: PaneNode, width: number, height: number, gap: number): GridGeometry {
  const panes = new Map<number, Box>()
  const sashes = new Map<string, Box>()
  const rooms = new Map<string, number>()
  const box = (x0: number, y0: number, x1: number, y1: number): Box => {
    const left = Math.round(x0)
    const top = Math.round(y0)
    return { left, top, width: Math.round(x1) - left, height: Math.round(y1) - top }
  }
  const place = (node: PaneNode, x0: number, y0: number, x1: number, y1: number, path: number[]): void => {
    if (!isSplit(node)) {
      panes.set(node.group, box(x0, y0, x1, y1))
      return
    }
    const row = node.axis === 'row'
    const room = Math.max(0, (row ? x1 - x0 : y1 - y0) - gap * (node.children.length - 1))
    rooms.set(pathKey(path), room)
    let cursor = row ? x0 : y0
    node.children.forEach((child, index) => {
      const end = cursor + room * node.sizes[index]!
      if (row) place(child, cursor, y0, end, y1, [...path, index])
      else place(child, x0, cursor, x1, end, [...path, index])
      if (index < node.children.length - 1) {
        sashes.set(
          `${pathKey(path)}:${String(index)}`,
          row ? box(end, y0, end + gap, y1) : box(x0, end, x1, end + gap)
        )
      }
      cursor = end + gap
    })
  }
  place(root, 0, 0, width, height, [])
  return { panes, sashes, rooms }
}

/** The least room a subtree needs along `axis` for none of its panes to go under the minimum. */
export function minExtent(node: PaneNode, axis: PaneAxis, gap: number): number {
  if (!isSplit(node)) return axis === 'row' ? PANE_MIN_WIDTH : PANE_MIN_HEIGHT
  const each = node.children.map((child) => minExtent(child, axis, gap))
  return node.axis === axis
    ? each.reduce((total, extent) => total + extent, 0) + gap * (node.children.length - 1)
    : Math.max(...each)
}

/**
 * A split's shares once the divider after child `index` has moved `delta`
 * pixels. Only the two children either side of it change, as with any
 * divider, and neither is taken below `mins` - what its own panes need. When
 * the two together are already smaller than that, the divider stays where it
 * is rather than favour one of them.
 */
export function dragShares(
  sizes: readonly number[],
  index: number,
  delta: number,
  room: number,
  mins: readonly number[]
): number[] {
  if (room <= 0) return [...sizes]
  const before = sizes[index]! * room
  const pair = before + sizes[index + 1]! * room
  const low = mins[index]!
  const high = pair - mins[index + 1]!
  if (high < low) return [...sizes]
  const moved = Math.min(high, Math.max(low, before + delta))
  const out = [...sizes]
  out[index] = moved / room
  out[index + 1] = (pair - moved) / room
  return out
}

/** The tree with the split at `path` given `sizes`, or the tree itself if `path` names no split. */
export function withShares(node: PaneNode, path: readonly number[], sizes: readonly number[]): PaneNode {
  if (!isSplit(node)) return node
  if (path.length === 0) return { ...node, sizes }
  const [at, ...rest] = path
  return { ...node, children: node.children.map((child, index) => (index === at ? withShares(child, rest, sizes) : child)) }
}

/** The split at `path`, or null. */
export function splitAt(node: PaneNode, path: readonly number[]): Extract<PaneNode, { axis: PaneAxis }> | null {
  let current: PaneNode | undefined = node
  for (const at of path) current = current !== undefined && isSplit(current) ? current.children[at] : undefined
  return current !== undefined && isSplit(current) ? current : null
}

/** Where a dragged tab would land on a pane: one of its sides, or its middle. */
export type PaneDropZone = 'center' | PaneEdge

/**
 * The zone under the pointer at (`x`, `y`) in a pane `width` by `height`.
 *
 * Within a third of a side is that side - the nearest, when two are near, as
 * at a corner - and the middle is the rest: VS Code's thirds, which is the
 * gesture this copies. A zone `allows` refuses is passed over, a side for the
 * next nearest and then the middle, and the middle for nothing at all.
 */
export function dropZoneAt(
  x: number,
  y: number,
  width: number,
  height: number,
  allows: (zone: PaneDropZone) => boolean
): PaneDropZone | null {
  if (width <= 0 || height <= 0) return null
  const fx = x / width
  const fy = y / height
  const sides: [PaneEdge, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy]
  ]
  const near = sides.filter(([edge, distance]) => distance < 1 / 3 && allows(edge)).sort((a, b) => a[1] - b[1])
  if (near.length > 0) return near[0]![0]
  return allows('center') ? 'center' : null
}
