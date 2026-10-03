import type { JSX } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PaneActions } from './PaneGroup'

function renderActions(maximized: boolean): { onMaximize: ReturnType<typeof vi.fn>; rerender: (maximized: boolean) => void } {
  const onMaximize = vi.fn()
  const element = (on: boolean): JSX.Element => (
    <PaneActions
      split={null}
      maximized={on}
      canMaximize
      canClose={false}
      onSplit={vi.fn()}
      onMaximize={onMaximize}
      onClose={vi.fn()}
    />
  )
  const { rerender } = render(element(maximized))
  return { onMaximize, rerender: (on) => rerender(element(on)) }
}

describe('PaneActions maximize', () => {
  it('offers the whole window, then offers the panes back', async () => {
    const { onMaximize, rerender } = renderActions(false)
    await userEvent.click(screen.getByRole('button', { name: 'Give this pane the whole window' }))
    expect(onMaximize).toHaveBeenCalledTimes(1)

    rerender(true)
    expect(screen.queryByRole('button', { name: 'Give this pane the whole window' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Restore the panes' }))
    expect(onMaximize).toHaveBeenCalledTimes(2)
  })

  it('offers nothing to maximize in an empty pane', () => {
    render(
      <PaneActions
        split={null}
        maximized={false}
        canMaximize={false}
        canClose={false}
        onSplit={vi.fn()}
        onMaximize={vi.fn()}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Give this pane the whole window' })).toBeNull()
  })
})
