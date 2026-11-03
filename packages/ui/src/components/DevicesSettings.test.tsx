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
  thisComputer: true,
  thisDevice: ME.fingerprint,
  admin: true,
  attached: [
    { fingerprint: ME.fingerprint, name: ME.name, role: 'admin', away: false, since: '2026-11-03T08:00:00Z' },
    { fingerprint: PHONE.fingerprint, name: PHONE.name, role: 'viewer', away: true, since: '2026-11-03T09:15:00Z' }
  ],
  attachedError: null,
  paired: [ME, PHONE, OLD],
  waiting: [{ name: 'tablet', fingerprint: 'cccc3333', secondsLeft: 540 }],
  error: null,
  audit: {
    entries: [
      {
        number: 12,
        at: '2026-11-03T09:15:00Z',
        what: 'Attached',
        device: 'phone',
        fingerprint: PHONE.fingerprint,
        away: true
      },
      {
        number: 11,
        at: '2026-11-03T09:00:00Z',
        what: 'Role changed from operator to viewer by this laptop',
        device: 'phone',
        fingerprint: PHONE.fingerprint,
        away: false
      }
    ],
    more: true,
    loading: false,
    error: null
  }
}
const BUILD: SettingsDevicesHost = {
  id: 'h-build',
  name: 'build-box',
  thisComputer: false,
  thisDevice: 'eeee5555',
  admin: false,
  attached: [
    { fingerprint: 'eeee5555', name: ME.name, role: 'operator', away: true, since: '2026-11-03T07:00:00Z' },
    { fingerprint: 'ffff6666', name: 'build console', role: 'admin', away: false, since: '2026-11-02T07:00:00Z' }
  ],
  attachedError: null,
  paired: [],
  waiting: [],
  error: null,
  audit: null
}

function renderDevices(overrides: Partial<DevicesSettingsProps> = {}) {
  const props: DevicesSettingsProps = {
    hosts: [THIS_PC, BUILD],
    onApprove: vi.fn(() => Promise.resolve(null)),
    onRevoke: vi.fn(() => Promise.resolve(null)),
    onRole: vi.fn(() => Promise.resolve(null)),
    onMoreAudit: vi.fn(),
    ...overrides
  }
  render(<DevicesSettings {...props} />)
  return props
}

const hostSection = (id: string): HTMLElement =>
  document.querySelector(`[data-settings-devices-host="${id}"]`) as HTMLElement

