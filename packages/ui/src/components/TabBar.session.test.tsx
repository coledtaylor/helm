import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { SessionState } from '../lib/sessionstate'
import { TabBar, type Tab, type TabBarProps } from './TabBar'

/**
 * What a session tab says about its session: the state dot's tone, and the
 * inline rename that must keep the keyboard to itself while it is open.
 */

function renderBar(tabs: Tab[], overrides: Partial<TabBarProps> = {}): TabBarProps {
  const props: TabBarProps = {
    tabs,
    activeId: tabs[0]?.id ?? null,
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

/** The dot is drawn, not read: it is `aria-hidden`, and its tone is its class. */
function dotOf(tab: HTMLElement): string[] {
  const dot = tab.querySelector('[aria-hidden]')
  return dot === null ? [] : [...dot.classList]
}

describe('TabBar session tabs', () => {
  it('opens a session tab’s menu on a right-click, and a chosen row is told with the tab it was for', async () => {
    const user = userEvent.setup()
    const onMenu = vi.fn()
    const onClose = vi.fn()
    const menuFor = (id: string) =>
      id === 'session:7' ? [{ kind: 'item' as const, id: 'keep-running', label: 'Close tab, keep running' }] : []
    renderBar(
      [
        { id: 'session:7', title: 'alpha', indicator: 'idle' },
        { id: 'history', title: 'History' }
      ],
      { menuFor, onMenu, onClose }
    )

    fireEvent.contextMenu(screen.getByRole('tab', { name: 'alpha, ready' }), { clientX: 40, clientY: 12 })
    expect(screen.getByRole('menu', { name: 'alpha tab' })).toBeTruthy()
    await user.click(screen.getByRole('menuitem', { name: 'Close tab, keep running' }))
    expect(onMenu).toHaveBeenCalledWith('session:7', 'keep-running')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens no menu on a tab with nothing to offer, or on any tab when the strip offers none', () => {
    const menuFor = (id: string) =>
      id === 'session:7' ? [{ kind: 'item' as const, id: 'keep-running', label: 'Close tab, keep running' }] : []
    renderBar([{ id: 'history', title: 'History' }], { menuFor })
    const plain = fireEvent.contextMenu(screen.getByRole('tab', { name: 'History' }))
    // Not prevented: the right-click is left to do what it otherwise does.
    expect(plain).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('offers no menu on a session tab when the strip is given none, as with sessions in Helm itself', () => {
    renderBar([{ id: 'session:7', title: 'alpha', indicator: 'idle' }])
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'alpha, ready' }), { clientX: 40, clientY: 12 })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('paints each session state in the tone DESIGN.md gives it, with busy, waiting and idle all distinct', () => {
    const states: [SessionState, string][] = [
      ['busy', 'working'],
      ['waiting', 'waiting for you'],
      ['idle', 'ready'],
      ['running', 'running'],
      ['shell', 'finished, background task still running'],
      ['ended', 'ended'],
      ['failed', 'exited with an error']
    ]
    renderBar(states.map(([state]) => ({ id: `session:${state}`, title: state, indicator: state })))
    const dot = (state: SessionState, label: string): string[] =>
      dotOf(screen.getByRole('tab', { name: `${state}, ${label}` }))

    // The table in DESIGN.md, "The session tab's state dot".
    expect(dot('busy', 'working')).toContain('bg-accent')
    expect(dot('waiting', 'waiting for you')).toContain('bg-warn')
    expect(dot('idle', 'ready')).toContain('bg-success')
    expect(dot('running', 'running')).toContain('bg-success')
    expect(dot('shell', 'finished, background task still running')).toContain('border-success')
    expect(dot('shell', 'finished, background task still running')).not.toContain('bg-success')
    expect(dot('ended', 'ended')).toContain('bg-fg-subtle')
    expect(dot('failed', 'exited with an error')).toContain('bg-danger')

    const tones = (['busy', 'waiting', 'idle'] as const).map((state) =>
      dot(state, states.find(([s]) => s === state)?.[1] ?? '').find((c) => c.startsWith('bg-'))
    )
    expect(new Set(tones).size).toBe(3)
  })

  it('opens the rename field focused with the title selected, and keeps its keys from the strip', async () => {
    const props = renderBar([
      { id: 'session:1', title: 'alpha', indicator: 'idle', renamable: true },
      { id: 'session:2', title: 'beta', indicator: 'idle', renamable: true }
    ])
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('tab', { name: 'alpha, ready' }))
    const field = screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename this tab' })
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'alpha'.length])
    // The double-click's own two clicks activated the tab; nothing after them may.
    vi.mocked(props.onActivate).mockClear()

    // The arrows move the caret, not the tab.
    fireEvent.keyDown(field, { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    await user.keyboard('review')
    expect(props.onMove).not.toHaveBeenCalled()
    expect(props.onActivate).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('review')

    await user.keyboard('{Enter}')
    expect(props.onRename).toHaveBeenCalledWith('session:1', 'review')
    expect(screen.queryByRole('textbox', { name: 'Rename this tab' })).toBeNull()
  })

  it('commits the rename when the field loses the focus, rather than dropping what was typed', async () => {
    const props = renderBar([
      { id: 'session:1', title: 'alpha', indicator: 'idle', renamable: true },
      { id: 'session:2', title: 'beta', indicator: 'idle', renamable: true }
    ])
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('tab', { name: 'alpha, ready' }))
    await user.keyboard('review')
    await user.click(screen.getByRole('tab', { name: 'beta, ready' }))
    expect(props.onRename).toHaveBeenCalledWith('session:1', 'review')
  })
})
