import { beforeEach, describe, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => ({
  notifications: [] as Array<{ options: { title: string; body: string }; click: () => void }>,
  emitted: [] as Array<{ channel: string; payload: unknown }>,
  supported: true
}))

vi.mock('electron', async () => ({
  ...(await import('../../../test/electron')).electronFake(),
  Notification: class {
    static isSupported(): boolean {
      return shown.supported
    }
    private click: () => void = () => undefined
    constructor(private readonly options: { title: string; body: string }) {}
    on(event: string, listener: () => void): void {
      if (event === 'click') this.click = listener
    }
    show(): void {
      shown.notifications.push({ options: this.options, click: this.click })
    }
  }
}))

vi.mock('../ipc', () => ({
  emit: (_window: unknown, channel: string, payload: unknown) => {
    shown.emitted.push({ channel, payload })
  }
}))

import type { BrowserWindow } from 'electron'
import { showNeedsYouNotification } from './confirm'

function fakeWindow() {
  const calls: string[] = []
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus')
  } as unknown as BrowserWindow
  return { window, calls }
}

describe('the OS notification for a child that needs a person', () => {
  beforeEach(() => {
    shown.notifications.length = 0
    shown.emitted.length = 0
    shown.supported = true
  })

  it('S12: shows what the window worded, and a click brings the window forward and names the child to show on its host', () => {
    const { window, calls } = fakeWindow()
    const note = { host: 'this-pc', id: 13, title: 'reviewer needs you', body: 'permission prompt, started by lead' }
    expect(showNeedsYouNotification(() => window, note)).toBe(true)
    expect(shown.notifications.map((each) => each.options)).toEqual([
      { title: 'reviewer needs you', body: 'permission prompt, started by lead' }
    ])
    expect(shown.emitted).toEqual([])

    shown.notifications[0]?.click()
    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(shown.emitted).toEqual([{ channel: 'windowSessions:showChild', payload: { host: 'this-pc', id: 13 } }])
  })

  it('shows nothing where the OS has no notifications, and a click with no window left tells nobody', () => {
    shown.supported = false
    expect(showNeedsYouNotification(() => null, { host: 'h', id: 1, title: 't', body: 'b' })).toBe(false)
    expect(shown.notifications).toEqual([])

    shown.supported = true
    showNeedsYouNotification(() => null, { host: 'h', id: 1, title: 't', body: 'b' })
    shown.notifications[0]?.click()
    expect(shown.emitted).toEqual([])
  })
})
