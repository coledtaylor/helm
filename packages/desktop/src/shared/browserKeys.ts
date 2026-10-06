/**
 * The browser's keyboard, as one table both processes read.
 *
 * A key can reach the Browser tab two ways. With the caret in Helm's own
 * chrome - the address bar, the strip - it is a DOM event in the window, and
 * `App.tsx` reads it. With the caret in the page, it goes to that page's own
 * process and the window never sees it; main reads it there, in
 * `before-input-event`, swallows it and forwards the command. Both ask this
 * function, so a binding cannot work from one side and not the other.
 *
 * The bindings are the ones every browser on Windows has, and only those. The
 * page owns everything else - Ctrl+N included, which is why it is not here.
 */

export type BrowserCommand =
  | 'new-page'
  | 'close-page'
  | 'reopen-page'
  | 'find'
  | 'address'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'devtools'

/** A key press, in the shape both Electron's `Input` and a DOM event can give. */
export interface BrowserKey {
  key: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/**
 * The commands whose answer is drawn in Helm's chrome rather than in the page:
 * a new page's address bar, the find field, a page closed or brought back.
 * Pressed inside the page, keyboard focus has to come back to the window
 * first, or the caret those draw would be in a window that is not receiving
 * keys.
 */
export const COMMANDS_FOR_THE_WINDOW: ReadonlySet<BrowserCommand> = new Set<BrowserCommand>([
  'new-page',
  'close-page',
  'reopen-page',
  'find',
  'address'
])

/**
 * The commands a held key repeats. Holding Ctrl+= zooms on; holding Ctrl+W
 * does not close every page in the strip.
 */
export const COMMANDS_THAT_REPEAT: ReadonlySet<BrowserCommand> = new Set<BrowserCommand>([
  'zoom-in',
  'zoom-out',
  'back',
  'forward'
])

/** What a key press does in the Browser tab, or null when it is the page's. */
export function browserKeyCommand(press: BrowserKey): BrowserCommand | null {
  // AltGr arrives as Ctrl+Alt on Windows, and a character typed with it is
  // text, never a command.
  if (press.meta || (press.control && press.alt)) return null
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key
  if (press.alt) {
    if (press.shift) return null
    if (key === 'ArrowLeft') return 'back'
    if (key === 'ArrowRight') return 'forward'
    return null
  }
  if (!press.control) {
    if (key === 'F5') return press.shift ? 'hard-reload' : 'reload'
    if (key === 'F12' && !press.shift) return 'devtools'
    return null
  }
  if (press.shift) {
    if (key === 't') return 'reopen-page'
    if (key === 'r') return 'hard-reload'
    if (key === 'i') return 'devtools'
    // Ctrl+Shift+= is how a US keyboard types Ctrl++.
    if (key === '+') return 'zoom-in'
    return null
  }
  switch (key) {
    case 't':
      return 'new-page'
    case 'w':
    case 'F4':
      return 'close-page'
    case 'f':
      return 'find'
    case 'l':
      return 'address'
    case 'r':
      return 'reload'
    case 'F5':
      return 'hard-reload'
    case '=':
    case '+':
      return 'zoom-in'
    case '-':
      return 'zoom-out'
    case '0':
      return 'zoom-reset'
    default:
      return null
  }
}
