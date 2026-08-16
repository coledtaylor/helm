import { useSyncExternalStore } from 'react'

/**
 * Whether a modal overlay is up, in one place.
 *
 * The four dialogs each described their own backdrop and nothing anywhere knew
 * one was open. That was survivable while the answer only mattered to the
 * dialog itself, and stops being survivable the moment something *outside* the
 * React tree needs it: the integrated browser pane is a `WebContentsView`, a
 * native view paints above all renderer DOM, and it has to get out of the way
 * whenever a dialog is up. Answered per call site, that is four edits now and a
 * fifth every time somebody writes a dialog and forgets - a bug that only
 * appears when a browser tab happens to be open, which is to say a bug nobody
 * reproduces.
 *
 * So the question is asked here instead. `Overlay` is the only writer, on mount
 * and unmount; everything else reads or subscribes.
 *
 * **A count, not a flag.** Two overlays can be up at once and it is not
 * hypothetical - the main process pushes `session:confirm` whenever it likes,
 * including over an open profile editor, and `App` renders those two from
 * different state. A boolean would go false when the first of the two closed
 * and un-hide a native view sitting over the second.
 */
let depth = 0

const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

/**
 * Records an overlay as up, and returns the function that records it as gone.
 *
 * Shaped as an effect body - `useEffect(() => overlayMounted(), [])` - so the
 * release is the cleanup React already guarantees, rather than a second call
 * somebody has to remember. The release is idempotent because React may run a
 * cleanup twice (StrictMode does, deliberately) and a depth that went negative
 * would report "no overlay" while one was on screen.
 */
export function overlayMounted(): () => void {
  depth += 1
  announce()
  let released = false
  return () => {
    if (released) return
    released = true
    depth -= 1
    announce()
  }
}

/** Whether any overlay is up. The one question, asked the one way. */
export function overlayOpen(): boolean {
  return depth > 0
}

/** Notified whenever the answer changes. Returns its own unsubscribe. */
export function subscribeOverlay(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The same question from inside React.
 *
 * `useSyncExternalStore` rather than a context: the writer is a component that
 * mounts *underneath* whoever wants the answer, so a provider would have to sit
 * above every dialog and every reader, and the readers are not all in the tree
 * anyway - the browser pane's is an effect that talks to the main process.
 */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlay, overlayOpen, overlayOpen)
}
