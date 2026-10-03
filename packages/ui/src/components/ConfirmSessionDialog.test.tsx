import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmSessionDialog, type ConfirmSessionDialogProps } from './ConfirmSessionDialog'

function renderDialog(overrides: Partial<ConfirmSessionDialogProps> = {}): ConfirmSessionDialogProps {
  const props: ConfirmSessionDialogProps = {
    kind: 'close-session',
    message: '“review” is still running.',
    detail: 'Closing the tab ends the Claude Code session in C:\\work\\shop.',
    confirmLabel: 'End session',
    sessionNames: ['review'],
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<ConfirmSessionDialog {...props} />)
  return props
}

describe('ConfirmSessionDialog', () => {
  it('asks under the session’s name, with Cancel in focus so a stray Enter ends nothing', async () => {
    const props = renderDialog()
    const dialog = screen.getByRole('alertdialog', { name: '“review” is still running.' })
    expect(dialog.textContent).toContain('Closing the tab ends the Claude Code session in C:\\work\\shop.')
    // One session is already named in the question; it is not listed again.
    expect(within(dialog).queryByRole('list')).toBeNull()

    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Enter}')
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('ends the session only from its own button, and Escape means no', async () => {
    const props = renderDialog()
    await userEvent.keyboard('{Escape}')
    expect(props.onCancel).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'End session' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('lists the sessions a quit would end, and summarises past six', () => {
    renderDialog({
      kind: 'quit',
      message: '8 Claude Code sessions are still running.',
      detail: 'Quitting Helm ends them.',
      confirmLabel: 'End 8 sessions',
      sessionNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    })
    const dialog = screen.getByRole('alertdialog', { name: '8 Claude Code sessions are still running.' })
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'and 2 more sessions'
    ])
    expect(within(dialog).getByRole('button', { name: 'End 8 sessions' })).toBeDefined()
  })
})
