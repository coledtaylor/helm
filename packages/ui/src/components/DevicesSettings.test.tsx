import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DevicesSettings, type DevicesSettingsProps, type SettingsDevicesHost } from './DevicesSettings'

const ME = {
  name: 'this laptop',
  role: 'admin' as const,
  pairedAt: '2026-11-01T09:00:00Z',
  revokedAt: null,
  fingerprint: 'bbbb2222'
}
const PHONE = {
  ...ME,
  name: 'phone',
  role: 'viewer' as const,
  fingerprint: 'aaaa1111'
}
const OLD = {
  ...ME,
  name: 'old tablet',
  role: 'operator' as const,
  fingerprint: 'dddd4444',
  revokedAt: '2026-11-02T15:30:00Z'
}

const THIS_PC: SettingsDevicesHost = {
  id: 'local',
  name: 'This PC',
  thisDevice: ME.fingerprint,
  paired: [ME, PHONE, OLD],
  waiting: [{ name: 'tablet', fingerprint: 'cccc3333', secondsLeft: 540 }],
  error: null
}
const BUILD: SettingsDevicesHost = {
  id: 'h-build',
  name: 'build-box',
  thisDevice: 'eeee5555',
  paired: [{ ...ME, fingerprint: 'eeee5555' }],
  waiting: [],
  error: null
}

function renderDevices(overrides: Partial<DevicesSettingsProps> = {}) {
  const props: DevicesSettingsProps = {
    hosts: [THIS_PC, BUILD],
    onApprove: vi.fn(() => Promise.resolve(null)),
    onRevoke: vi.fn(() => Promise.resolve(null)),
    ...overrides
  }
  render(<DevicesSettings {...props} />)
  return props
}

describe('Settings > Devices', () => {
  it('S7: lists each admin host, This PC first, with its paired devices and waiting requests under its name', () => {
    renderDevices()
    const hosts = [...document.querySelectorAll<HTMLElement>('[data-settings-devices-host]')]
    expect(hosts.map((host) => host.getAttribute('aria-label'))).toEqual(['This PC', 'build-box'])
    const pc = within(hosts[0]!)
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    expect(phone.textContent).toContain('phone')
    expect(phone.textContent).toContain('Viewer')
    expect(phone.querySelector('[data-settings-device-paired-at]')?.textContent).toMatch(/^Paired .*2026/)
    expect(pc.getByText('tablet')).toBeTruthy()
    expect(pc.getByText('9 min left')).toBeTruthy()
  })

  it('S7: marks this device, and its own row has no Revoke', () => {
    renderDevices()
    const mine = document.querySelector(`[data-settings-device="${ME.fingerprint}"]`) as HTMLElement
    expect(mine.textContent).toContain('This device')
    expect(within(mine).queryByRole('button', { name: 'Revoke' })).toBeNull()
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    expect(within(phone).getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })

  it('S7: approves a code with a role, Operator unless another is picked, and says a code nobody waits under', async () => {
    const onApprove = vi.fn((_host: string, code: string) =>
      Promise.resolve(code === 'NOPE' ? 'No device is waiting to pair with that code.' : null)
    )
    renderDevices({ onApprove })
    const form = screen.getByRole('form', {
      name: 'Approve a device on This PC'
    })
    const roles = within(form).getByRole('radiogroup', {
      name: 'Role on This PC'
    })
    expect(within(roles).getByRole('radio', { name: 'Operator' }).getAttribute('aria-checked')).toBe('true')
    await userEvent.type(within(form).getByRole('textbox'), 'K7Q-2MX')
    await userEvent.click(within(form).getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenLastCalledWith('local', 'K7Q-2MX', 'operator')
    expect(within(form).queryByRole('alert')).toBeNull()

    await userEvent.click(within(roles).getByRole('radio', { name: 'Admin' }))
    await userEvent.type(within(form).getByRole('textbox'), 'NOPE')
    await userEvent.click(within(form).getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenLastCalledWith('local', 'NOPE', 'admin')
    expect((await within(form).findByRole('alert')).textContent).toBe('No device is waiting to pair with that code.')
  })

  it('S16: Revoke asks first, naming the device and the host, and lists a revoked device with when', async () => {
    const props = renderDevices()
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    await userEvent.click(within(phone).getByRole('button', { name: 'Revoke' }))
    expect(props.onRevoke).not.toHaveBeenCalled()
    const ask = within(phone).getByRole('alertdialog', {
      name: 'Revoke phone'
    })
    expect(ask.textContent).toContain('Revoke phone on This PC?')
    await userEvent.click(within(ask).getByRole('button', { name: 'Revoke' }))
    expect(props.onRevoke).toHaveBeenCalledWith('local', PHONE)

    const old = document.querySelector(`[data-settings-device="${OLD.fingerprint}"]`) as HTMLElement
    expect(old.getAttribute('data-settings-device-revoked')).toBe('true')
    expect(old.querySelector('[data-settings-device-revoked-at]')?.textContent).toMatch(/^Revoked .*2026/)
    expect(within(old).queryByRole('button', { name: 'Revoke' })).toBeNull()
  })

  it('S13: says why a revoke did not happen, such as a presence check that was cancelled', async () => {
    renderDevices({
      onRevoke: () => Promise.resolve('You did not confirm it was you on this computer, so nothing changed.')
    })
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    await userEvent.click(within(phone).getByRole('button', { name: 'Revoke' }))
    await userEvent.click(
      within(phone).getByRole('alertdialog').querySelector('[data-settings-device-confirm-revoke]')!
    )
    expect((await within(phone).findByRole('alert')).textContent).toContain('nothing changed')
  })

  it('says why a host’s devices could not be listed', () => {
    renderDevices({
      hosts: [{ ...BUILD, paired: [], error: 'Only an admin may list devices.' }]
    })
    expect(screen.getByText('Only an admin may list devices.')).toBeTruthy()
  })
})
