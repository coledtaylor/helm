import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceAttachedNotice } from '../shared/ipc'
import { deviceNoticeText, showDeviceNotification } from './notifications'

/** Each notification shown, with what clicking it does. */
const shown = vi.hoisted(() => [] as { title: string; body: string; click: () => void }[])
const support = vi.hoisted(() => ({ supported: true }))

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  class Notification {
    static isSupported(): boolean {
      return support.supported
    }
    private click: () => void = () => undefined
    constructor(private readonly options: { title: string; body: string }) {}
    on(event: string, listener: () => void): void {
      if (event === 'click') this.click = listener
    }
    show(): void {
      shown.push({ ...this.options, click: () => this.click() })
    }
  }
  return { ...fake, Notification }
})


const NOTICE: DeviceAttachedNotice = {
  host: 'h-build',
  hostName: 'build-box',
  hostOnThisComputer: false,
  device: 'phone',
  role: 'operator',
  away: true
}

/** A window that records how it was brought forward and what it was sent. */
function fakeWindow(minimized = true) {
  const did: string[] = []
  const sent: { channel: string; payload: unknown }[] = []
  const win = {
    isDestroyed: () => false,
    isMinimized: () => minimized,
    restore: () => did.push('restore'),
    show: () => did.push('show'),
    focus: () => did.push('focus'),
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
  }
  return { win: win as unknown as BrowserWindow, did, sent }
}

describe('a device’s connection notification', () => {
  beforeEach(() => {
    shown.length = 0
    support.supported = true
  })

  it('S5: names the device, its role, the host and that it came from another computer', () => {
    const { win } = fakeWindow()
    expect(showDeviceNotification(() => win, NOTICE)).toBe(true)
    expect(shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: 'phone attached to build-box', body: 'Operator, from another computer' }
    ])
  })

  it('S5: says where a device on the host’s own computer is', () => {
    expect(deviceNoticeText({ ...NOTICE, away: false }).body).toBe('Operator, on the host’s own computer')
    expect(
      deviceNoticeText({ ...NOTICE, host: 'local', hostName: 'This PC', hostOnThisComputer: true, away: false, role: 'viewer' })
    ).toEqual({ title: 'phone attached to This PC', body: 'Viewer, on this computer' })
  })

  it('S5: clicking it brings the window forward on Settings > Devices', () => {
    const { win, did, sent } = fakeWindow()
    showDeviceNotification(() => win, NOTICE)
    shown[0]!.click()
    expect(did).toEqual(['restore', 'show', 'focus'])
    expect(sent).toEqual([{ channel: 'notification:openDevices', payload: { host: 'h-build' } }])
  })

  it('S5: shows nothing where the OS has no notifications', () => {
    support.supported = false
    const { win } = fakeWindow()
    expect(showDeviceNotification(() => win, NOTICE)).toBe(false)
    expect(shown).toEqual([])
  })
})