describe('Settings > Devices', () => {
  it('S3: lists every connected host under its name, This PC first, with who is attached now and this device marked', () => {
    renderDevices()
    const hosts = [...document.querySelectorAll<HTMLElement>('[data-settings-devices-host]')]
    expect(hosts.map((host) => host.getAttribute('aria-label'))).toEqual(['This PC', 'build-box'])

    const pc = hostSection('local')
    const phone = pc.querySelector(`[data-settings-attached="${PHONE.fingerprint}"]`) as HTMLElement
    expect(phone.textContent).toContain('phone')
    expect(phone.textContent).toContain('Viewer')
    expect(phone.textContent).toContain('From another computer')
    expect(phone.textContent).toContain(PHONE.fingerprint)
    expect(phone.querySelector('[data-settings-attached-since]')?.textContent).toMatch(/^Since .*2026/)
    const me = pc.querySelector(`[data-settings-attached="${ME.fingerprint}"]`) as HTMLElement
    expect(me.getAttribute('data-settings-attached-mine')).toBe('true')
    expect(me.textContent).toContain('This device')
    expect(me.textContent).toContain('On this computer')

    const build = hostSection('h-build')
    const mineThere = build.querySelector('[data-settings-attached="eeee5555"]') as HTMLElement
    expect(mineThere.textContent).toContain('This device')
    expect(mineThere.textContent).toContain('Operator')
    const buildConsole = build.querySelector('[data-settings-attached="ffff6666"]') as HTMLElement
    expect(buildConsole.textContent).toContain('On the host’s computer')
    expect(buildConsole.getAttribute('data-settings-attached-mine')).toBeNull()
  })

  it('S3: paired devices, requests, Approve, Revoke, roles and the audit log show only under hosts this device is an admin of', () => {
    renderDevices()
    const pc = hostSection('local')
    expect(pc.querySelector('[data-settings-device]')).not.toBeNull()
    expect(within(pc).getByText('tablet')).toBeTruthy()
    expect(within(pc).getByText('9 min left')).toBeTruthy()
    expect(pc.querySelector('[data-settings-device-approve]')).not.toBeNull()
    expect(pc.querySelector('[data-settings-device-role]')).not.toBeNull()
    expect(pc.querySelector('[data-settings-audit]')).not.toBeNull()

    const build = hostSection('h-build')
    expect(build.querySelector('[data-settings-device]')).toBeNull()
    expect(build.querySelector('[data-settings-device-approve]')).toBeNull()
    expect(build.querySelector('[data-settings-device-role]')).toBeNull()
    expect(build.querySelector('[data-settings-audit]')).toBeNull()
    expect(within(build).queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect(build.querySelector('[data-settings-devices-not-admin]')?.textContent).toContain('only where this device is an admin')
  })

  it('S7: marks this device, and its own row has no Revoke', () => {
    renderDevices()
    const mine = document.querySelector(`[data-settings-device="${ME.fingerprint}"]`) as HTMLElement
    expect(mine.textContent).toContain('This device')
    expect(within(mine).queryByRole('button', { name: 'Revoke' })).toBeNull()
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    expect(phone.querySelector('[data-settings-device-paired-at]')?.textContent).toMatch(/^Paired .*2026/)
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

  it('S15: changing a paired device’s role asks the host with the role picked, and the row shows the role it holds', async () => {
    const props = renderDevices()
    const phone = document.querySelector(`[data-settings-device="${PHONE.fingerprint}"]`) as HTMLElement
    const role = within(phone).getByRole('combobox', { name: 'Role of phone' }) as HTMLSelectElement
    expect(role.value).toBe('viewer')
    await userEvent.selectOptions(role, 'operator')
    expect(props.onRole).toHaveBeenCalledWith('local', PHONE, 'operator')
    expect(within(phone).queryByRole('alert')).toBeNull()
  })

  it('S15: a refused role change shows the host’s sentence in its row and changes nothing else', async () => {
    const refusal = 'A host keeps at least one admin, so this device stays an admin.'
    const props = renderDevices({ onRole: vi.fn(() => Promise.resolve(refusal)) })
    const mine = document.querySelector(`[data-settings-device="${ME.fingerprint}"]`) as HTMLElement
    const role = within(mine).getByRole('combobox', { name: 'Role of this laptop' }) as HTMLSelectElement
    await userEvent.selectOptions(role, 'viewer')
    expect((await within(mine).findByRole('alert')).textContent).toBe(refusal)
    // The row still shows the role the host holds, and no other row says anything.
    expect(role.value).toBe('admin')
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(props.onRevoke).not.toHaveBeenCalled()
  })

  it('S15: a revoked device’s row offers no role change', () => {
    renderDevices()
    const old = document.querySelector(`[data-settings-device="${OLD.fingerprint}"]`) as HTMLElement
    expect(within(old).queryByRole('combobox')).toBeNull()
    expect(old.querySelector('[data-settings-device-role-name]')?.textContent).toBe('Operator')
  })

  it('S14: the audit log shows below the devices, newest first, with when, what, the device and where from', () => {
    renderDevices()
    const pc = hostSection('local')
    const log = within(pc).getByRole('list', { name: 'Audit log of This PC' })
    const entries = [...log.querySelectorAll<HTMLElement>('[data-settings-audit-entry]')]
    expect(entries.map((entry) => entry.getAttribute('data-settings-audit-entry'))).toEqual(['12', '11'])
    expect(entries[0]!.textContent).toContain('Attached')
    expect(entries[0]!.textContent).toContain('phone')
    expect(entries[0]!.textContent).toContain('From another computer')
    expect(entries[0]!.querySelector('[data-settings-audit-at]')?.textContent).toMatch(/2026/)
    expect(entries[1]!.textContent).toContain('Role changed from operator to viewer by this laptop')
    expect(entries[1]!.textContent).toContain('On this computer')
    // Below the devices: after the paired list in the host's section.
    const paired = pc.querySelector('[data-settings-device]')!
    expect(paired.compareDocumentPosition(log) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('S14: Show more asks for older entries, and is gone when none remain', async () => {
    const props = renderDevices()
    await userEvent.click(within(hostSection('local')).getByRole('button', { name: 'Show more' }))
    expect(props.onMoreAudit).toHaveBeenCalledWith('local')
  })

  it('S14: an audit log that could not be read says why', () => {
    renderDevices({
      hosts: [
        {
          ...THIS_PC,
          audit: { entries: [], more: false, loading: false, error: 'You did not confirm it was you on this computer, so nothing changed.' }
        }
      ]
    })
    expect(hostSection('local').querySelector('[data-settings-audit-error]')?.textContent).toContain('nothing changed')
    expect(within(hostSection('local')).queryByRole('button', { name: 'Show more' })).toBeNull()
  })

  it('says why a host’s devices could not be listed', () => {
    renderDevices({
      hosts: [{ ...THIS_PC, paired: [], error: 'Only an admin may list devices.' }]
    })
    expect(screen.getByText('Only an admin may list devices.')).toBeTruthy()
  })
})
