/**
 * The keyboard's one platform question, answered in the window.
 *
 * Helm's own shortcuts are Ctrl chords on Windows and Linux and Cmd chords on
 * macOS, where Cmd is what every app uses and Ctrl belongs to the terminal's
 * program. Everything in the window that binds a shortcut or names one asks
 * here, so a chord and the hint that names it cannot disagree.
 *
 * It is answered from `navigator`, synchronously, because the window knows its
 * own OS without asking main: `userAgentData.platform` where Chromium gives it,
 * `navigator.platform` otherwise. Main answers the same question from
 * `process.platform`; both use Node's names.
 */

/** The OS the window runs on, by Node's name for it. */
export type HostOs = 'darwin' | 'win32' | 'linux'

/** The part of `navigator` the answer is read from. */
export interface PlatformSource {
  platform?: string
  userAgentData?: { platform?: string }
}

export function hostOs(source: PlatformSource | undefined = globalThis.navigator as PlatformSource | undefined): HostOs {
  const fromHints = source?.userAgentData?.platform
  const name = (fromHints !== undefined && fromHints !== '' ? fromHints : (source?.platform ?? '')).toLowerCase()
  if (name.startsWith('mac')) return 'darwin'
  if (name.startsWith('win')) return 'win32'
  return 'linux'
}

export function isMac(source?: PlatformSource): boolean {
  return hostOs(source) === 'darwin'
}

/** The modifiers of a key or mouse event. */
export interface ModifierState {
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * Whether a press holds Helm's shortcut modifier and not the other one: Cmd
 * without Ctrl on macOS, Ctrl without Cmd (the Windows key) elsewhere. On a
 * Mac a Ctrl chord is never Helm's, so Ctrl+letter in a terminal reaches the
 * program.
 */
export function hasPrimaryModifier(event: ModifierState, mac: boolean = isMac()): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export interface ShortcutLabelOptions {
  shift?: boolean
  alt?: boolean
  /**
   * What joins the parts off macOS: `+` ("Ctrl+Shift+F") or a space for the
   * keycap style menus use ("Ctrl N"). macOS writes glyphs with nothing
   * between them, as its own menus do.
   */
  separator?: '+' | ' '
  mac?: boolean
}

/**
 * A shortcut's name as Helm shows it: `⇧⌘F` on macOS, in Apple's modifier
 * order (Option, Shift, Command), and `Ctrl+Shift+F` elsewhere.
 */
export function shortcutLabel(key: string, options: ShortcutLabelOptions = {}): string {
  const { shift = false, alt = false, separator = '+', mac = isMac() } = options
  if (mac) return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}⌘${key}`
  return ['Ctrl', ...(shift ? ['Shift'] : []), ...(alt ? ['Alt'] : []), key].join(separator)
}
