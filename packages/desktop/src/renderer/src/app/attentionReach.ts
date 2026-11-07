import { useEffect, useState } from 'react'

/**
 * How wide the attention stack (needs-you toasts and While you were away) may
 * be. The stack sits 8px in from the window's left edge over the rail and the
 * sidebar, where no browser view reaches; the panes start where the sidebar
 * ends, and a native view paints over everything drawn there. So a stack wider
 * than the rail and the sidebar would be cut off by the page, and it is made no
 * wider than the room to the left of the panes, less its inset and the gutter.
 * With nothing known of the panes, or the sidebar hidden (the stack is then
 * over the panes and stands the page down), only the window's width limits it.
 */
export const STACK_INSET_PX = 8
const STACK_CLEAR_PX = 4

export function stackWidth(panesLeft: number | null, viewport: number): number {
  const window = Math.max(viewport - 2 * STACK_INSET_PX, 0)
  if (panesLeft === null) return window
  return Math.max(Math.min(window, panesLeft - STACK_INSET_PX - STACK_CLEAR_PX), 0)
}

/** The left edge of the panes' column, or null when there is none. */
function panesLeft(): number | null {
  const panes = document.querySelector('main')
  return panes === null ? null : panes.getBoundingClientRect().left
}

/**
 * The stack's widest width now: it follows the sidebar's width and the window's
 * size. `sidebarShown` false means the stack is over the panes, so only the
 * window limits it.
 */
export function useStackWidth(sidebarShown: boolean, active: boolean): number {
  const measure = (): number => stackWidth(sidebarShown ? panesLeft() : null, window.innerWidth)
  const [width, setWidth] = useState(measure)
  useEffect(() => {
    if (!active) return undefined
    const update = (): void => {
      setWidth(measure())
    }
    update()
    const panes = document.querySelector('main')
    const observer = panes === null ? null : new ResizeObserver(update)
    if (panes !== null) observer?.observe(panes)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarShown, active])
  return width
}
