import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'
import { HistoryIcon } from './icons'

describe('EmptyState', () => {
  it('says what is empty, one sentence about it, and offers the way on', async () => {
    const onRefresh = vi.fn()
    const { container } = render(
      <EmptyState
        name="sessions"
        icon={<HistoryIcon />}
        title="No sessions running"
        actions={
          <button type="button" onClick={onRefresh}>
            Check again
          </button>
        }
      >
        Nothing is running in the 3 folders Helm scans.
      </EmptyState>
    )

    expect(container.querySelector('[data-empty-state="sessions"]')).not.toBeNull()
    expect(screen.getByText('No sessions running')).toBeTruthy()
    expect(screen.getByText('Nothing is running in the 3 folders Helm scans.')).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }))
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('fills a detail region on a page, and sits at the top of a list column', () => {
    const { container, rerender } = render(<EmptyState icon={<HistoryIcon />} title="Nothing here" />)
    const box = (): HTMLElement => container.querySelector<HTMLElement>('[data-empty-state]')!
    expect(box().className).toContain('h-full')

    rerender(<EmptyState size="list" icon={<HistoryIcon />} title="Nothing here" />)
    expect(box().className).not.toContain('h-full')
    // No sentence and no actions means no empty paragraph and no empty row.
    expect(box().querySelectorAll('p')).toHaveLength(1)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
