import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { formatDuration, SessionEndedBar } from './SessionEndedBar'

describe('SessionEndedBar', () => {
  it('says the session ended, and for how long it ran, and offers the close rather than doing it', async () => {
    const onClose = vi.fn()
    render(<SessionEndedBar exitCode={0} durationMs={65_000} onClose={onClose} />)
    const bar = screen.getByRole('status')
    expect(bar.textContent).toContain('Session ended')
    expect(bar.textContent).toContain('after 1m 5s')
    expect(onClose).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('names the code of a session that failed', () => {
    render(<SessionEndedBar exitCode={3} durationMs={null} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Session exited with code 3Close tab')
  })

  it('gives a wrapped exit code as the system reports it, in danger', () => {
    render(<SessionEndedBar exitCode={-1073741819} durationMs={null} onClose={vi.fn()} />)
    const bar = screen.getByRole('status')
    expect(bar.textContent).toBe('Session exited with code -1073741819Close tab')
    expect(bar.textContent).not.toContain('2147483647')
    expect(bar.className).toContain('text-danger')
  })

  it('lays a failed or lost bar\'s tint over an opaque surface, so a light theme does not show the terminal\'s dark ground through it', () => {
    const { rerender } = render(<SessionEndedBar exitCode={5} durationMs={null} onClose={vi.fn()} />)
    const failed = screen.getByRole('status').className
    expect(failed).toContain('bg-surface ')
    expect(failed).toContain('from-danger/10')
    expect(failed).not.toMatch(/(^| )bg-danger\/10/)
    rerender(
      <SessionEndedBar
        exitCode={null}
        durationMs={null}
        onClose={vi.fn()}
        lost={{ hostName: 'this PC’s host', restoreReady: false, onRestore: vi.fn() }}
      />
    )
    const lost = screen.getByRole('status').className
    expect(lost).toContain('bg-surface ')
    expect(lost).toContain('from-warn/10')
  })

  it('says a session the host ended was stopped, in the ended tone, whatever number the system gave its termination', () => {
    render(<SessionEndedBar exitCode={2147483647} durationMs={4_000} onClose={vi.fn()} stopped />)
    const bar = screen.getByRole('status')
    expect(bar.textContent).toBe('Stoppedafter 4sClose tab')
    expect(bar.textContent).not.toContain('Session exited with code')
    expect(bar.className).toContain('border-border')
    expect(bar.className).toContain('bg-surface-sunken')
    expect(bar.className).toContain('text-fg-muted')
    expect(bar.className).not.toContain('danger')
    expect(bar.firstElementChild?.className).toContain('bg-fg-subtle')
    expect(bar.firstElementChild?.className).not.toContain('danger')
  })

  it('says only that it ended when no exit code was observed', () => {
    render(<SessionEndedBar exitCode={null} durationMs={800} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Session endedafter 800msClose tab')
  })

  it('says a session lost with its host was lost, and offers Restore beside Close tab once the host offers it back', async () => {
    const onRestore = vi.fn()
    const onClose = vi.fn()
    const { rerender } = render(
      <SessionEndedBar
        exitCode={null}
        durationMs={null}
        onClose={onClose}
        lost={{ hostName: 'this PC’s host', restoreReady: false, onRestore }}
      />
    )
    const bar = screen.getByRole('status')
    expect(bar.textContent).toBe('Session lost on this PC’s hostRestoreClose tab')
    // Not yet offered: the host has not come back.
    expect(screen.getByRole('button', { name: 'Restore' })).toHaveProperty('disabled', true)

    rerender(
      <SessionEndedBar
        exitCode={null}
        durationMs={null}
        onClose={onClose}
        lost={{ hostName: 'this PC’s host', restoreReady: true, onRestore }}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('rounds a duration to the coarsest unit that still says something', () => {
    expect(formatDuration(-5)).toBe('0ms')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1_400)).toBe('1s')
    expect(formatDuration(59_400)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
    expect(formatDuration(3_600_000)).toBe('1h 00m')
    expect(formatDuration(5 * 3_600_000 + 7 * 60_000)).toBe('5h 07m')
  })
})
