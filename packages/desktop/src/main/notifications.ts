import { Notification, type BrowserWindow } from 'electron'
import type { DeviceAttachedNotice } from '../shared/ipc'
import { emit } from './ipc'

/**
 * The OS notification for another device attaching to a host the window is
 * connected to (`notification:deviceAttached`). It names the device, its
 * role, the host and whether it came from another computer; clicking it
 * brings the window forward on Settings > Devices
 * (`notification:openDevices`).
 *
 * The device's name is the one free text, and the OS draws it as text.
 */

const ROLE: Record<DeviceAttachedNotice['role'], string> = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' }

/** What the notification says. */
export function deviceNoticeText(notice: DeviceAttachedNotice): { title: string; body: string } {
  const where = notice.away
    ? 'from another computer'
    : notice.hostOnThisComputer
      ? 'on this computer'
      : 'on the host’s own computer'
  return {
    title: `${notice.device} attached to ${notice.hostName}`,
    body: `${ROLE[notice.role]}, ${where}`
  }
}

/** Shows `notice`; false when this OS shows none. */
export function showDeviceNotification(window: () => BrowserWindow | null, notice: DeviceAttachedNotice): boolean {
  if (!Notification.isSupported()) return false
  const notification = new Notification(deviceNoticeText(notice))
  notification.on('click', () => {
    const target = window()
    if (!target || target.isDestroyed()) return
    if (target.isMinimized()) target.restore()
    target.show()
    target.focus()
    emit(target, 'notification:openDevices', { host: notice.host })
  })
  notification.show()
  return true
}
