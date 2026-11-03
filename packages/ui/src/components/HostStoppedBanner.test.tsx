import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HostStoppedBanner } from './HostStoppedBanner'

describe('HostStoppedBanner', () => {
  it('says this PC’s host stopped and that Helm is starting it again, when Helm starts it', () => {
    render(<HostStoppedBanner hostName="this PC’s host" restarting />)
    expect(screen.getByRole('status').textContent).toBe('This PC’s host stopped. Starting it again…')
  })

  it('says Helm is reconnecting, when the host is not one Helm starts', () => {
    render(<HostStoppedBanner hostName="this PC’s host" restarting={false} />)
    expect(screen.getByRole('status').textContent).toBe('Reconnecting to this PC’s host…')
  })
})
