import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout, Terminal } from './terminal.testkit'
import { TerminalTabPane } from './TerminalTabPane'
import { disposeShell, getShell, terminalShellKey } from './pterms'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * A terminal tab's pane: a shell of its own in the tab's folder, taking the
 * caret when it is the tab in front and not before.
 */

const ALPHA = 'C:\\work\\alpha'

let nextId = 40

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  bridge.answer('pterm:open', () => ({ id: nextId++, shell: 'C:\\Shells\\pwsh.exe', requested: null, problem: null }))
  bridge.answer('pterm:close', () => undefined)
})

afterEach(async () => {
  await disposeShell(terminalShellKey(1))
  await disposeShell(terminalShellKey(2))
  document.body.replaceChildren()
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('TerminalTabPane', () => {
  it('opens a separate shell in its folder and takes the caret when it is in front', async () => {
    const focus = vi.spyOn(Terminal.prototype, 'focus')
    render(<TerminalTabPane id={1} path={ALPHA} active windowsBuild={null} />)
    await waitFor(() => expect(focus).toHaveBeenCalled())

    expect(bridge.invoked('pterm:open')).toEqual([expect.objectContaining({ path: ALPHA, separate: true })])
    expect(getShell(terminalShellKey(1))?.element.isConnected).toBe(true)
  })

  it('refits and takes the caret when brought to the front from behind another tab', async () => {
    const focus = vi.spyOn(Terminal.prototype, 'focus')
    const { rerender } = render(<TerminalTabPane id={2} path={ALPHA} active={false} windowsBuild={null} />)
    await waitFor(() => expect(getShell(terminalShellKey(2))).toBeDefined())
    focus.mockClear()
    const refit = vi.spyOn(getShell(terminalShellKey(2))!, 'refit')

    rerender(<TerminalTabPane id={2} path={ALPHA} active windowsBuild={null} />)

    expect(refit).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
  })

  it('says its shell was lost with the host, keeps its screen dimmed with input off, and starts a new shell in its folder on request', async () => {
    const user = userEvent.setup()
    const { container } = render(<TerminalTabPane id={1} path={ALPHA} active windowsBuild={null} />)
    await waitFor(() => expect(getShell(terminalShellKey(1))).toBeDefined())
    const lostId = nextId - 1
    const term = getShell(terminalShellKey(1))!.term as unknown as Terminal

    act(() => bridge.emit('pterm:exit', { id: lostId, exitCode: null, lost: true }))

    const bar = await screen.findByRole('status')
    expect(bar.textContent).toContain('Shell lost: this PC’s host stopped')
    expect(term.options.disableStdin).toBe(true)
    expect(container.querySelector('[data-terminal-lost]')).not.toBeNull()

    await user.click(within(bar).getByRole('button', { name: 'New shell' }))

    await waitFor(() => expect(bridge.invoked('pterm:open')).toHaveLength(2))
    expect(bridge.invoked('pterm:open')[1]).toEqual(expect.objectContaining({ path: ALPHA, separate: true }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(container.querySelector('[data-terminal-lost]')).toBeNull()
  })
})
