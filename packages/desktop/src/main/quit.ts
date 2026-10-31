import type { QuitAnswer } from '../shared/ipc'

/**
 * Quitting while sessions run: asked once, before anything ends.
 *
 * Electron runs `before-quit` before it closes a single window, and
 * `before-quit` is where sessions end: Helm's own, with the setting off (main
 * owns process lifetime), or, with sessions in the local host, the ones this
 * device started there when the quit setting says so. So a window's `close`
 * handler cannot ask on behalf of a quit: by the time it runs, the sessions it
 * would ask about are gone. A quit that asks has to ask before it calls
 * `app.quit()`. That is the app menu's Quit Helm (Cmd+Q on macOS), which is
 * why that item is not Electron's `quit` role (chrome.ts).
 *
 * Closing the window asks in its `close` handler, as it always has: the window
 * closes first, and the quit follows from `window-all-closed`.
 *
 * The two share one answer. An answer given to either is not asked again by
 * the other, so a quit agreed to from the menu closes the window without a
 * second question, and a second request while the question is on screen waits
 * for that answer rather than opening another. Cancel ends nothing and leaves
 * the app open. With sessions in the local host the question has a third
 * answer, Keep running and quit, which quits and leaves the sessions running
 * there; it applies to this quit only and never changes the setting.
 *
 * A quit code starts is not held here. One that calls `app.quit()` - the E2E
 * harness's close, a check finishing - reaches `before-quit` first, which does
 * what the setting says, so the window then closes with nothing left to ask
 * about. One that closes the window first and then quits, the order Electron's
 * `autoUpdater.quitAndInstall` uses, meets the window's question once. The
 * Dock's Quit and a logout on macOS reach `before-quit` the way `app.quit()`
 * does, and Electron gives `before-quit` nothing to tell them from a quit code
 * started, so they are not asked either.
 */

/** What a quit, or a close of the window, does next. */
export type QuitStep =
  /** Go ahead: nothing would end, or the user has already answered. */
  | 'proceed'
  /** Hold it and ask what becomes of the running sessions. */
  | 'ask'
  /** Hold it: the question is already on screen, and its answer decides. */
  | 'wait'

export interface QuitState {
  /** How many running sessions quitting would end. */
  running: number
  /** Whether the user has already answered End or Keep for this quit. */
  agreed: boolean
  /** Whether the question is on screen now. */
  asking: boolean
}

export function nextQuitStep({ running, agreed, asking }: QuitState): QuitStep {
  if (agreed || running === 0) return 'proceed'
  return asking ? 'wait' : 'ask'
}

/**
 * Whether a deliberate quit ends the sessions this device started: as the user
 * answered the question when it was asked, and as the setting says when it was
 * not (nothing would end, or a quit code started).
 */
export function quitEnds(answer: Exclude<QuitAnswer, 'cancel'> | null, settingEnds: boolean): boolean {
  return answer === null ? settingEnds : answer === 'end'
}

export interface QuitGateHost {
  /** How many running sessions quitting would end now: none when the setting keeps them. */
  running: () => number
  /** Asks what becomes of them. */
  confirm: () => Promise<QuitAnswer>
  /** Quits the app: `app.quit()`, whose `before-quit` does what was answered. */
  quit: () => void
}

export interface QuitGate {
  /** The app menu's Quit Helm: quits, asking first while sessions would end. */
  requestQuit(): void
  /**
   * The window's `close`. True when the close may go ahead now. False when it
   * must be held: the gate is then asking, or waiting on the question already
   * asked, and calls `closeAgain` on an answer that quits.
   */
  allowClose(closeAgain: () => void): boolean
  /** What the user answered for this quit, or null while nobody was asked. */
  answer(): Exclude<QuitAnswer, 'cancel'> | null
}

export function createQuitGate(host: QuitGateHost): QuitGate {
  let answered: Exclude<QuitAnswer, 'cancel'> | null = null
  let asking = false

  const next = (): QuitStep => nextQuitStep({ running: host.running(), agreed: answered !== null, asking })

  /** Asks, and on an answer that quits remembers it and carries on with `then`. */
  const ask = (then: () => void): void => {
    asking = true
    void host
      .confirm()
      // A question that could not be asked is a cancel: nothing ends, and the
      // next quit asks again.
      .catch((): QuitAnswer => 'cancel')
      .then((answer) => {
        asking = false
        if (answer === 'cancel') return
        answered = answer
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
    },

    answer: () => answered
  }
}
