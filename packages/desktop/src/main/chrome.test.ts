import type { KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { resolveTheme } from '@helm/core'
import { browserKeyCommand } from '../shared/browserKeys'
import { applicationMenuTemplate, TITLEBAR_HEIGHT, TRAFFIC_LIGHTS, windowChromeFor } from './chrome'

const theme = resolveTheme(
  { preference: 'dark', systemDark: true, themeDark: 'nocturne', themeLight: 'daylight', accentColor: null } as Parameters<
    typeof resolveTheme
  >[0],
  []
)

/** Every item of a template, submenus flattened. */
function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((entry) =>
    Array.isArray(entry.submenu) ? [entry, ...items(entry.submenu as MenuItemConstructorOptions[])] : [entry]
  )
}

/**
 * Helm's own Cmd shortcuts on macOS, outside the Browser tab's table: the
 * launcher, quick open on names and text, the plugins' palette, the split, and
 * moving a tab or a profile.
 */
const HELM_SHORTCUTS = ['Command+N', 'Command+P', 'Shift+Command+P', 'Shift+Command+F', 'Command+\\', 'Command+Enter']

/** An accelerator as the key press it is, for the Browser tab's table. */
function pressOf(accelerator: string): { key: string; control: boolean; shift: boolean; alt: boolean; meta: boolean } {
  const parts = accelerator.split('+')
  const key = parts.at(-1)!
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    control: parts.includes('Control'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    meta: parts.includes('Command')
  }
}

const noQuit = (): void => undefined

/** The app menu's Quit Helm item. */
function quitItem(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions {
  const found = items(template).find((item) => item.label === 'Quit Helm')
  if (found === undefined) throw new Error('no Quit Helm item')
  return found
}

describe('applicationMenuTemplate', () => {
  it('is none on Windows and Linux, so Ctrl+C reaches the terminal', () => {
    expect(applicationMenuTemplate('win32', 'Helm', noQuit)).toBeNull()
    expect(applicationMenuTemplate('linux', 'Helm', noQuit)).toBeNull()
  })

  it('on macOS is the app menu, the Edit menu and a Window menu with Minimize and Zoom', () => {
    const template = applicationMenuTemplate('darwin', 'Helm', noQuit)!
    expect(template.map((menu) => menu.label)).toEqual(['Helm', 'Edit', 'Window'])
    const entries = (index: number): unknown[] =>
      (template[index]!.submenu as MenuItemConstructorOptions[])
        .filter((item) => item.type !== 'separator')
        .map((item) => item.role ?? item.label)
    expect(entries(0)).toEqual(['about', 'hide', 'hideOthers', 'unhide', 'Quit Helm'])
    expect(entries(1)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
    expect(entries(2)).toEqual(['minimize', 'zoom'])
  })

  it('on macOS gives Cmd+C, Cmd+V, Cmd+Z, Cmd+A and Cmd+Q to the menu', () => {
    const template = applicationMenuTemplate('darwin', 'Helm', noQuit)!
    const byRole = new Map(items(template).map((item) => [item.role, item.accelerator]))
    expect(byRole.get('copy')).toBe('Command+C')
    expect(byRole.get('paste')).toBe('Command+V')
    expect(byRole.get('undo')).toBe('Command+Z')
    expect(byRole.get('selectAll')).toBe('Command+A')
    expect(quitItem(template).accelerator).toBe('Command+Q')
  })

  it('on macOS, Cmd+Q and Quit Helm go through the quit handler, which asks first, never straight to app.quit()', () => {
    const quit = vi.fn()
    const item = quitItem(applicationMenuTemplate('darwin', 'Helm', quit)!)
    // The `quit` role is app.quit(), whose `before-quit` ends every session
    // before the window could ask.
    expect(item.role).toBeUndefined()

    item.click?.({} as MenuItem, undefined, {} as KeyboardEvent)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('on macOS has no Close, Reload or Developer Tools, and takes no key one of Helm’s own shortcuts uses', () => {
    const all = items(applicationMenuTemplate('darwin', 'Helm', noQuit)!)
    const roles = all.map((item) => String(item.role ?? ''))
    for (const role of ['close', 'reload', 'forceReload', 'toggleDevTools', 'togglefullscreen', 'resetZoom', 'zoomIn', 'zoomOut']) {
      expect(roles).not.toContain(role)
    }
    // A role whose default key nobody wrote down here would slip past the check.
    const keyed = all.filter((item) => item.role !== undefined && !['about', 'unhide', 'zoom'].includes(String(item.role)))
    for (const item of keyed) expect(item.accelerator, String(item.role)).toBeDefined()

    const accelerators = all.flatMap((item) => (typeof item.accelerator === 'string' ? [item.accelerator] : []))
    for (const accelerator of accelerators) {
      expect(HELM_SHORTCUTS, accelerator).not.toContain(accelerator)
      expect(browserKeyCommand(pressOf(accelerator), 'darwin'), accelerator).toBeNull()
    }
  })
})

describe('windowChromeFor', () => {
  it('on macOS hides the native bar and centres the traffic lights in the strip at its left', () => {
    const options = windowChromeFor('darwin', theme)
    expect(options.titleBarStyle).toBe('hiddenInset')
    expect(options.titleBarOverlay).toBeUndefined()
    expect(options.trafficLightPosition).toEqual(TRAFFIC_LIGHTS)
    // A 16px button frame, centred in the 36px strip.
    expect(TRAFFIC_LIGHTS.y * 2 + 16).toBe(TITLEBAR_HEIGHT)
  })

  it('on Windows keeps the window controls overlay, coloured to the theme, at the strip’s height', () => {
    const options = windowChromeFor('win32', theme)
    expect(options.titleBarStyle).toBe('hidden')
    expect(options.titleBarOverlay).toEqual({
      color: theme.tokens.bg,
      symbolColor: theme.tokens['fg-muted'],
      height: TITLEBAR_HEIGHT
    })
    expect(options.accentColor).toEqual(expect.any(String))
    expect(options.trafficLightPosition).toBeUndefined()
  })

  it('on Linux keeps the native frame', () => {
    expect(windowChromeFor('linux', theme)).toEqual({})
  })
})
