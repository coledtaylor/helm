import type { BrowserWindow } from 'electron'

/**
 * The native title bar, recolored to the design system.
 *
 * Windows paints the frame in the OS accent colour, which has nothing to do
 * with the app's canvas and reads as a bug once everything below it follows
 * DESIGN.md. The app window therefore hides the native bar and uses the
 * Window Controls Overlay: Helm draws its own brand strip (a drag region in
 * the renderer), and Windows draws only the min/max/close buttons, coloured
 * here to sit on the canvas.
 *
 * The values are the canvas and fg-muted tokens from theme.css - if those
 * move, these move. Height matches the renderer's h-9 brand strip.
 */
export const TITLEBAR_OVERLAY = {
  dark: { color: '#12131f', symbolColor: '#9397ab', height: 36 },
  light: { color: '#eceef4', symbolColor: '#595d6c', height: 36 }
} as const

export function applyTitleBarOverlay(
  win: BrowserWindow | null,
  resolved: 'dark' | 'light'
): void {
  if (process.platform !== 'win32' || win === null || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay(TITLEBAR_OVERLAY[resolved])
  } catch {
    // The window was created without an overlay (a spike page); nothing to do.
  }
}
