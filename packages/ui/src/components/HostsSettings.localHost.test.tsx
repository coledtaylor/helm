import type { LocalHostVersions } from '@helm/core/types'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { HostsSettings } from './HostsSettings'

function renderNotice(versions: LocalHostVersions | null, onRestart = vi.fn()) {
  render(
    <HostsSettings
      hosts={[]}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onQuitChange={vi.fn()}
      install={{ check: vi.fn(), install: vi.fn(), cancel: vi.fn() }}
      onInstalled={vi.fn()}
      localHost={versions === null ? null : { versions, onRestart }}
    />
  )
  return onRestart
}

describe('Settings > Hosts: this PC’s host on another floti than this Helm', () => {
  it('S9: says this PC’s host runs an older floti, naming both versions, and offers Restart host to update', async () => {
    const onRestart = renderNotice({ older: 'host', host: '2.4.0', helm: '2.4.1', stopFromMenu: false })
    const notice = screen.getByRole('group', { name: 'This PC' })
    expect(notice.getAttribute('data-settings-local-host')).toBe('host')
    expect(notice.textContent).toContain('Older host')
    expect(notice.textContent).toContain('runs floti 2.4.0, older than the floti 2.4.1 this Helm carries')
    await userEvent.click(screen.getByRole('button', { name: 'Restart host to update' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('S7: a host refused for being behind names both protocols and offers the restart', () => {
    renderNotice({ older: 'host', host: 'protocol 2.0', helm: 'protocol 2.1', stopFromMenu: false })
    expect(screen.getByRole('group', { name: 'This PC' }).textContent).toContain(
      'runs Floti protocol 2.0, older than the Floti protocol 2.1'
    )
    expect(screen.getByRole('button', { name: 'Restart host to update' })).toBeTruthy()
  })

  it('S15: a host on protocol 1.x is told to stop from its notification-area menu, with no restart offered', () => {
    renderNotice({ older: 'host', host: 'protocol 1.4', helm: 'protocol 2.0', stopFromMenu: true })
    expect(screen.getByRole('group', { name: 'This PC' }).textContent).toContain(
      'Stop it with Stop host in its notification-area menu'
    )
    expect(screen.queryByRole('button', { name: 'Restart host to update' })).toBeNull()
  })

  it('S8: a Helm behind its host is told to update Helm on this PC, with no restart offered', () => {
    renderNotice({ older: 'helm', host: 'protocol 2.2', helm: 'protocol 2.0' })
    const notice = screen.getByRole('group', { name: 'This PC' })
    expect(notice.textContent).toContain('Update Helm')
    expect(notice.textContent).toContain('Update Helm on this PC.')
    expect(screen.queryByRole('button', { name: 'Restart host to update' })).toBeNull()
  })

  it('S10: with the same floti there is no notice and no offer', () => {
    renderNotice(null)
    expect(screen.queryByRole('group', { name: 'This PC' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart host to update' })).toBeNull()
  })
})
