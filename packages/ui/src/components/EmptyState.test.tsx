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
        name="pulls"
        icon={<HistoryIcon />}
        title="No pull requests open"
        actions={
          <button type="button" onClick={onRefresh}>
            Check again
          </button>
        }
      >
        Nothing is open in the 3 repositories Helm scans.
      </EmptyState>
    )

    expect(container.querySelector('[data-empty-state="pulls"]')).not.toBeNull()
    expect(screen.getByText('No pull requests open')).toBeTruthy()
    expect(screen.getByText('Nothing is open in the 3 repositories Helm scans.')).toBeTruthy()
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
