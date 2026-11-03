import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DevicesSettings, type DevicesSettingsProps, type SettingsDevicesHost } from './DevicesSettings'

const ME = {
  fingerprint: 'SHA256:me',
  name: 'my-desktop',
  away: false,
  since: '2026-11-03T08:00:00Z'
}
const LAPTOP = {
  fingerprint: 'SHA256:laptop',
  name: 'laptop',
  away: true,
  since: '2026-11-03T09:15:00Z'
}
const BOX_SHELL = {
  fingerprint: 'SHA256:tui',
  name: 'build-box',
  away: false,
  since: '2026-11-03T07:00:00Z'
}

const THIS_PC: SettingsDevicesHost = {
  id: 'local',
  name: 'This PC',
  thisComputer: true,
  thisDevice: ME.fingerprint,
  attached: [ME, LAPTOP],
  error: null
}
const BUILD: SettingsDevicesHost = {
  id: 'h-build',
  name: 'build-box',
  thisComputer: false,
  thisDevice: 'SHA256:me-there',
  attached: [BOX_SHELL, { ...ME, fingerprint: 'SHA256:me-there', away: true }],
  error: null
}

function renderDevices(overrides: Partial<DevicesSettingsProps> = {}) {
  const props: DevicesSettingsProps = {
    hosts: [THIS_PC, BUILD],
    onDisconnect: vi.fn(() => Promise.resolve(null)),
    ...overrides
  }
  const view = render(<DevicesSettings {...props} />)
  return { props, view }
}

const hostSection = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-settings-devices-host="${id}"]`) ?? (null as never)
const row = (host: string, fingerprint: string): HTMLElement | null =>
  hostSection(host).querySelector<HTMLElement>(`[data-settings-attached="${fingerprint}"]`)

describe('Settings > Devices', () => {
  it('S12: lists the devices attached to each connected host under its name, This PC first, with name, fingerprint, where and since when', () => {
    renderDevices()
    const hosts = [...document.querySelectorAll<HTMLElement>('[data-settings-devices-host]')]
    expect(hosts.map((host) => host.getAttribute('aria-label'))).toEqual(['This PC', 'build-box'])

    const laptop = row('local', LAPTOP.fingerprint)!
    expect(within(laptop).getByText('laptop')).toBeTruthy()
    const fingerprint = laptop.querySelector('[data-settings-attached-fingerprint]')!
    expect(fingerprint.textContent).toBe('SHA256:laptop')
    expect(fingerprint.className).toContain('font-mono')
    expect(laptop.querySelector('[data-settings-attached-where]')?.textContent).toBe('From another computer')
    expect(laptop.querySelector('[data-settings-attached-since]')?.textContent).toMatch(/^Since /)

    // On a host on another computer, a device beside it is on the host's computer.
    expect(row('h-build', BOX_SHELL.fingerprint)?.querySelector('[data-settings-attached-where]')?.textContent).toBe(
      'On the host’s computer'
    )
    expect(row('local', ME.fingerprint)?.querySelector('[data-settings-attached-where]')?.textContent).toBe(
      'On this computer'
    )
  })

  it('S12: marks this device’s row on each host and offers it no Disconnect', () => {
    renderDevices()
    for (const [host, mine] of [
      ['local', ME.fingerprint],
      ['h-build', 'SHA256:me-there']
    ] as const) {
      const own = row(host, mine)!
      expect(own.getAttribute('data-settings-attached-mine')).toBe('true')
      expect(within(own).getByText('This device')).toBeTruthy()
      expect(own.querySelector('[data-settings-attached-disconnect]')).toBeNull()
    }
    expect(row('local', LAPTOP.fingerprint)?.querySelector('[data-settings-attached-disconnect]')).not.toBeNull()
  })

  it('S12: lists only the hosts it is given, and says so when none is connected', () => {
    renderDevices({ hosts: [] })
    expect(document.querySelector('[data-settings-devices-host]')).toBeNull()
    expect(document.querySelector('[data-settings-devices-none]')?.textContent).toBe('No host is connected now.')
  })

  it('S13: a device that attaches or leaves appears or goes as the list it is given changes', () => {
    const { props, view } = renderDevices()
    view.rerender(<DevicesSettings {...props} hosts={[{ ...THIS_PC, attached: [ME] }, BUILD]} />)
    expect(row('local', LAPTOP.fingerprint)).toBeNull()
    const phone = {
      fingerprint: 'SHA256:phone',
      name: 'phone',
      away: true,
      since: '2026-11-03T10:00:00Z'
    }
    view.rerender(<DevicesSettings {...props} hosts={[{ ...THIS_PC, attached: [ME, phone] }, BUILD]} />)
    expect(row('local', phone.fingerprint)).not.toBeNull()
  })

  it('S14: Disconnect beside a device asks the host to close its connections there, naming the host and the device', async () => {
    const { props } = renderDevices()
    await userEvent.click(row('local', LAPTOP.fingerprint)!.querySelector('[data-settings-attached-disconnect]')!)
    expect(props.onDisconnect).toHaveBeenCalledWith('local', LAPTOP)
  })

  it('S14: shows what the host said when a Disconnect did not happen, in the row it is about', async () => {
    renderDevices({
      onDisconnect: () => Promise.resolve('build-box is not connected.')
    })
    await userEvent.click(row('h-build', BOX_SHELL.fingerprint)!.querySelector('[data-settings-attached-disconnect]')!)
    await waitFor(() =>
      expect(row('h-build', BOX_SHELL.fingerprint)?.querySelector('[data-settings-attached-error]')?.textContent).toBe(
        'build-box is not connected.'
      )
    )
  })

  it('says why a host’s attached devices cannot be shown, and Looking… until it has said', () => {
    renderDevices({
      hosts: [
        { ...THIS_PC, attached: null },
        { ...BUILD, attached: null, error: 'The host closed the connection.' }
      ]
    })
    expect(within(hostSection('local')).getByText('Looking…')).toBeTruthy()
    expect(hostSection('h-build').querySelector('[data-settings-devices-error]')?.textContent).toBe(
      'The host closed the connection.'
    )
    expect(screen.queryByText(/pair|approve|revoke|role/i)).toBeNull()
  })
})
