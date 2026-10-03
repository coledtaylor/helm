import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { PANE_SPLIT_PCT } from '@helm/core/types'

/**
 * The divider between the two panes: a plain mouse drag on the split row,
 * bounded so neither pane can be dragged out of usefulness.
 *
 * The split's boundary is a CSS custom property on the row, not state.
 * `--split` is written by the drag and by the effect below and by nothing
 * else, so a `mousemove` moves a boundary without reconciling anything. The
 * argument in full, and the two attempts this replaces, are in `theme.css`
 * beside `.split-row`.
 *
 * Returns the divider's `onMouseDown`. `writeSettings` is called once per
 * gesture, with the share of the row the second pane landed on.
 */
export function usePaneSplit(
  splitRowRef: RefObject<HTMLDivElement | null>,
  savedSplitPct: number,
  writeSettings: (patch: { paneSplitPct: number }) => void
): (event: ReactMouseEvent) => void {
  const draggingSplit = useRef(false)
  /** Where the current drag has got to, for the one write on release. */
  const splitDragged = useRef<number | null>(null)

  /**
   * The remembered split, put on the row - on mount and whenever the setting
   * changes, and skipped while a drag is running, so a `settings:changed` from
   * anywhere else cannot pull the boundary out from under the pointer.
   * `useLayoutEffect`, so the property is on the row before the browser paints;
   * an ordinary effect would show a frame of the CSS default.
   */
  useLayoutEffect(() => {
    if (draggingSplit.current) return
    splitRowRef.current?.style.setProperty('--split', String(savedSplitPct / 100))
  }, [savedSplitPct, splitRowRef])

  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!draggingSplit.current || !splitRowRef.current) return
      // A move with no button held is not this drag any more. Release outside
      // the window and no `mouseup` is ever delivered, so `buttons` is the only
      // thing that says so - and it is also what stops a driver's synthetic
      // hover from passing for a drag (`drag()` in main/bridge.ts).
      if (event.buttons === 0) {
        draggingSplit.current = false
        document.body.style.userSelect = ''
        return
      }
      // Re-measured every move: the window is resizable while a drag runs.
      const box = splitRowRef.current.getBoundingClientRect()
      if (box.width < 1) return
      const fraction = 1 - (event.clientX - box.left) / box.width
      const bounded = Math.min(
        PANE_SPLIT_PCT.max / 100,
        Math.max(PANE_SPLIT_PCT.min / 100, fraction)
      )
      splitDragged.current = bounded
      // The whole move: one custom property, no state, nothing reconciled.
      splitRowRef.current.style.setProperty('--split', String(bounded))
    }
    const onUp = (): void => {
      draggingSplit.current = false
      document.body.style.userSelect = ''
      // One write for the whole gesture, and none for a press that never moved.
      const landed = splitDragged.current
      splitDragged.current = null
      if (landed === null) return
      const pct = Math.round(landed * 100)
      // Snap to the rounded value the setting will hold, so the next
      // `settings:changed` from anywhere does not move the boundary a pixel.
      splitRowRef.current?.style.setProperty('--split', String(pct / 100))
      if (pct !== savedSplitPct) writeSettings({ paneSplitPct: pct })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [savedSplitPct, writeSettings, splitRowRef])

  return useCallback((event: ReactMouseEvent) => {
    event.preventDefault()
    draggingSplit.current = true
    document.body.style.userSelect = 'none'
  }, [])
}
