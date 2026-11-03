import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HostLostBanner } from './HostLostBanner'

describe('HostLostBanner', () => {
  it('S7: says the connection to the host was lost and the session keeps running there, with Reconnect now', () => {
    const onReconnect = vi.fn()
    render(
      <HostLostBanner
        hostName="build-box"
        sessionName="deploy"
        lastLine={null}
        tryLine="ssh build-box floti connect"
        onReconnect={onReconnect}
      />
    )
    const banner = screen.getByRole('status')
    expect(banner.textContent).toBe('Lost the connection to build-box. deploy keeps running there.Reconnect now')
    // Only trying again: no failure line to show.
    expect(banner.querySelector('[data-host-lost-failed]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('S5: shows the last line ssh wrote, unedited, and the line to try by hand', () => {
    const line = 'me@build-box: Permission denied (publickey,password).'
    render(
      <HostLostBanner
        hostName="build-box"
        sessionName="deploy"
        lastLine={line}
        tryLine="ssh me@build-box floti connect"
        onReconnect={() => undefined}
      />
    )
    expect(document.querySelector('[data-host-lost-line]')?.textContent).toBe(line)
    expect(document.querySelector('[data-host-lost-try]')?.textContent).toBe('ssh me@build-box floti connect')
    // Nothing asks for a password: the one control is Reconnect now.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Reconnect now'])
    expect(document.querySelector('input')).toBeNull()
  })
})
