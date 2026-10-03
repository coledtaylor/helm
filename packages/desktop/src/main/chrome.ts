import type { BrowserWindow } from 'electron'
import { formatColor, mix, parseColor, type AppliedTheme } from '@helm/core'

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
 * The window's 1px edge. Windows 11 draws it in the user's accent colour when
 * "Show accent colour on title bars and window borders" is on - a line in a
 * colour from no theme, all the way round the app. It is the theme's hairline
 * instead, as the hairline lands on the canvas: `border` is translucent and
 * Windows takes no alpha, so it is composited over `bg` here. Null, which
 * hands the edge back to the system, only for a colour that does not parse -
 * and a loaded theme's always do.
 */
export function windowBorderFor(theme: AppliedTheme): string | null {
  const bg = parseColor(theme.tokens.bg)
  const border = parseColor(theme.tokens.border)
  if (bg === null || border === null) return null
  return formatColor(mix(bg, border, border.a))
}

/**
 * Repaints the native parts of the window for a theme: the overlay buttons,
 * the window's edge, and the background Chromium shows before the renderer's
 * first frame and behind anything it has not painted yet. None of them
 * follows the renderer's CSS.
 */
export function applyWindowTheme(win: BrowserWindow | null, theme: AppliedTheme): void {
  if (win === null || win.isDestroyed()) return
  win.setBackgroundColor(theme.tokens.bg)
  if (process.platform !== 'win32') return
  win.setAccentColor(windowBorderFor(theme))
  try {
    win.setTitleBarOverlay(titleBarOverlayFor(theme))
  } catch {
    // The window was created without an overlay (a spike page); nothing to do.
  }
}
