import type { RefObject } from 'react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { overlayMounted } from './overlay'

/** Where a popup opens: at a point (a right-click), or under a control. */
export type PopupAnchor = { x: number; y: number } | { below: DOMRect }

/** Kept clear of the window's edge, so the border is never the edge. */
const MARGIN = 8
/** The gap between a control and what drops from it. */
const DROP = 4

/**
 * What every popup does that is not about its contents: it counts as an
 * overlay, it is placed once its size is known, and it goes away when the
 * window stops being the thing it was placed against.
 *
 * **An overlay while it is mounted.** A browser tab is a native view that paints
 * over every bit of renderer DOM, and a popup opened from a strip or the rail
 * can reach across a pane holding one - so it registers in `lib/overlay.ts`
 * exactly as a dialog does, and the view gets out of the way.
 *
 * **Placed, then shown.** Flipped above a control with no room under it, and
 * pulled back inside the window wherever it would cross the edge. Null until
 * then, so the caller can draw it hidden for the frame it is measured in.
 *
 * **A press anywhere else closes it**, as does the window losing focus or
 * changing size - a popup left floating over a layout that moved is pointing at
 * nothing. A press on the control that opened it is not "anywhere else": that
 * control's own click is what closes it, and treating the press as outside too
 * would close it and open it again in one click. `holdOpen` suspends the rule
 * while the popup has opened a list of its own, which is portalled outside it:
 * a press there belongs to the list.
 */
export function usePopup({
  ref,
  at,
  anchorRef,
  holdOpen = false,
  onDismiss
}: {
  ref: RefObject<HTMLElement | null>
  at: PopupAnchor
  anchorRef?: RefObject<HTMLElement | null> | undefined
  holdOpen?: boolean
  onDismiss: () => void
}): { left: number; top: number } | null {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => overlayMounted(), [])

  useLayoutEffect(() => {
    const popup = ref.current
    if (popup === null) return
    const { width, height } = popup.getBoundingClientRect()
    const maxLeft = window.innerWidth - width - MARGIN
    const maxTop = window.innerHeight - height - MARGIN
    let left: number
    let top: number
    if ('below' in at) {
      left = at.below.left
      top = at.below.bottom + DROP
      if (top > maxTop && at.below.top - height - DROP >= MARGIN) top = at.below.top - height - DROP
    } else {
      left = at.x
      top = at.y
    }
    setPlace({ left: Math.max(MARGIN, Math.min(left, maxLeft)), top: Math.max(MARGIN, Math.min(top, maxTop)) })
  }, [ref, at])

  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (holdOpen) return
      if (event.target instanceof Node) {
        if (ref.current?.contains(event.target)) return
        if (anchorRef?.current?.contains(event.target)) return
      }
      onDismiss()
    }
    const away = (): void => onDismiss()
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
    }
  }, [ref, anchorRef, holdOpen, onDismiss])

  return place
}
