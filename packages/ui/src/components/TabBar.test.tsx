import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TabBar, type Tab, type TabBarProps } from './TabBar'

const TABS: Tab[] = [
  { id: 'session:1', title: 'alpha', indicator: 'idle', renamable: true },
  { id: 'session:2', title: 'beta', indicator: 'waiting' },
  { id: 'settings', title: 'Settings', closable: false }
]

function renderBar(overrides: Partial<TabBarProps> = {}) {
  const props: TabBarProps = {
    tabs: TABS,
    activeId: 'session:1',
    focused: true,
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onMove: vi.fn(),
    onRename: vi.fn(),
    ...overrides
  }
  render(<TabBar {...props} />)
  return props
}

describe('TabBar', () => {
  it('names each tab with its session state and selects the active one', () => {
    renderBar()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('aria-label') ?? tab.textContent)).toEqual([
      'alpha, ready',
      'beta, waiting for you',
      'Settings'
    ])
    expect(screen.getByRole('tab', { name: 'alpha, ready' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: 'beta, waiting for you' }).getAttribute('aria-selected')).toBe('false')
  })

  it('activates a tab on click', async () => {
    const props = renderBar()
    await userEvent.click(screen.getByRole('tab', { name: 'beta, waiting for you' }))
    expect(props.onActivate).toHaveBeenCalledWith('session:2')
  })

  it('closes a tab from its close button or a middle click, and only a closable one', async () => {
    const props = renderBar()
    await userEvent.click(screen.getByRole('button', { name: 'Close beta' }))
    expect(props.onClose).toHaveBeenCalledWith('session:2')

    fireEvent(screen.getByRole('tab', { name: 'alpha, ready' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(props.onClose).toHaveBeenLastCalledWith('session:1')

    expect(screen.queryByRole('button', { name: 'Close Settings' })).toBeNull()
    fireEvent(screen.getByRole('tab', { name: 'Settings' }), new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('moves a tab one place with Ctrl+Shift+Arrow, and not past either end', () => {
    const props = renderBar()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'alpha, ready' }), { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    expect(props.onMove).toHaveBeenCalledWith('session:1', 1)

    fireEvent.keyDown(screen.getByRole('tab', { name: 'alpha, ready' }), { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(screen.getByRole('tab', { name: 'beta, waiting for you' }), { key: 'ArrowRight' })
    expect(props.onMove).toHaveBeenCalledTimes(1)
  })

  it('renames a renamable tab on double-click: Enter commits, blank resets, Escape abandons', async () => {
    const props = renderBar()
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('tab', { name: 'alpha, ready' }))
    await user.clear(screen.getByRole('textbox', { name: 'Rename this tab' }))
    await user.type(screen.getByRole('textbox', { name: 'Rename this tab' }), '  review  {Enter}')
    expect(props.onRename).toHaveBeenLastCalledWith('session:1', 'review')

    await user.dblClick(screen.getByRole('tab', { name: 'alpha, ready' }))
    await user.clear(screen.getByRole('textbox', { name: 'Rename this tab' }))
    await user.keyboard('{Enter}')
    expect(props.onRename).toHaveBeenLastCalledWith('session:1', null)

    await user.dblClick(screen.getByRole('tab', { name: 'alpha, ready' }))
    await user.type(screen.getByRole('textbox', { name: 'Rename this tab' }), 'discarded{Escape}')
    expect(props.onRename).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('textbox', { name: 'Rename this tab' })).toBeNull()

    await user.dblClick(screen.getByRole('tab', { name: 'beta, waiting for you' }))
    expect(screen.queryByRole('textbox', { name: 'Rename this tab' })).toBeNull()
  })
})

describe('TabBar: a preview tab', () => {
  it('is drawn in italic and kept by a double click', () => {
    const onKeep = vi.fn()
    renderBar({
      tabs: [{ id: 'file:a', title: 'a.ts', mono: true, preview: true }, ...TABS],
      activeId: 'file:a',
      onKeep
    })
    const title = screen.getByRole('tab', { name: 'a.ts' }).querySelector('[data-tab-title]')
    expect(title?.className).toContain('italic')
    expect(title?.className).toContain('font-mono')
    fireEvent.doubleClick(screen.getByRole('tab', { name: 'a.ts' }))
    expect(onKeep).toHaveBeenCalledWith('file:a')
  })
})

describe('TabBar: unsaved changes', () => {
  it('marks a tab with a draft not on disk where its close button sits, and still closes it', () => {
    const props = renderBar({
      tabs: [{ id: 'file:a.md', title: 'a.md', dirty: true }, ...TABS],
      activeId: 'session:1'
    })
    const close = screen.getByRole('button', { name: 'Close a.md, unsaved changes' })
    expect(close.getAttribute('data-tab-dirty')).toBe('true')
    fireEvent.click(close)
    expect(props.onClose).toHaveBeenCalledWith('file:a.md')
  })
})

describe('TabBar: the new-tab button', () => {
  it('follows the last tab, outside the tab list, and hands its press the button', async () => {
    const onNewTab = vi.fn()
    renderBar({ onNewTab })
    const plus = screen.getByRole('button', { name: 'New tab' })
    expect(screen.getByRole('tablist').contains(plus)).toBe(false)
    expect(screen.getByRole('tablist').nextElementSibling).toBe(plus)
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(plus)
    expect(onNewTab).toHaveBeenCalledWith(plus)
  })

  it('stays lit while what it opened is on screen', () => {
    renderBar({ onNewTab: vi.fn(), newTabOpen: true })
    expect(screen.getByRole('button', { name: 'New tab' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('is drawn in a pane with no tabs, and not at all without a handler', () => {
    const { unmount } = render(
      <TabBar tabs={[]} activeId={null} focused onActivate={vi.fn()} onClose={vi.fn()} onNewTab={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'New tab' })).toBeTruthy()
    unmount()
    renderBar()
    expect(screen.queryByRole('button', { name: 'New tab' })).toBeNull()
  })

  it('says which tab is being dragged, and that the drag is over once it is dropped anywhere', async () => {
    const onDragging = vi.fn()
    renderBar({ onDragging })
    const data = new Map<string, string>()
    const dataTransfer = {
      types: [] as string[],
      setData: (type: string, value: string) => {
        data.set(type, value)
        dataTransfer.types = [...data.keys()]
      },
      getData: (type: string) => data.get(type) ?? '',
      effectAllowed: 'none'
    }
    const tab = screen.getByRole('tab', { name: 'beta, waiting for you' }).closest('[draggable]')!

    fireEvent.dragStart(tab, { dataTransfer })
    expect(onDragging).toHaveBeenLastCalledWith('session:2')
    expect(tab.className).toContain('opacity-40')

    // Dropped on another pane: this strip hears no `dragend` when the tab's
    // element has gone with it, so the window's drop is what ends the drag -
    // once the drop itself has been handled.
    fireEvent.drop(window)
    expect(onDragging).toHaveBeenLastCalledWith('session:2')
    await waitFor(() => expect(onDragging).toHaveBeenLastCalledWith(null))
    expect(tab.className).not.toContain('opacity-40')
  })

  it('takes a tab dropped on it as a drop at the end of the strip', () => {
    const onMove = vi.fn()
    renderBar({ onMove, onNewTab: vi.fn() })
    const data = new Map<string, string>([['application/x-helm-tab', 'session:1']])
    const dataTransfer = {
      types: [...data.keys()],
      getData: (type: string) => data.get(type) ?? '',
      dropEffect: 'none'
    }
    const plus = screen.getByRole('button', { name: 'New tab' })
    fireEvent.dragOver(plus, { dataTransfer })
    fireEvent.drop(plus, { dataTransfer })
    expect(onMove).toHaveBeenCalledWith('session:1', TABS.length - 1)
  })
})
