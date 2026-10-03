import type { JSX, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { isSplit, type PaneNode } from '@helm/core/types'
import { cn } from '../lib/cn'
import {
  dragShares,
  gridGeometry,
  minExtent,
  pathKey,
  PANES_MOVED_EVENT,
  sashesOf,
  splitAt,
  withShares,
  type Box,
  type SashRef
} from '../lib/paneGeometry'

export interface PaneGridProps {
  /** The arrangement (`PaneLayout.root`). */
  root: PaneNode
  /** The group given the whole area, or null for the arrangement. */
  maximized: number | null
  /** The gutter between panes in pixels - the `paneGap` setting. */
  gap: number
  /** Each pane on screen, drawn by the caller, by its group's id. */
  panes: ReadonlyMap<number, ReactNode>
  /** A divider was let go, or double-clicked: the split at `path` now shares its room as `sizes`. */
  onResize: (path: readonly number[], sizes: readonly number[]) => void
}

/** A divider being dragged: where it started, and everything the drag is bounded by. */
interface Drag {
  sash: SashRef
  /** The pointer's coordinate along the split's axis when it was pressed. */
  from: number
  sizes: readonly number[]
  room: number
  mins: readonly number[]
  /** The shares the pointer has got to, or null for a press that has not moved. */
  moved: number[] | null
}

function apply(element: HTMLElement | undefined, box: Box): void {
  if (element === undefined) return
  const { style } = element
  style.left = `${String(box.left)}px`
  style.top = `${String(box.top)}px`
  style.width = `${String(box.width)}px`
  style.height = `${String(box.height)}px`
}

/**
 * The panes, arranged by the tree: every pane absolutely placed in one box,
 * and a divider in each gutter.
 *
 * **Absolutely placed, rather than nested flex boxes, so a pane is never
 * remounted by a split.** In nested boxes, splitting a pane moves it under a
 * new parent element, and React can only do that by unmounting it - every
 * page in it losing its state, every terminal in it re-attached, a browser tab
 * re-measured from nothing. Here every pane is a child of the same box for its
 * whole life, keyed by its group's id and listed in id order (ids only grow, so
 * a new pane is appended and none is ever moved in the DOM); the tree decides
 * only where each one is drawn.
 *
 * **React never writes a position.** `place` computes every box from the tree
 * and writes it to the DOM - from a layout effect when the tree changes, from
 * a `ResizeObserver` when the window does, and from the pointer while a
 * divider is dragged - and commits the shares once, on release. The two-pane
 * divider this replaced learned that the hard way, three times. Setting state
 * on every `mousemove` was correct and stuttered: with the session history
 * open, a move reconciled 966 rows to produce the same 966 rows, once a frame.
 * Writing the style directly and committing on release measured 47.4ms down to
 * 0.1ms a move and was worse in the hand, because the style was also React's:
 * with a live session in a pane something re-renders constantly, and every
 * render pulled the pane back to the value React held. A property React never
 * renders has no second writer, and that is what a box's position is here.
 */
export function PaneGrid({ root, maximized, gap, panes, onResize }: PaneGridProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const paneElements = useRef(new Map<number, HTMLDivElement>())
  const sashElements = useRef(new Map<string, HTMLDivElement>())
  const drag = useRef<Drag | null>(null)

  /*
   * The tree on screen, by what it is rather than by identity. The layout is
   * re-derived whenever anything it is reconciled against changes - a session
   * starting, the saved copy of the layout coming back from its own write -
   * and each time it is a new object describing the same panes. Keyed on
   * identity, every one of those would re-place every pane and drop a divider
   * out from under the pointer.
   */
  const shape = JSON.stringify(maximized === null ? root : { group: maximized })
  const shown = useMemo(() => JSON.parse(shape) as PaneNode, [shape])
  /** The tree as drawn: `shown`, except mid-drag, when the dragged split's shares are the pointer's. */
  const drawn = useRef(shown)

  const ids = useMemo(() => {
    const collect = (node: PaneNode): number[] => (isSplit(node) ? node.children.flatMap(collect) : [node.group])
    return collect(shown).sort((a, b) => a - b)
  }, [shown])
  const sashes = useMemo(() => sashesOf(shown), [shown])

  const place = useCallback(() => {
    const box = boxRef.current
    if (box === null) return
    const geometry = gridGeometry(drawn.current, box.clientWidth, box.clientHeight, gap)
    for (const [id, rect] of geometry.panes) apply(paneElements.current.get(id), rect)
    for (const [key, rect] of geometry.sashes) apply(sashElements.current.get(key), rect)
    window.dispatchEvent(new Event(PANES_MOVED_EVENT))
  }, [gap])

  // A tree that changed under a drag keeps the drag while the divider being
  // held is still there, and ends it when it is not.
  useLayoutEffect(() => {
    const held = drag.current
    const split = held === null ? null : splitAt(shown, held.sash.path)
    if (held !== null && split !== null && split.axis === held.sash.axis && split.children.length === held.sizes.length) {
      drawn.current = held.moved === null ? shown : withShares(shown, held.sash.path, held.moved)
    } else {
      drag.current = null
      drawn.current = shown
    }
    place()
  }, [shown, place])

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return undefined
    const observer = new ResizeObserver(() => place())
    observer.observe(box)
    return () => observer.disconnect()
  }, [place])

  const release = useCallback(() => {
    const ending = drag.current
    if (ending === null) return
    drag.current = null
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    // One write for the whole gesture, and none for a press that never moved.
    if (ending.moved !== null) onResize(ending.sash.path, ending.moved)
  }, [onResize])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      const current = drag.current
      if (current === null) return
      // A move with no button held is a release that happened outside the
      // window, where no `mouseup` is delivered. The panes stay where the
      // pointer left them, so that is where they are written down.
      if (event.buttons === 0) {
        release()
        return
      }
      const along = current.sash.axis === 'row' ? event.clientX : event.clientY
      const sizes = dragShares(current.sizes, current.sash.index, along - current.from, current.room, current.mins)
      current.moved = sizes
      drawn.current = withShares(drawn.current, current.sash.path, sizes)
      place()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', release)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', release)
    }
  }, [place, release])

  const startDrag = useCallback(
    (event: ReactMouseEvent, sash: SashRef) => {
      const box = boxRef.current
      const split = splitAt(drawn.current, sash.path)
      if (box === null || split === null || event.button !== 0) return
      event.preventDefault()
      const geometry = gridGeometry(drawn.current, box.clientWidth, box.clientHeight, gap)
      drag.current = {
        sash,
        from: sash.axis === 'row' ? event.clientX : event.clientY,
        sizes: split.sizes,
        room: geometry.rooms.get(pathKey(sash.path)) ?? 0,
        mins: split.children.map((child) => minExtent(child, sash.axis, gap)),
        moved: null
      }
      document.body.style.userSelect = 'none'
      // The pointer keeps the divider's cursor over whatever it crosses.
      document.body.style.cursor = sash.axis === 'row' ? 'col-resize' : 'row-resize'
    },
    [gap]
  )

  /** Double-click: the split's room shared evenly, as VS Code's divider does. */
  const even = useCallback(
    (sash: SashRef) => {
      const split = splitAt(drawn.current, sash.path)
      if (split === null) return
      onResize(sash.path, split.children.map(() => 1 / split.children.length))
    },
    [onResize]
  )

  return (
    <div ref={boxRef} data-pane-grid className="absolute inset-0">
      {ids.map((id) => (
        <div
          key={id}
          data-pane-slot={id}
          ref={(element) => {
            if (element === null) paneElements.current.delete(id)
            else paneElements.current.set(id, element)
          }}
          className="absolute flex min-h-0 min-w-0"
        >
          {panes.get(id)}
        </div>
      ))}
      {sashes.map((sash) => {
        const upright = sash.axis === 'row'
        return (
          <div
            key={sash.key}
            ref={(element) => {
              if (element === null) sashElements.current.delete(sash.key)
              else sashElements.current.set(sash.key, element)
            }}
            role="separator"
            aria-orientation={upright ? 'vertical' : 'horizontal'}
            title="Drag to resize, double-click to share evenly"
            data-sash={sash.key}
            onMouseDown={(event) => startDrag(event, sash)}
            onDoubleClick={() => even(sash)}
            // The divider is the gutter: a 3px grip that goes accent on hover,
            // with an 8px target whatever the gap is.
            className={cn(
              "group absolute z-10 flex items-center justify-center before:absolute before:content-['']",
              upright
                ? 'cursor-col-resize before:inset-y-0 before:left-1/2 before:w-2 before:-translate-x-1/2'
                : 'cursor-row-resize before:inset-x-0 before:top-1/2 before:h-2 before:-translate-y-1/2'
            )}
          >
            <span
              className={cn(
                'rounded-full bg-border-strong transition-colors group-hover:bg-accent',
                upright ? 'h-10 w-[min(3px,var(--helm-gap))]' : 'h-[min(3px,var(--helm-gap))] w-10'
              )}
            />
          </div>
        )
      })}
    </div>
  )
}
