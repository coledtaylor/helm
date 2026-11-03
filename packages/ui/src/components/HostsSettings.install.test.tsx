import type { HostCheck, InstallOffer, InstallOutcome, RemoteHost } from '@helm/core/types'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { HostsSettings, type HostInstallActions, type HostsSettingsProps, type SettingsHost } from './HostsSettings'

const NOT_FOUND_OFFER: InstallOffer = {
  system: { os: 'linux', cpu: 'x64', label: 'Linux · x86_64' },
  found: null,
  action: 'install',
  how: 'copy',
  version: '2.6.0',
  folder: '~/.local/bin',
  sessions: null
}

function actions(check: HostCheck, outcome: InstallOutcome = { ok: true, floti: '/home/me/.local/bin/floti', startsAtNextSignIn: false }) {
  return {
    check: vi.fn<HostInstallActions['check']>(async () => check),
    install: vi.fn<HostInstallActions['install']>(async () => outcome),
    cancel: vi.fn<HostInstallActions['cancel']>(async () => undefined)
  }
}

function renderHosts(install: HostInstallActions, overrides: Partial<HostsSettingsProps> = {}) {
  const onAdd = vi.fn<(host: RemoteHost) => void>()
  const onInstalled = vi.fn<(id: string, floti: string) => void>()
  function Harness(props: Partial<HostsSettingsProps>): JSX.Element {
    const [adding, setAdding] = useState(props.adding ?? false)
    return (
      <HostsSettings
        hosts={[]}
        onAdd={onAdd}
        onRemove={vi.fn()}
        onQuitChange={vi.fn()}
        install={install}
        onInstalled={onInstalled}
        {...props}
        adding={adding}
        onAddingChange={setAdding}
      />
    )
  }
  const view = render(<Harness {...overrides} />)
  return { onAdd, onInstalled, rerender: (next: Partial<HostsSettingsProps>) => view.rerender(<Harness {...overrides} {...next} />) }
}

async function submitTarget(target: string): Promise<void> {
  const form = screen.getByRole('form', { name: 'Add a host' })
  await userEvent.type(within(form).getByRole('textbox', { name: 'ssh target' }), target)
  await userEvent.click(within(form).getByRole('button', { name: 'Add host' }))
}

const host = (connection: SettingsHost['connection'], floti?: string): SettingsHost => ({
  host: { id: 'h-build', name: 'build-box', transport: { kind: 'ssh', target: 'me@build-box' }, ...(floti ? { floti } : {}) },
  quit: 'keep',
  connection
})

