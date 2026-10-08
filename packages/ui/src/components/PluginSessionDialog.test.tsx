import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PluginSessionDialog, pluginSessionCommand, type PluginSessionDialogProps } from './PluginSessionDialog'

function renderDialog(overrides: Partial<PluginSessionDialogProps> = {}): PluginSessionDialogProps {
  const props: PluginSessionDialogProps = {
    pluginName: 'Trackr',
    cwd: 'C:\\Users\\me\\repos\\helm',
    name: 'HELM-2',
    prompt: 'work on HELM-2',
    busy: false,
    error: null,
    onStart: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<PluginSessionDialog {...props} />)
  return props
}

describe('PluginSessionDialog', () => {
  it('shows the folder, the name, the first message and the command before anything runs', () => {
    renderDialog()
    const dialog = screen.getByRole('alertdialog', { name: 'Trackr wants to start a session' })
    const field = (name: string): string | null | undefined =>
      dialog.querySelector(`[data-plugin-session-field="${name}"] dd`)?.textContent
    expect(field('folder')).toBe('C:\\Users\\me\\repos\\helm')
    expect(field('name')).toBe('HELM-2')
    expect(field('prompt')).toBe('work on HELM-2')
    expect(field('command')).toBe('claude -n HELM-2 "work on HELM-2"')
  })

  it('puts the focus on Cancel, so an Enter meant for something else starts nothing', async () => {
    const props = renderDialog()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.keyboard('{Enter}')
    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onStart).not.toHaveBeenCalled()
  })

  it('starts on Start session, and Escape cancels', async () => {
    const props = renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(props.onStart).toHaveBeenCalledTimes(1)
    await userEvent.keyboard('{Escape}')
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('cannot be dismissed while the session starts', async () => {
    const props = renderDialog({ busy: true })
    expect(screen.getByRole('button', { name: 'Starting…' }).hasAttribute('disabled')).toBe(true)
    await userEvent.keyboard('{Escape}')
    // The header's close: the footer's Cancel is disabled.
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('says why it did not start, and offers only closing', async () => {
    const props = renderDialog({ error: 'Claude Code CLI not found.' })
    expect(screen.getByRole('alert').textContent).toBe('Claude Code CLI not found.')
    expect(screen.queryByRole('button', { name: 'Start session' })).toBeNull()
    const footerClose = document.querySelector<HTMLButtonElement>('[data-plugin-session-cancel]')!
    expect(footerClose.textContent).toBe('Close')
    await userEvent.click(footerClose)
    expect(props.onCancel).toHaveBeenCalled()
  })
})

describe('pluginSessionCommand', () => {
  it('quotes what has a space or a cmd metacharacter, and nothing else', () => {
    expect(pluginSessionCommand('api', 'go')).toBe('claude -n api go')
    expect(pluginSessionCommand('my api', 'fix a & b')).toBe('claude -n "my api" "fix a & b"')
  })
})
