import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TabBar } from './TabBar'

/**
 * A native browser view paints over the drop mark and the dragged tab's ghost,
 * so the strip says when a drag starts and ends and the view stands down for it.
 */
describe('TabBar drag', () => {
  it('says which tab a drag started on, and that it ended', () => {
    const onDragging = vi.fn()
    render(
      <TabBar
        tabs={[
          { id: 'browser:1', title: 'Dev server' },
          { id: 'session:2', title: 'alpha' }
        ]}
        activeId="browser:1"
        focused
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onMove={vi.fn()}
        onDragging={onDragging}
      />
    )
    const tab = screen.getByRole('tab', { name: 'Dev server' })
    // jsdom has no DataTransfer; this is the part of one the strip uses.
    const dataTransfer = { setData: vi.fn(), getData: () => '', types: [] as string[], effectAllowed: '', dropEffect: '' }

    fireEvent.dragStart(tab, { dataTransfer })
    expect(onDragging.mock.calls).toEqual([['browser:1']])
    fireEvent.dragEnd(tab, { dataTransfer })
    expect(onDragging.mock.calls).toEqual([['browser:1'], [null]])
  })
})
