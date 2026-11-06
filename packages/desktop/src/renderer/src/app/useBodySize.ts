import { useLayoutEffect, useState, type RefObject } from 'react'

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
