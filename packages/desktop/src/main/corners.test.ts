import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Small window corners through DWM. The module keeps what it loaded, so each
 * test takes a fresh copy of it.
 */

const windows = process.platform === 'win32'

function fakeWindow(hwnd: bigint, destroyed = false): BrowserWindow {
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(hwnd)
  return { isDestroyed: () => destroyed, getNativeWindowHandle: () => handle } as unknown as BrowserWindow
}

afterEach(() => {
  vi.doUnmock('koffi')
  vi.resetModules()
})

describe.runIf(windows)('requestSmallCorners', () => {
  it('asks DWM for the small corner preference on the window’s own handle', async () => {
    const set = vi.fn(() => 0)
    const load = vi.fn(() => ({ func: () => set }))
    vi.doMock('koffi', () => ({ default: { load } }))
    const { requestSmallCorners } = await import('./corners')

    await expect(requestSmallCorners(fakeWindow(0x1234n))).resolves.toBe(true)
    expect(load).toHaveBeenCalledWith('dwmapi.dll')
    // DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUNDSMALL, a DWORD's size.
    expect(set).toHaveBeenCalledWith(0x1234n, 33, [3], 4)

    // Loaded once, however many windows ask.
    await requestSmallCorners(fakeWindow(0x5678n))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('answers false, and keeps the window, for every way it can fail', async () => {
    const set = vi.fn(() => 0x80070057)
    vi.doMock('koffi', () => ({ default: { load: () => ({ func: () => set }) } }))
    const { requestSmallCorners } = await import('./corners')
    await expect(requestSmallCorners(fakeWindow(1n))).resolves.toBe(false)
    await expect(requestSmallCorners(fakeWindow(1n, true))).resolves.toBe(false)
    expect(set).toHaveBeenCalledTimes(1)

    vi.resetModules()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const load = vi.fn(() => {
      throw new Error('no such module')
    })
    vi.doMock('koffi', () => ({ default: { load } }))
    const fresh = await import('./corners')
    await expect(fresh.requestSmallCorners(fakeWindow(1n))).resolves.toBe(false)
    await expect(fresh.requestSmallCorners(fakeWindow(1n))).resolves.toBe(false)
    // A binding that could not be made is not tried again.
    expect(load).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('binds the real DwmSetWindowAttribute: a window that does not exist is refused, not crashed', async () => {
    const { requestSmallCorners } = await import('./corners')
    await expect(requestSmallCorners(fakeWindow(0n))).resolves.toBe(false)
  })
})
