import type { BrowserWindow, BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron'
import { formatColor, mix, parseColor, type AppliedTheme } from '@helm/core'

/**
 * The window's chrome, one answer per OS.
 *
 * Helm draws its own 36px strip (`TitleBar.tsx`) at the top of the app window,
 * and each OS draws its window controls into it in its own way:
 *
 *  - Windows paints the frame in the OS accent colour, which has nothing to do
 *    with the app's canvas and reads as a bug once everything below it follows
 *    DESIGN.md. The native bar is hidden and the Window Controls Overlay draws
 *    only the min/max/close buttons at the right, coloured here to sit on the
 *    canvas.
 *  - macOS hides the native bar (`hiddenInset`) and draws the traffic lights
 *    at the left, centred in the strip, which leaves that corner clear.
 *  - Linux keeps its native frame: window managers differ too much for a
 *    drawn one to sit right on all of them, and the strip sits below it.
 *
 * The overlay's colours come from the theme - the canvas behind the buttons
 * and `fg-muted` for the glyphs - which is why those two tokens must be opaque
 * in every theme file (`TRANSLUCENT_TOKENS`): Windows takes no alpha here.
 */
export const TITLEBAR_HEIGHT = 36

/**
 * Where macOS draws the traffic lights. Each button's frame is 16px tall, so a
 * top of 10 centres them in the 36px strip; 14 from the left matches the
 * inset every hiddenInset window has. DESIGN.md records the clear area the
 * strip leaves for them.
 */
export const TRAFFIC_LIGHTS = { x: 14, y: (TITLEBAR_HEIGHT - 16) / 2 } as const

/** The app window's title-bar options on the given OS. */
export function windowChromeFor(
  platform: NodeJS.Platform,
  theme: AppliedTheme
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'accentColor' | 'trafficLightPosition'> {
  switch (platform) {
    case 'win32': {
      // The window's edge in the theme's hairline, not the OS accent.
      const edge = windowBorderFor(theme)
      return {
        titleBarStyle: 'hidden',
        titleBarOverlay: titleBarOverlayFor(theme),
        ...(edge === null ? {} : { accentColor: edge })
      }
    }
    case 'darwin':
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS } }
    default:
      return {}
  }
}

/**
 * The application menu, or null for none.
 *
 * Windows and Linux have none, and that is load-bearing: the default menu
 * binds Ctrl+C to Edit > Copy, which swallows the interrupt before xterm ever
 * sees the keydown. A terminal host cannot ship it.
 *
 * macOS needs one. Without a menu a text field there has no Cmd+C, Cmd+V,
 * Cmd+Z or Cmd+A, and the app has no Cmd+Q - those keys are menu items on a
 * Mac, not editing commands in the page. Cmd never collides with the
 * terminal's Ctrl+C. So a Mac gets the app menu and the Edit menu every app
 * has, and a Window menu with Minimize and Zoom, and nothing else: no Close,
 * Reload, Developer Tools or any item whose key one of Helm's own Cmd
 * shortcuts uses (Cmd+W, Cmd+R and Cmd+Option+I are the Browser tab's).
 * Accelerators are written out, though the roles carry the same ones, so the
 * keys the menu takes can be read here and checked against Helm's.
 *
 * Quit Helm is not Electron's `quit` role. That role is `app.quit()`, and
 * Electron runs `before-quit` - which ends every session - before it closes
 * the window, so the question closing the window asks would come after the
 * sessions were gone. The item calls `quit` instead, which asks that question
 * first while sessions run and quits on a yes (quit.ts).
 */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  quit: () => void
): MenuItemConstructorOptions[] | null {
  if (platform !== 'darwin') return null
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide', accelerator: 'Command+H' },
        { role: 'hideOthers', accelerator: 'Command+Alt+H' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: `Quit ${appName}`, accelerator: 'Command+Q', click: () => quit() }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', accelerator: 'Command+Z' },
        { role: 'redo', accelerator: 'Shift+Command+Z' },
        { type: 'separator' },
        { role: 'cut', accelerator: 'Command+X' },
        { role: 'copy', accelerator: 'Command+C' },
        { role: 'paste', accelerator: 'Command+V' },
        { role: 'selectAll', accelerator: 'Command+A' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize', accelerator: 'Command+M' }, { role: 'zoom' }]
    }
  ]
}

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
