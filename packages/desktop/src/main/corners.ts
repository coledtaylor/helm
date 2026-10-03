import type { BrowserWindow } from 'electron'

/**
 * Windows 11's small window corners - 4px rather than its default 8px - so
 * the window's own corner is the radius DESIGN.md gives popups and inputs,
 * rather than a rounder one than anything inside it.
 *
 * Electron offers rounded or square (`roundedCorners`) and nothing between.
 * DWM's `DWMWA_WINDOW_CORNER_PREFERENCE` has the third value, so it is asked
 * for directly, through koffi. It is cosmetic, and nothing here may cost the
 * app its window: koffi is loaded on first use rather than at start, every
 * failure is an answer of false, and before Windows 11 the attribute is one
 * DWM does not know - it rounds nothing there anyway.
 */

const DWMWA_WINDOW_CORNER_PREFERENCE = 33
const DWMWCP_ROUNDSMALL = 3
const S_OK = 0

type SetWindowAttribute = (hwnd: bigint, attribute: number, value: number[], size: number) => number

/** Undefined until first asked for; null once it could not be loaded, so that is not tried again. */
let setWindowAttribute: SetWindowAttribute | null | undefined

async function dwmSetWindowAttribute(): Promise<SetWindowAttribute | null> {
  if (setWindowAttribute !== undefined) return setWindowAttribute
  try {
    const { default: koffi } = await import('koffi')
    const dwmapi = koffi.load('dwmapi.dll')
    setWindowAttribute = dwmapi.func(
      'long __stdcall DwmSetWindowAttribute(intptr_t hwnd, uint32_t attribute, _In_ uint32_t *value, uint32_t size)'
    ) as SetWindowAttribute
  } catch (err) {
    console.warn('[helm] window corners: dwmapi could not be loaded, keeping the default', err)
    setWindowAttribute = null
  }
  return setWindowAttribute
}

/** The window's HWND, out of the buffer Electron hands it over in. */
function hwndOf(win: BrowserWindow): bigint {
  const handle = win.getNativeWindowHandle()
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
}

/** Asks DWM for small corners on `win`. True when DWM said yes. */
export async function requestSmallCorners(win: BrowserWindow): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const set = await dwmSetWindowAttribute()
  if (set === null || win.isDestroyed()) return false
  try {
    return set(hwndOf(win), DWMWA_WINDOW_CORNER_PREFERENCE, [DWMWCP_ROUNDSMALL], 4) === S_OK
  } catch {
    return false
  }
}
