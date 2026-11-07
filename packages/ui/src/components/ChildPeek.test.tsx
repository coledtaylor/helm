import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { overlayOpen } from '../lib/overlay'
import { ChildPeek, type ChildPeekProps } from './ChildPeek'

function peek(overrides: Partial<ChildPeekProps> = {}): ChildPeekProps {
  const props: ChildPeekProps = {
    name: 'reviewer',
    mark: { glyph: 'dot', state: 'busy' },
    state: { label: 'working', tone: 'working' },
    role: 'reviewer',
    folder: 'helm',
    folderPath: 'C:\\work\\helm',
    branch: 'main',
    mode: 'plan',
    report: null,
    screen: <div data-testid="screen">the child’s screen</div>,
    at: { x: 300, y: 80 },
    onClose: vi.fn(),
    onStop: vi.fn(),
    onOpen: vi.fn(),
    ...overrides
  }
  return props
}

describe('the peek', () => {
  it('S1: names the child with its state, role, folder, branch and mode, and shows its screen read-only with Stop and Open', () => {
    render(<ChildPeek {...peek({ report: { state: 'done', text: 'Reviewed the diff; two nits.' } })} />)
    const dialog = screen.getByRole('dialog', { name: 'reviewer' })
    expect(within(dialog).getByText('working').getAttribute('data-peek-state')).toBe('working')
    const facts = dialog.querySelector('dl')
    expect(facts?.textContent).toBe('RolereviewerFolderhelmBranchmainModeplan')
    expect(within(dialog).getByText('helm').getAttribute('title')).toBe('C:\\work\\helm')
    expect(within(dialog).getByTestId('screen')).toBeTruthy()
    const report = dialog.querySelector('[data-peek-report]')
    expect(report?.textContent).toBe('Last report · doneReviewed the diff; two nits.')
    expect(within(dialog).getByText('Watching only. Open it to type.')).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Open' })).toBeTruthy()
  })

  it('S1: says none for a child started with no role, and has no report block when it told nothing', () => {
    render(<ChildPeek {...peek({ role: null, branch: null, mode: null })} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('dl')?.textContent).toBe('RolenoneFolderhelmBranchnoneModedefault')
    expect(dialog.querySelector('[data-peek-report]')).toBeNull()
  })

  it('S1: a command child shows its command, folder and branch, and no role or mode', () => {
    render(
      <ChildPeek
        {...peek({
          name: 'tests',
          mark: { glyph: 'command', state: 'running' },
          command: 'pnpm test --watch',
          runsIn: 'your shell, pwsh'
        })}
      />
    )
    const dialog = screen.getByRole('dialog', { name: 'tests' })
    expect(dialog.querySelector('dl')?.textContent).toBe(
      'Commandpnpm test --watchFolderhelmBranchmainRuns inyour shell, pwsh'
    )
    expect(dialog.querySelector('[data-child-command="running"]')).not.toBeNull()
    expect(dialog.querySelector('[data-child-dot]')).toBeNull()
    expect(within(dialog).queryByText('Role')).toBeNull()
    expect(within(dialog).queryByText('Mode')).toBeNull()
  })

  it('S1: is 470px wide with a 150px screen, and its last report label is semibold', () => {
    render(<ChildPeek {...peek({ report: { state: 'done', text: 'Reviewed.' } })} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-[470px]')
    expect(dialog.querySelector('[data-peek-screen]')?.className).toContain('h-[150px]')
    expect(dialog.querySelector('[data-peek-report] span')?.className).toContain('font-semibold')
  })

  it('S1: an ended child says so, keeps Open and has no Stop', () => {
    render(<ChildPeek {...peek({ ended: true, state: { label: 'ended', tone: 'neutral' } })} />)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('ended').getAttribute('data-peek-state')).toBe('neutral')
    expect(within(dialog).getByText('Ended. Open shows its last screen.')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(within(dialog).getByRole('button', { name: 'Open' })).toBeTruthy()
  })

  it('S2: is an overlay while it is mounted, so a browser view stands down for it', () => {
    expect(overlayOpen()).toBe(false)
    const view = render(<ChildPeek {...peek()} />)
    expect(overlayOpen()).toBe(true)
    view.unmount()
    expect(overlayOpen()).toBe(false)
  })

  it('S2: Escape and the close button close it', async () => {
    const props = peek()
    render(<ChildPeek {...props} />)
    await userEvent.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close peek' }))
    expect(props.onClose).toHaveBeenCalledTimes(2)
  })

  it('takes the keyboard on the close button when it opens, and gives it back to what pressed it', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const view = render(<ChildPeek {...peek()} />)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close peek' }))
    view.unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('a press outside closes it, and a press on the row or chip it opened from does not', () => {
    const anchor = document.createElement('button')
    document.body.append(anchor)
    const props = peek({ anchorRef: { current: anchor } })
    render(<ChildPeek {...props} />)
    fireEvent.pointerDown(anchor)
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(1)
    anchor.remove()
  })

  it('S5: Stop asks the window, and the peek stays up for the question: a press on it and Escape do not close it', async () => {
    let answer: () => void = () => undefined
    const props = peek({ onStop: vi.fn(() => new Promise<void>((resolve) => (answer = resolve))) })
    render(<ChildPeek {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(props.onStop).toHaveBeenCalledTimes(1)

    // The question is a dialog elsewhere in the window.
    fireEvent.pointerDown(document.body)
    await userEvent.keyboard('{Escape}')
    expect(props.onClose).not.toHaveBeenCalled()

    await act(async () => {
      answer()
      await Promise.resolve()
    })
    // Answered: the peek is a peek again.
    fireEvent.pointerDown(document.body)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('S6: Open is the window’s to answer', async () => {
    const props = peek()
    render(<ChildPeek {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('is placed at the point it is given, hidden until measured', () => {
    render(<ChildPeek {...peek({ at: { x: 320, y: 90 } })} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.style.position).toBe('fixed')
    expect(dialog.style.left).toBe('320px')
    expect(dialog.style.top).toBe('90px')
  })
})
