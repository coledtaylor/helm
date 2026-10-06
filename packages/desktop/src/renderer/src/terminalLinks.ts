import type { IDisposable, Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import './terminalLinks.css'

/**
 * Ctrl+click on a link in a terminal opens it in the system browser: every
 * time, and once.
 *
 * Two kinds of link reach a terminal. A program that knows the terminal shows
 * hyperlinks writes OSC 8, which xterm reads itself - `ptyEnv` says Helm's does,
 * and Claude Code then draws its links the way Windows Terminal shows them. Any
 * other web address on screen is found by `WebLinksAddon`. For both, xterm
 * works out which link is under the pointer, and this keeps that link - and
 * has xterm look again at a press when it has none (`lookAgain`).
 *
 * The press is taken at the container, in the capture phase, before xterm sees
 * it - and that is the fix rather than a detail. Claude Code's fullscreen
 * interface asks for mouse reports, so the click used to go to it, and it opened
 * the link under rules made for a click on its own window: a press within 400ms
 * of the terminal gaining focus is the click that activated the window and does
 * nothing, and every click waits 500ms to see whether a second one makes it a
 * double-click, which cancels the open. Measured on claude 2.1.291: the first
 * ctrl+click after focus had been anywhere else in Helm opened nothing, the
 * next one did, and clicking again while waiting cancelled both. Taken here,
 * the press never reaches the program, so it neither opens the link a second
 * time nor starts a selection.
 *
 * xterm's own activation, on mouseup and with or without a modifier, does
 * nothing: a plain click on a link belongs to whatever is running, and a
 * ctrl+click has already been handled. Left at xterm's default, an OSC 8 link
 * would put up a `confirm()` and then `window.open`, which this window denies.
 *
 * Only http and https links are links here. OSC 8 links to anything else (a
 * `file://` path Claude Code cites) are not xterm's, so a ctrl+click on one
 * still goes to the program, which handles its own.
 */
export function attachLinks(term: Terminal, container: HTMLElement, open: (url: string) => void): IDisposable {
  trackLinkChord()

  let hovered: string | null = null
  const hover = (_event: MouseEvent, uri: string): void => {
    hovered = uri
  }
  const leave = (): void => {
    hovered = null
  }
  const inert = (): void => {}

  term.options.linkHandler = { activate: inert, hover, leave, allowNonHttpProtocols: false }
  const web = new WebLinksAddon(inert, { hover, leave })
  term.loadAddon(web)

  const press = (event: MouseEvent): void => {
    if (!isLinkChord(event)) return
    if (hovered === null) lookAgain(term, event)
    if (hovered === null) return
    event.preventDefault()
    event.stopPropagation()
    // What any click into a pane does. xterm would have, had it seen the press.
    term.focus()
    // The second press of a double-click is the same click again: kept from
    // the program like the first, but the link is already open.
    if (event.detail <= 1) open(hovered)
  }
  container.addEventListener('mousedown', press, { capture: true })

  return {
    dispose: () => {
      container.removeEventListener('mousedown', press, { capture: true })
      web.dispose()
    }
  }
}

/**
 * Has xterm look for a link under a press it says has none.
 *
 * Its Linkifier looks only when the pointer reaches a cell other than the last
 * one it saw, and `mouseleave` forgets the link but not the cell. So a pointer
 * back on the cell it left from finds nothing - Ctrl+click, the browser opens
 * over the window, and the pointer is still on the link when the window comes
 * back - and the click falls through to the program. That is xterm 6.0.0, and
 * upstream is the same. It also keeps what it found for the line it is on,
 * which a redraw can leave stale.
 *
 * Two moves it cannot skip settle both: one a row away, which drops the line it
 * kept, then one where the press is. They do not bubble, so they reach the
 * Linkifier on the screen element and not xterm's mouse reporting on the
 * element above it, and the program is sent nothing. A press outside the grid
 * is left alone: xterm would clamp it to the nearest cell, and that cell's link
 * is not the one under the pointer.
 */
function lookAgain(term: Terminal, event: MouseEvent): void {
  const screen = term.element?.querySelector('.xterm-screen')
  if (!screen || term.rows < 2) return
  const box = screen.getBoundingClientRect()
  const inside =
    event.clientX >= box.left && event.clientX < box.right && event.clientY >= box.top && event.clientY < box.bottom
  if (!inside) return
  const rowHeight = box.height / term.rows
  const away = event.clientY - box.top >= rowHeight ? -rowHeight : rowHeight
  for (const offset of [away, 0]) {
    screen.dispatchEvent(
      new MouseEvent('mousemove', {
        clientX: event.clientX,
        clientY: event.clientY + offset,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey
      })
    )
  }
}

/** Ctrl and nothing else: the Windows chord for following a link. */
function isChordHeld(event: MouseEvent | KeyboardEvent): boolean {
  return event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
}

function isLinkChord(event: MouseEvent): boolean {
  return event.button === 0 && isChordHeld(event)
}

/**
 * Set on the root while the chord is held, so the pointer over a link appears
 * only when a click would follow it (`terminalLinks.css`). Without the chord a
 * click on a link goes to the program, and a hand there would say otherwise.
 */
export const LINK_CHORD_CLASS = 'helm-link-chord'

let chordHeld: boolean | null = null

/**
 * Whether the chord is held, followed from every key and pointer movement in
 * the window, once for all terminals.
 *
 * Keys alone would miss Ctrl pressed while the window was in the background,
 * and a release while it was; the pointer catches both the moment it moves
 * again, and losing the window drops the state rather than leaving it stuck.
 */
function trackLinkChord(): void {
  if (chordHeld !== null) return
  chordHeld = false
  const set = (held: boolean): void => {
    if (held === chordHeld) return
    chordHeld = held
    document.documentElement.classList.toggle(LINK_CHORD_CLASS, held)
  }
  const follow = (event: MouseEvent | KeyboardEvent): void => {
    set(isChordHeld(event))
  }
  window.addEventListener('keydown', follow, { capture: true })
  window.addEventListener('keyup', follow, { capture: true })
  window.addEventListener('mousemove', follow, { capture: true, passive: true })
  window.addEventListener('blur', () => {
    set(false)
  })
}
