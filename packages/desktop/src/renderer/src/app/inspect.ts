import { describeSessionTerminals } from './terminals'
import { describeShellTerminals } from './pterms'
import { terminalPrefs } from './termprefs'

/**
 * A read-only window onto the terminals, for the real-window checks.
 *
 * Every terminal in Helm lives outside React in a module registry - that is the
 * whole point of `terminals.ts` and `pterms.ts`, since a terminal *is* the
 * state rather than a rendering of it - so a driver holding the window through
 * `executeJavaScript` has no route to them at all. "The font change reached
 * every open terminal" is the settings pane's central claim, and without this
 * it could only be
 * inferred from what got painted.
 *
 * The same deliberate seam as `SessionObserver` in `main/sessions.ts` and the
 * picker stand-ins `--packaging-firstrun` passes: product code carrying the one hook a
 * check needs, rather than the check asserting on something adjacent. Nothing
 * in the app reads it, it exposes no capability the renderer did not already
 * have, and it cannot write.
 *
 * `settings-check --only=terminal` still does not take its word for the things
 * it can measure another way: cell geometry is compared against a canvas
 * measurement the driver makes itself, and the grid each pty is at is read in
 * the main process.
 */
export function installTerminalInspector(): void {
  Object.defineProperty(window, '__helmTerminals', {
    value: () => ({
      prefs: terminalPrefs(),
      sessions: describeSessionTerminals(),
      shells: describeShellTerminals()
    }),
    configurable: true
  })
}
