import type { BrowserWindow } from 'electron'
import type { AppliedTheme } from '@helm/core'

/**
 * The native title bar, recolored to the theme on screen.
 *
 * Windows paints the frame in the OS accent colour, which has nothing to do
 * with the app's canvas and reads as a bug once everything below it follows
 * DESIGN.md. The app window therefore hides the native bar and uses the
 * Window Controls Overlay: Helm draws its own brand strip (a drag region in
 * the renderer), and Windows draws only the min/max/close buttons, coloured
 * here to sit on the canvas.
 *
 * Both colours come from the theme - the canvas behind the buttons and
 * `fg-muted` for the glyphs - which is why those two tokens must be opaque in
 * every theme file (`TRANSLUCENT_TOKENS`): Windows takes no alpha here.
 * Height matches the renderer's 36px brand strip.
 */
export const TITLEBAR_HEIGHT = 36

export function titleBarOverlayFor(theme: AppliedTheme): {
  color: string
  symbolColor: string
  height: number
} {
  return { color: theme.tokens.bg, symbolColor: theme.tokens['fg-muted'], height: TITLEBAR_HEIGHT }
}

/**
 * Repaints the native parts of the window for a theme: the overlay buttons,
 * and the background Chromium shows before the renderer's first frame and
 * behind anything it has not painted yet. Neither follows the renderer's CSS.
 */
export function applyWindowTheme(win: BrowserWindow | null, theme: AppliedTheme): void {
  if (win === null || win.isDestroyed()) return
  win.setBackgroundColor(theme.tokens.bg)
  if (process.platform !== 'win32') return
  try {
    win.setTitleBarOverlay(titleBarOverlayFor(theme))
  } catch {
    // The window was created without an overlay (a spike page); nothing to do.
  }
}
