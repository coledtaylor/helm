import { fireEvent, render, screen } from '@testing-library/react'
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
