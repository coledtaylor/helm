import { overlayOpen } from '@helm/ui'
import type { HelmBridge } from '../../../shared/ipc'
import { describeSessionTerminals } from './terminals'
import { describeShellTerminals } from './pterms'
import { terminalPrefs } from './termprefs'

/**
 * A read-only window onto the terminals, for the end-to-end tests and the
 * diagnostic drivers.
 *
 * Every terminal in Helm lives outside React in a module registry, and xterm
 * paints to a canvas, so a test holding the window has no other route to what a
 * terminal shows or how it is configured. Nothing in the app reads this, it
 * exposes nothing the renderer did not already have, and it cannot write.
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

/**
 * Whether a modal overlay is up, for the same reason and on the same terms.
 *
 * `lib/overlay.ts` is a module-level store rather than React state - it has to
 * be, since the thing that most needs the answer is a native `WebContentsView`
 * that is not in the tree at all - so a driver has no route to it either. And
 * the claim worth checking is exactly the one a screenshot cannot make: not
 * "the dialog is on screen", which the DOM already says, but "the app *knows*
 * it is", which is what the browser pane will hang off.
 *
 * A reader, never a writer. `Overlay` is the only thing that moves this.
 */
export function installOverlayInspector(): void {
  Object.defineProperty(window, '__helmOverlayOpen', {
    value: () => overlayOpen(),
    configurable: true
  })
}

/**
 * The window's routed bridge, for the end-to-end tests: what the app's own
 * hooks call, so a test asks for a host feature the way the window does, over
 * the window's own connection when sessions run in the local host and over
 * Electron IPC otherwise.
 *
 * Only on Helm's own top-level window. It is the same object the app imports
 * and reaches nothing the page did not already have: a plugin page, an
 * artifact frame and a page in the Browser tab are other origins and never see
 * this window's globals.
 */
export function installRoutedBridge(routed: HelmBridge): void {
  if (window.top !== window) return
  Object.defineProperty(window, '__helmRouted', { value: routed, configurable: true })
}
