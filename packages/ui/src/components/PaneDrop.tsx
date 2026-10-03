import type { DragEvent, JSX } from 'react'
import { useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { dropZoneAt, PANE_MIN_HEIGHT, PANE_MIN_WIDTH, type PaneDropZone } from '../lib/paneGeometry'
import { TAB_MIME } from './TabBar'

export interface PaneDropProps {
  /**
   * A tab is being dragged somewhere in the window. The layer takes the drag
   * only then, and is inert - no pointer events at all - otherwise.
   */
  active: boolean
  /**
   * Whether dropping in a zone would do anything: not the middle of the pane
   * the tab is already in, and not a side of a pane whose only tab it is.
   */
  allows: (zone: PaneDropZone) => boolean
  onDrop: (tab: string, zone: PaneDropZone) => void
}

/** What each zone's preview covers of the pane: all four sides, so a move between zones can slide. */
const PREVIEW: Record<PaneDropZone, string> = {
  center: 'top-0 right-0 bottom-0 left-0',
  left: 'top-0 right-1/2 bottom-0 left-0',
  right: 'top-0 right-0 bottom-0 left-1/2',
  top: 'top-0 right-0 bottom-1/2 left-0',
  bottom: 'top-1/2 right-0 bottom-0 left-0'
}

/** The gutter, read off the custom property `applyShape` keeps on `<html>`. */
function gutter(): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--helm-gap'))
  return Number.isFinite(value) ? value : 0
}

/**
 * Where a tab dragged over a pane lands, and the preview of it: the part of
 * the pane it would take.
 *
 * Dropped at a side, the tab opens a new pane there, taking that half; dropped
 * in the middle, it joins this pane, the same as dropping it on the strip. The
 * zones are `dropZoneAt`'s. A side is also refused when the pane is too narrow
 * or too short to halve without going under the minimum, and the pointer there
 * means the middle instead.
 *
 * Two layers. The **target** covers the pane below its strip, so the strip
 * keeps its own drop and its insertion mark; the **preview** is drawn over the
 * whole pane, strip included, because that is what a new pane at a side would
 * split. The preview is `accent-soft` with an accent edge - the accent never
 * floods - and takes no pointer events, so it never becomes the thing under
 * the pointer.
 *
 * A native browser view would paint over both, which is why a tab drag hides
 * it for the length of the gesture (`TabBar`'s `onDragging`).
 */
export function PaneDrop({ active, allows, onDrop }: PaneDropProps): JSX.Element {
  const [zone, setZone] = useState<PaneDropZone | null>(null)
  /** Measured when a drag comes in, not on every `dragover`. */
  const fits = useRef({ row: true, column: true })

  const carriesTab = (event: DragEvent<HTMLElement>): boolean => event.dataTransfer.types.includes(TAB_MIME)

  const zoneOf = (event: DragEvent<HTMLElement>): PaneDropZone | null => {
    const pane = event.currentTarget.parentElement
    if (pane === null) return null
    const box = pane.getBoundingClientRect()
    return dropZoneAt(event.clientX - box.left, event.clientY - box.top, box.width, box.height, (candidate) => {
      if (candidate === 'left' || candidate === 'right') return fits.current.row && allows(candidate)
      if (candidate === 'top' || candidate === 'bottom') return fits.current.column && allows(candidate)
      return allows(candidate)
    })
  }

  const shown = active ? zone : null

  return (
    <>
      <div
        data-pane-drop
        aria-hidden
        onDragEnter={(event) => {
          if (!carriesTab(event)) return
          const pane = event.currentTarget.parentElement?.getBoundingClientRect()
          const gap = gutter()
          fits.current = {
            row: pane === undefined || pane.width >= 2 * PANE_MIN_WIDTH + gap,
            column: pane === undefined || pane.height >= 2 * PANE_MIN_HEIGHT + gap
          }
        }}
        onDragOver={(event) => {
          if (!carriesTab(event)) return
          const next = zoneOf(event)
          setZone(next)
          // A zone that would do nothing is no drop target at all, so the
          // pointer says so rather than promising a move.
          if (next === null) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragLeave={(event) => {
          const entering = event.relatedTarget
          if (entering instanceof Node && event.currentTarget.contains(entering)) return
          setZone(null)
        }}
        onDrop={(event) => {
          if (!carriesTab(event)) return
          event.preventDefault()
          // Where the preview said, rather than measured again: the drop lands
          // on what was drawn.
          const tab = event.dataTransfer.getData(TAB_MIME)
          const landing = zone
          setZone(null)
          if (tab !== '' && landing !== null) onDrop(tab, landing)
        }}
        className={cn(
          'absolute inset-x-0 top-strip bottom-0 z-30',
          active ? 'pointer-events-auto' : 'pointer-events-none'
        )}
      />
      {shown !== null && (
        <div
          aria-hidden
          data-pane-drop-preview={shown}
          className={cn(
            'pointer-events-none absolute z-30 rounded-island border border-accent bg-accent-soft transition-[top,right,bottom,left] duration-100 ease-out',
            PREVIEW[shown]
          )}
        />
      )}
    </>
  )
}
