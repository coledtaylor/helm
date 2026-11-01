import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * What a Copy button says after it is pressed: that it copied, briefly, or
 * that the clipboard refused it, for long enough to read. On Windows another
 * program holding the clipboard open refuses every other program's write, and
 * Helm retries before it gives up (`main/clipboard.ts`), so a refusal here is
 * one that lasted.
 */

export const COPY_REFUSED = 'Not copied: another program is holding the clipboard. Try again.'
export const PASTE_REFUSED = 'Not pasted: another program is holding the clipboard. Try again.'

export const COPIED_SHOWN_MS = 1200
export const REFUSED_SHOWN_MS = 5000

export type CopyState = 'idle' | 'copied' | 'refused'

/** A Copy path button's name, which is also its hover text, in each state. */
export function copyPathLabel(state: CopyState): string {
  return state === 'copied' ? 'Path copied' : state === 'refused' ? COPY_REFUSED : 'Copy path'
}

/**
 * `[state, press]`: `press` runs `copy`, which resolves false when the
 * clipboard refused it, and `state` says how it went until its time is up. A
 * second press restarts that time.
 */
export function useCopyFeedback(copy: () => Promise<boolean>): [CopyState, () => void] {
  // The press count is in the state so a second press with the same result
  // still restarts the time.
  const [shown, setShown] = useState<{ state: CopyState; press: number }>({ state: 'idle', press: 0 })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (shown.state === 'idle') return undefined
    const timer = setTimeout(
      () => setShown((current) => ({ state: 'idle', press: current.press })),
      shown.state === 'copied' ? COPIED_SHOWN_MS : REFUSED_SHOWN_MS
    )
    return () => clearTimeout(timer)
  }, [shown])

  const press = useCallback(() => {
    void copy().then((copied) => {
      if (!mounted.current) return
      setShown((current) => ({ state: copied ? 'copied' : 'refused', press: current.press + 1 }))
    })
  }, [copy])

  return [shown.state, press]
}
