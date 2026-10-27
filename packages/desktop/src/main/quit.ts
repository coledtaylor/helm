/**
 * Quitting while sessions run: asked once, before anything ends.
 *
 * Electron runs `before-quit` before it closes a single window, and
 * `before-quit` is where every session ends (main owns process lifetime). So a
 * window's `close` handler cannot ask on behalf of a quit: by the time it runs,
 * the sessions it would ask about are gone. A quit that asks has to ask before
 * it calls `app.quit()`. That is the app menu's Quit Helm (Cmd+Q on macOS),
 * which is why that item is not Electron's `quit` role (chrome.ts).
 *
 * Closing the window asks in its `close` handler, as it always has: the window
 * closes first, and the quit follows from `window-all-closed`.
 *
 * The two share one answer. A yes given to either is not asked again by the
 * other, so a quit agreed to from the menu closes the window without a second
 * question, and a second request while the question is on screen waits for
 * that answer rather than opening another. A no ends nothing and leaves the
 * app open.
 *
 * A quit code starts is not held here. One that calls `app.quit()` - the E2E
 * harness's close, a check finishing - reaches `before-quit` first, which ends
 * the sessions, so the window then closes with nothing running. One that
 * closes the window first and then quits, the order Electron's
 * `autoUpdater.quitAndInstall` uses, meets the window's question once. The
 * Dock's Quit and a logout on macOS reach `before-quit` the way `app.quit()`
 * does, and Electron gives `before-quit` nothing to tell them from a quit code
 * started, so they are not asked either.
 */

/** What a quit, or a close of the window, does next. */
export type QuitStep =
  /** Go ahead: nothing is running, or the user has already agreed to end it. */
  | 'proceed'
  /** Hold it and ask whether to end the running sessions. */
  | 'ask'
  /** Hold it: the question is already on screen, and its answer decides. */
  | 'wait'

export interface QuitState {
  /** How many hosted sessions are running. */
  running: number
  /** Whether the user has already agreed to end them. */
  agreed: boolean
  /** Whether the question is on screen now. */
  asking: boolean
}

export function nextQuitStep({ running, agreed, asking }: QuitState): QuitStep {
  if (agreed || running === 0) return 'proceed'
  return asking ? 'wait' : 'ask'
}

export interface QuitGateHost {
  /** How many hosted sessions are running now. */
  running: () => number
  /** Asks whether to end them; true when the user agrees. */
  confirm: () => Promise<boolean>
  /** Quits the app: `app.quit()`, whose `before-quit` ends the sessions. */
  quit: () => void
}

export interface QuitGate {
  /** The app menu's Quit Helm: quits, asking first while sessions run. */
  requestQuit(): void
  /**
   * The window's `close`. True when the close may go ahead now. False when it
   * must be held: the gate is then asking, or waiting on the question already
   * asked, and calls `closeAgain` on a yes it asked for.
   */
  allowClose(closeAgain: () => void): boolean
}

export function createQuitGate(host: QuitGateHost): QuitGate {
  let agreed = false
  let asking = false

  const next = (): QuitStep => nextQuitStep({ running: host.running(), agreed, asking })

  /** Asks, and on a yes remembers it and carries on with `then`. */
  const ask = (then: () => void): void => {
    asking = true
    void host
      .confirm()
      // A question that could not be asked is a no: nothing ends, and the
      // next quit asks again.
      .catch(() => false)
      .then((yes) => {
        asking = false
        if (!yes) return
        agreed = true
        then()
      })
  }

  return {
    requestQuit() {
      const step = next()
      if (step === 'proceed') host.quit()
      else if (step === 'ask') ask(() => host.quit())
    },

    allowClose(closeAgain) {
      const step = next()
      if (step === 'ask') ask(closeAgain)
      return step === 'proceed'
    }
  }
}
