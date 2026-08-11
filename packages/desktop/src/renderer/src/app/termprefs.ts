import type { AppSettings } from '@helm/core'
import { terminalFontStack, TERMINAL_DEFAULTS, type TerminalPrefs } from '../terminal'

/**
 * The terminal preferences currently in force, for terminals that live outside
 * React.
 *
 * Both registries - session panes (`terminals.ts`) and project shells
 * (`pterms.ts`) - hold live `Terminal` objects that no render owns, so a
 * settings change cannot reach them by being a prop. `settings:changed` reaches
 * React state and stops there; this is the other half of that push.
 *
 * Deliberately a store rather than a lookup into settings: a terminal is
 * created at some arbitrary later moment (a tab opening, a project pane
 * mounting) and has to be born with the current preferences, not the defaults
 * plus a correction one frame later.
 *
 * The spike page has no part in this. It calls `createTerminal` without
 * preferences and gets `TERMINAL_DEFAULTS`, which is what keeps `pnpm fidelity`
 * and `pnpm claude-check` measuring the configuration Spike C proved.
 */

let current: TerminalPrefs = TERMINAL_DEFAULTS

type Listener = (prefs: TerminalPrefs) => void
const listeners = new Set<Listener>()

/** What a terminal created right now should be built with. */
export function terminalPrefs(): TerminalPrefs {
  return current
}

/**
 * The settings, as a terminal understands them.
 *
 * The one transformation that happens here is the font stack: the setting names
 * one family and a terminal takes a fallback chain, and `terminalFontStack` is
 * where the "prepend, never replace" rule lives.
 */
export function effectiveTerminalPrefs(settings: AppSettings): TerminalPrefs {
  return {
    fontFamily: terminalFontStack(settings.terminalFontFamily),
    fontSize: settings.terminalFontSize,
    cursorStyle: settings.terminalCursorStyle,
    cursorBlink: settings.terminalCursorBlink,
    scrollback: settings.terminalScrollback
  }
}

/** Called by whoever is holding the current settings. Idempotent. */
export function applyTerminalSettings(settings: AppSettings): void {
  const next = effectiveTerminalPrefs(settings)
  // Nothing moved, so nothing is told. Without this every unrelated settings
  // write - a scan root, the theme, the window bounds - would refit every open
  // terminal, and a refit that lands mid-frame on a running TUI is a repaint
  // the user did not ask for.
  if (
    next.fontFamily === current.fontFamily &&
    next.fontSize === current.fontSize &&
    next.cursorStyle === current.cursorStyle &&
    next.cursorBlink === current.cursorBlink &&
    next.scrollback === current.scrollback
  ) {
    return
  }
  current = next
  for (const listener of listeners) listener(next)
}

/**
 * Subscribe a registry. Never unsubscribed: the registries are module
 * singletons that live as long as the window does.
 */
export function onTerminalPrefs(listener: Listener): void {
  listeners.add(listener)
}
