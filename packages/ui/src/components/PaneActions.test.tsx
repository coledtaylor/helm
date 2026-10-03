import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PaneActions } from './PaneGroup'

/**
 * The split button at the end of a pane's strip: what it offers to do with
 * the front tab, and that it does it. Where the tab goes is
 * `sendBeside`'s (`core/layout/panes.test.ts`).
 */

function renderActions(split: 'new' | 'other' | null): { onSplit: ReturnType<typeof vi.fn> } {
  const onSplit = vi.fn()
  render(
    <PaneActions
      split={split}
      maximized={false}
      canMaximize={false}
      canClose={false}
      onSplit={onSplit}
      onMaximize={vi.fn()}
      onClose={vi.fn()}
    />
  )
  return { onSplit }
}

describe('PaneActions split', () => {
  it('offers a lone pane’s front tab a pane of its own', async () => {
    const { onSplit } = renderActions('new')

    await userEvent.click(screen.getByRole('button', { name: 'Split: move this tab to a pane of its own (Ctrl+\\)' }))

    expect(onSplit).toHaveBeenCalledTimes(1)
  })

  it('offers to move the front tab to the pane beside it when there is one', async () => {
    const { onSplit } = renderActions('other')

    await userEvent.click(screen.getByRole('button', { name: 'Move this tab to the pane beside it (Ctrl+\\)' }))

    expect(onSplit).toHaveBeenCalledTimes(1)
  })

  it('offers nothing for a lone tab in a lone pane', () => {
    renderActions(null)

    expect(screen.queryByRole('button', { name: /Split|Move this tab/ })).toBeNull()
  })
})
