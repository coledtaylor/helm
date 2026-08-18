import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeOverlay, overlayOpen, type ConsoleEntry } from '@helm/ui'
import type { BrowserState } from '../../../shared/ipc'
import { helm } from './bridge'

/**
 * The window's half of the browser pane.
 *
 * There is almost nothing here, and that is the shape rather than an accident:
 * every browser view is a `WebContentsView` the main process owns, so this hook
 * holds a mirror of what main last said and a route to ask it for something. It
 * is the same relationship `useSessions` has to the pty host.
 *
 * The one piece of real logic is `sendBounds`, and it is the only place in the
 * app that answers the question "should the native view be on screen right
 * now". Four things can make the answer no and none of them is visible from
 * inside `BrowserPane`:
 *
 *   - the tab is not the one in front (the pane is not even mounted then)
 *   - a modal overlay is up - `lib/overlay.ts`, subscribed **once**, here
 *   - the workspace column is collapsed behind a maximised session
 *   - a workspace tab is being dragged
 *
 * So the pane reports its rectangle and this decides whether it paints.
 */

export interface BrowserPanesState {
  /** Every live view, keyed by id. Adopted from main on mount. */
  views: Map<number, BrowserState>
  entries: Map<number, ConsoleEntry[]>
  open: (request: { url?: string; project?: string | null }) => Promise<BrowserState | null>
  close: (id: number) => void
  navigate: (id: number, input: string) => void
  back: (id: number) => void
  forward: (id: number) => void
  reload: (id: number, hard: boolean) => void
  devtools: (id: number) => void
  find: (id: number, query: string, forward: boolean) => void
  stopFind: (id: number) => void
  zoom: (id: number, level: number) => void
  clearStorage: (id: number) => void
  evaluate: (id: number, source: string) => Promise<{ ok: boolean; value: string; error: string | null }>
  /** Report where the placeholder is. `showing` is the caller's half of "visible". */
  sendBounds: (
    id: number,
    rect: { x: number; y: number; width: number; height: number },
    showing: boolean
  ) => void
  /**
   * Whether this view's tab is the one in front.
   *
   * Separate from `sendBounds` because a tab switch does not move anything: the
   * pane that was showing is unmounted, so it will never report a rectangle
   * again, and the view has to be told to stand down by something that is still
   * rendering. The last rectangle is kept, so coming back to the tab puts the
   * page straight back where it was rather than at nothing.
   */
  setShowing: (id: number, showing: boolean) => void
  /**
   * Take every view off the screen, whatever the panes last said.
   *
   * The tab-drag case, and the one that cannot be expressed as a bounds report:
   * a drag does not resize anything, so nothing re-measures and no rectangle is
   * sent. See `App.tsx`, where the drag is.
   */
  setSuppressed: (suppressed: boolean) => void
  /** The last addresses any view visited, newest first. */
  recent: string[]
  /** The last problem `browser:open` refused with, for the strip to report. */
  error: string | null
  dismissError: () => void
}

