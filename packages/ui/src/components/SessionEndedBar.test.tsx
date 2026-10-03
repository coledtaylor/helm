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

  it('says only that it ended when no exit code was observed', () => {
    render(<SessionEndedBar exitCode={null} durationMs={800} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toBe('Session endedafter 800msClose tab')
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