describe('installing floti from Settings > Hosts', () => {
  it('S8: checks the computer before adding it, then shows its OS and CPU, that floti is not there, and what installing does and where', async () => {
    const install = actions({ kind: 'offer', id: 'offer-1', offer: NOT_FOUND_OFFER })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    expect(install.check).toHaveBeenCalledWith({ transport: { kind: 'ssh', target: 'me@build-box' } })
    const offer = await screen.findByText('Install floti on me@build-box?')
    const panel = offer.closest('[data-settings-host-offer]') as HTMLElement
    expect(panel.getAttribute('data-settings-host-offer')).toBe('install')
    expect(panel.querySelector('[data-settings-host-offer-system]')?.textContent).toBe('Linux · x86_64')
    expect(panel.querySelector('[data-settings-host-offer-found]')?.textContent).toBe('floti not found')
    expect(panel.textContent).toContain('~/.local/bin')
    expect(within(panel).getByRole('button', { name: 'Install on me@build-box' })).toBeTruthy()
    expect(within(panel).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    // Nothing is installed or added before the yes.
    expect(install.install).not.toHaveBeenCalled()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('S9: Cancel withdraws the offer and adds nothing', async () => {
    const install = actions({ kind: 'offer', id: 'offer-1', offer: NOT_FOUND_OFFER })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    const panel = (await screen.findByText('Install floti on me@build-box?')).closest('[data-settings-host-offer]') as HTMLElement
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(install.cancel).toHaveBeenCalledWith('offer-1')
    expect(install.install).not.toHaveBeenCalled()
    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.queryByText('Install floti on me@build-box?')).toBeNull()
  })

  it('S16: the yes installs, then adds the host keeping the full path floti was installed at', async () => {
    const install = actions({ kind: 'offer', id: 'offer-1', offer: NOT_FOUND_OFFER })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    await userEvent.click(await screen.findByRole('button', { name: 'Install on me@build-box' }))
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
    expect(install.install).toHaveBeenCalledWith('offer-1', expect.any(String))
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'me@build-box', floti: '/home/me/.local/bin/floti' })
    )
  })

  it('adds a host whose floti this Helm can talk to without asking anything', async () => {
    const install = actions({ kind: 'ready', found: { version: '2.6.0', protocol: '1.0' } })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1))
    expect(onAdd.mock.lastCall?.[0]).not.toHaveProperty('floti')
  })

  it('S15: a failed install shows the last line written there, unedited, says a floti there still works, and adds nothing', async () => {
    const lastLine = 'floti install: floti-2.6.0-linux-x64 did not match its SHA-256, so it was not installed.'
    const install = actions({ kind: 'offer', id: 'offer-1', offer: NOT_FOUND_OFFER }, { ok: false, step: 'install', lastLine })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    await userEvent.click(await screen.findByRole('button', { name: 'Install on me@build-box' }))
    const alert = await screen.findByRole('alert')
    expect(alert.querySelector('[data-settings-host-problem-line]')?.textContent).toBe(lastLine)
    expect(alert.textContent).toContain('Installing floti on me@build-box failed')
    expect(alert.textContent).toContain('Nothing replaced a floti that was there.')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('S12: says there is no floti it can install there, and adds nothing', async () => {
    const install = actions({
      kind: 'noBuild',
      system: { os: null, cpu: 'arm64', label: 'FreeBSD · arm64' },
      reason: 'There is no floti for FreeBSD · arm64 yet.'
    })
    const { onAdd } = renderHosts(install, { adding: true })
    await submitTarget('me@build-box')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('There is no floti Helm can install on me@build-box')
    expect(alert.textContent).toContain('There is no floti for FreeBSD · arm64 yet.')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('S13, S14: an update names the version found and the sessions it ends, on the button that does it', async () => {
    const install = actions({
      kind: 'offer',
      id: 'offer-2',
      offer: { ...NOT_FOUND_OFFER, action: 'update', found: { version: '2.1.0', protocol: '0.9' }, sessions: 2 }
    })
    const { onInstalled } = renderHosts(install, { hosts: [host({ state: 'tooOld', host: '0.9', client: '1.0' }, '/home/me/.local/bin/floti')] })
    const row = screen.getByRole('group', { name: 'build-box' })
    expect(row.querySelector('[data-settings-host-too-old]')?.textContent).toContain('protocol 0.9')
    await userEvent.click(within(row).getByRole('button', { name: 'Update floti' }))
    expect(install.check).toHaveBeenCalledWith({ host: 'h-build' })
    const panel = (await screen.findByText('Update floti on build-box?')).closest('[data-settings-host-offer]') as HTMLElement
    expect(panel.querySelector('[data-settings-host-offer-found]')?.textContent).toContain('2.1.0')
    expect(panel.textContent).toContain('ending 2 sessions')
    await userEvent.click(within(panel).getByRole('button', { name: 'Update floti on build-box, ending 2 sessions' }))
    await vi.waitFor(() => expect(onInstalled).toHaveBeenCalledWith('h-build', '/home/me/.local/bin/floti'))
  })

  it('S18, S19, S17: names a missing floti, one too old and one newer with both versions, and one that starts at the next sign-in', () => {
    renderHosts(actions({ kind: 'ready', found: { version: '2.6.0', protocol: '1.0' } }), {
      hosts: [
        { ...host({ state: 'missing', lastLine: 'sh: 1: floti: not found' }), host: { id: 'a', name: 'a', transport: { kind: 'ssh', target: 'a' } } },
        { ...host({ state: 'tooOld', host: '0.9', client: '1.0' }), host: { id: 'b', name: 'b', transport: { kind: 'ssh', target: 'b' } } },
        { ...host({ state: 'newer', host: '2.0', client: '1.0' }), host: { id: 'c', name: 'c', transport: { kind: 'ssh', target: 'c' } } },
        { ...host({ state: 'startsAtSignIn' }), host: { id: 'd', name: 'd', transport: { kind: 'ssh', target: 'd' } } }
      ]
    })
    const missing = screen.getByRole('group', { name: 'a' })
    expect(missing.textContent).toContain('floti not found')
    expect(within(missing).getByText('sh: 1: floti: not found')).toBeTruthy()
    expect(within(missing).getByRole('button', { name: 'Install floti' })).toBeTruthy()

    const old = screen.getByRole('group', { name: 'b' })
    expect(old.textContent).toContain('floti too old')
    expect(within(old).getByRole('button', { name: 'Update floti' })).toBeTruthy()

    const newer = screen.getByRole('group', { name: 'c' })
    expect(newer.querySelector('[data-settings-host-newer]')?.textContent).toContain(
      'it speaks protocol 2.0, and this Helm speaks 1.0. Update Helm on this PC, then it connects.'
    )
    expect(within(newer).queryByRole('button', { name: 'Update floti' })).toBeNull()

    const later = screen.getByRole('group', { name: 'd' })
    expect(later.textContent).toContain('Starts at next sign-in')
    expect(later.querySelector('[data-settings-host-starts-at-sign-in]')).not.toBeNull()
    expect(later.textContent).not.toContain('Cannot connect')
  })

  it('S18: the sidebar’s Update floti starts the same update in the host’s row', async () => {
    const install = actions({ kind: 'offer', id: 'offer-3', offer: { ...NOT_FOUND_OFFER, action: 'update', found: { version: '2.1.0', protocol: '0.9' } } })
    const { rerender } = renderHosts(install, { hosts: [host({ state: 'tooOld', host: '0.9', client: '1.0' })] })
    expect(install.check).not.toHaveBeenCalled()
    rerender({ hosts: [host({ state: 'tooOld', host: '0.9', client: '1.0' })], updateRequest: { id: 'h-build', nonce: 1 } })
    expect(await screen.findByText('Update floti on build-box?')).toBeTruthy()
    expect(install.check).toHaveBeenCalledWith({ host: 'h-build' })
  })
})