export function useBrowsers(recent: readonly string[]): BrowserPanesState {
  const [views, setViews] = useState<Map<number, BrowserState>>(() => new Map())
  const [entries, setEntries] = useState<Map<number, ConsoleEntry[]>>(() => new Map())
  const [error, setError] = useState<string | null>(null)

  /**
   * What the panes last reported, so a reason to hide that is not a resize can
   * still be applied.
   *
   * A ref rather than state: nothing renders from it, and a `setState` per
   * `ResizeObserver` callback would put a React render inside a split drag -
   * which is the mistake the divider's own comment in `App.tsx` is about.
   */
  const rects = useRef(
    new Map<number, { x: number; y: number; width: number; height: number; showing: boolean }>()
  )
  const suppressed = useRef(false)

  const push = useCallback((id: number): void => {
    const rect = rects.current.get(id)
    if (rect === undefined) return
    helm.send('browser:bounds', {
      id,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      // The single boolean, and every reason folded into it. `overlayOpen()` is
      // read rather than subscribed to *here* because this runs on every frame
      // of a drag; the subscription below is what makes a dialog opening move
      // the view without waiting for the next resize.
      visible: rect.showing && !suppressed.current && !overlayOpen()
    })
  }, [])

  const pushAll = useCallback((): void => {
    for (const id of rects.current.keys()) push(id)
  }, [push])

  /**
   * The overlay subscription. **Once**, for the whole app.
   *
   * The prerequisite milestone made "is a dialog up" one subscribable question
   * precisely so this could be one line rather than a rule every future dialog
   * has to remember. Nothing here knows which dialog, or that there are
   * dialogs at all.
   */
  useEffect(() => subscribeOverlay(pushAll), [pushAll])

  // Adopt whatever main is already holding. A renderer reload - dev HMR, or a
  // render process that died - leaves views with no tab, exactly as it leaves
  // sessions with no tab, and the same answer applies.
  useEffect(() => {
    void helm
      .invoke('browser:state', {})
      .then((states) => {
        if (states.length === 0) return
        setViews(new Map(states.map((state) => [state.id, state])))
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const offChanged = helm.on('browser:changed', (state) => {
      setViews((current) => new Map(current).set(state.id, state))
    })
    const offOpened = helm.on('browser:opened', (state) => {
      setViews((current) => new Map(current).set(state.id, state))
    })
    const offClosed = helm.on('browser:closed', ({ id }) => {
      setViews((current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      })
      rects.current.delete(id)
    })
    const offLogged = helm.on('browser:logged', ({ id, entry }) => {
      setEntries((current) => {
        const next = new Map(current)
        // The window keeps the tail. Main holds the whole ring (1000 per view)
        // and answers `browser:console` with it, so nothing is lost by the
        // window being cheaper than the buffer behind it.
        next.set(id, [...(current.get(id) ?? []).slice(-499), entry])
        return next
      })
    })
    return () => {
      offChanged()
      offOpened()
      offClosed()
      offLogged()
    }
  }, [])

  const open = useCallback(
    async (request: { url?: string; project?: string | null }): Promise<BrowserState | null> => {
      let answer: { state: BrowserState | null; problem: string | null }
      try {
        answer = await helm.invoke('browser:open', request)
      } catch (err) {
        // No tab was made, so there is no problem line to write on: this is the
        // one browser failure that has to go somewhere else, and `error` is
        // where the cap's refusal already goes.
        setError(`Helm could not open a browser tab: ${err instanceof Error ? err.message : String(err)}`)
        return null
      }
      if (answer.state !== null) {
        setViews((current) => new Map(current).set(answer.state!.id, answer.state!))
        // Whatever main already has for this view - a `window.open` tab, or one
        // adopted after a reload - rather than an empty panel.
        void helm
          .invoke('browser:console', { id: answer.state.id })
          .then((lines) => {
            setEntries((current) => new Map(current).set(answer.state!.id, lines))
          })
          .catch(() => undefined)
      } else if (answer.problem !== null) {
        setError(answer.problem)
      }
      return answer.state
    },
    []
  )

  const remember = useCallback((state: BrowserState | null): void => {
    if (state === null) return
    setViews((current) => new Map(current).set(state.id, state))
  }, [])

  /**
   * What a browser call that **failed** does, instead of nothing.
   *
   * Every one of these used to end `.catch(() => undefined)`, and that turned
   * out to be half of a bug report: a fault in the main process left the pane
   * blank, refusing every address, with no error anywhere and nothing in the
   * console. The fault itself is fixed in `browser.ts`; this is the part that
   * says a rejection may not be invisible again.
   *
   * It lands on the tab's own problem line - the one `BrowserPane` already
   * paints above the page - because that is where somebody looking at the tab
   * that failed is already looking. It is a local patch over the mirror rather
   * than a second kind of state: the next `browser:changed` from main replaces
   * it, which is right, since main is the side that knows when the trouble is
   * over.
   */
  const failed = useCallback(
    (id: number, doing: string) =>
      (err: unknown): void => {
        const detail = err instanceof Error ? err.message : String(err)
        setViews((current) => {
          const view = current.get(id)
          if (view === undefined) return current
          return new Map(current).set(id, {
            ...view,
            problem: `Helm could not ${doing} this tab: ${detail}`
          })
        })
      },
    []
  )

  const close = useCallback((id: number) => {
    void helm.invoke('browser:close', { id }).catch(() => undefined) // the tab is gone from this map either way
    setViews((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
    setEntries((current) => {
      const next = new Map(current)
      next.delete(id)
      return next
    })
    rects.current.delete(id)
  }, [])

  const navigate = useCallback(
    (id: number, input: string) => {
      void helm
        .invoke('browser:navigate', { id, input })
        .then(remember)
        .catch(failed(id, 'navigate'))
    },
    [remember, failed]
  )

  const back = useCallback(
    (id: number) => {
      void helm.invoke('browser:back', { id }).then(remember).catch(failed(id, 'go back in'))
    },
    [remember, failed]
  )
  const forward = useCallback(
    (id: number) => {
      void helm
        .invoke('browser:forward', { id })
        .then(remember)
        .catch(failed(id, 'go forward in'))
    },
    [remember, failed]
  )
  const reload = useCallback(
    (id: number, hard: boolean) => {
      void helm.invoke('browser:reload', { id, hard }).then(remember).catch(failed(id, 'reload'))
    },
    [remember, failed]
  )
  const devtools = useCallback(
    (id: number) => {
      void helm
        .invoke('browser:devtools', { id })
        .then(remember)
        .catch(failed(id, 'open DevTools for'))
    },
    [remember, failed]
  )
  const find = useCallback(
    (id: number, query: string, forward: boolean) => {
      void helm.invoke('browser:find', { id, query, forward }).catch(failed(id, 'search'))
    },
    [failed]
  )
  const stopFind = useCallback(
    (id: number) => {
      void helm.invoke('browser:stopFind', { id }).catch(failed(id, 'stop searching'))
    },
    [failed]
  )
  const zoom = useCallback(
    (id: number, level: number) => {
      void helm.invoke('browser:zoom', { id, level }).then(remember).catch(failed(id, 'zoom'))
    },
    [remember, failed]
  )
  const clearStorage = useCallback(
    (id: number) => {
      void helm
        .invoke('browser:clearStorage', { id })
        .then(remember)
        .catch(failed(id, 'clear the browsing data of'))
    },
    [remember, failed]
  )
  const evaluate = useCallback(
    (id: number, source: string) => helm.invoke('browser:eval', { id, source }),
    []
  )

  const sendBounds = useCallback(
    (
      id: number,
      rect: { x: number; y: number; width: number; height: number },
      showing: boolean
    ) => {
      rects.current.set(id, { ...rect, showing })
      push(id)
    },
    [push]
  )

  const setShowing = useCallback(
    (id: number, showing: boolean) => {
      const rect = rects.current.get(id)
      if (rect === undefined || rect.showing === showing) return
      rects.current.set(id, { ...rect, showing })
      push(id)
    },
    [push]
  )

  const setSuppressed = useCallback(
    (next: boolean) => {
      if (suppressed.current === next) return
      suppressed.current = next
      pushAll()
    },
    [pushAll]
  )

  return {
    views,
    entries,
    open,
    close,
    navigate,
    back,
    forward,
    reload,
    devtools,
    find,
    stopFind,
    zoom,
    clearStorage,
    evaluate,
    sendBounds,
    setShowing,
    setSuppressed,
    recent: [...recent],
    error,
    dismissError: () => setError(null)
  }
}
