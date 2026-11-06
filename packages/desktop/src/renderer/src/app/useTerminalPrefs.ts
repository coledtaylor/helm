import { useSyncExternalStore } from 'react'
import type { TerminalPrefs } from '../terminal'
import { onTerminalPrefs, terminalPrefs } from './termprefs'

/**
 * The terminal preferences in force, re-read when a setting changes them.
 * What a component needs them for is arithmetic on the terminal's cell (the
 * family view's room rule), which a font or scrollback change moves.
 */
export function useTerminalPrefs(): TerminalPrefs {
  return useSyncExternalStore((onChange) => onTerminalPrefs(() => onChange()), terminalPrefs)
}
