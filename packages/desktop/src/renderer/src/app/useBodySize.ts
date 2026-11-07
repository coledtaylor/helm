import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from 'react'

/**
 * Tells `onChange` when the window's pixel ratio changes, which it does when the
 * window is dragged to a screen with another one. A cell is quantised to whole
 * device pixels, so the same font is a different cell there, and the pane's own
 * size need not change at all.
 */
function subscribeRatio(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined
  let query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`)
  const changed = (): void => {
    onChange()
    // The query names the ratio it was made at, so it is made again at the new one.
    query.removeEventListener('change', changed)
    query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`)
    query.addEventListener('change', changed)
  }
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}

/** The window's device pixel ratio, read again when it changes. */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribeRatio, () => window.devicePixelRatio || 1)
}

/** A box in CSS pixels. */
export interface BodySize {
  width: number
  height: number
}

/**
 * The size `ref`'s element is drawn at, as of the last time it was drawn, or
 * null until it has been.
 *
 * An element that is not drawn measures nothing, and a tab that is not in front
 * is not drawn, so a size of nothing is not news: the last real size is kept.
 * That is what lets a family view that was hidden come back as it was, and lets
 * the window judge a pane it cannot see right now by the last size it had.
 */
export function useBodySize(ref: RefObject<HTMLElement | null>): BodySize | null {
  const [size, setSize] = useState<BodySize | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = (): void => {
      const { width, height } = element.getBoundingClientRect()
      if (width < 1 || height < 1) return
      setSize((last) => (last !== null && last.width === width && last.height === height ? last : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
