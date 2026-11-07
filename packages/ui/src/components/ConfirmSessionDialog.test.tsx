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

  it('sets the folder the detail names in mono, in the body colour, inside the same sentence', () => {
    renderDialog({
      detail: 'Ending it stops the Claude Code session in C:\\work\\shop. lead, which started it, is told.',
      folder: 'C:\\work\\shop'
    })
    const dialog = screen.getByRole('alertdialog', { name: '“review” is still running.' })
    const folder = dialog.querySelector('[data-confirm-folder]')
    expect(folder?.textContent).toBe('C:\\work\\shop')
    expect(folder?.className).toContain('font-mono')
    expect(folder?.className).toContain('text-[11.5px]')
    expect(folder?.className).toContain('[overflow-wrap:anywhere]')
    expect(folder?.className).toContain('text-fg')
    expect(folder?.className).not.toContain('text-fg-muted')
    expect(folder?.parentElement?.textContent).toBe(
      'Ending it stops the Claude Code session in C:\\work\\shop. lead, which started it, is told.'
    )
  })

  it('reads the detail as written when it names no folder, or not the one given', () => {
    renderDialog({ detail: 'Quitting Helm ends them.', folder: 'C:\\elsewhere' })
    const dialog = screen.getByRole('alertdialog', { name: '“review” is still running.' })
    expect(dialog.querySelector('[data-confirm-folder]')).toBeNull()
    expect(dialog.textContent).toContain('Quitting Helm ends them.')
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
    // Without a keep answer there are two buttons, as with the setting off.
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Cancel',
      'End 8 sessions'
    ])
  })

  it('asks a quit with sessions in the host with End and quit, Keep running and quit, and Cancel, Cancel in focus', async () => {
    const props = renderDialog({
      kind: 'quit',
      message: 'Quitting Helm ends 1 session on this PC’s host.',
      detail: 'End and quit stops it.',
      confirmLabel: 'End and quit',
      keepLabel: 'Keep running and quit',
      sessionNames: ['review'],
      onKeep: vi.fn()
    })
    const dialog = screen.getByRole('alertdialog', { name: 'Quitting Helm ends 1 session on this PC’s host.' })
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Cancel',
      'Keep running and quit',
      'End and quit'
    ])
    // The message counts it without naming it, so the one session is listed.
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['review'])
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep running and quit' }))
    expect(props.onKeep).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).not.toHaveBeenCalled()
    await userEvent.click(within(dialog).getByRole('button', { name: 'End and quit' }))
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledTimes(1)
  })

  it('S16: a restart that ends no session confirms with the ordinary button, outlined in the accent, Cancel in focus', () => {
    renderDialog({
      kind: 'restart-host',
      message: 'Restart this PC’s host on floti 2.4.1? No session ends.',
      detail: 'Every session and terminal keeps running, with its screen, and the new host takes them over.',
      confirmLabel: 'Restart host',
      confirmTone: 'primary',
      sessionNames: []
    })
    const dialog = screen.getByRole('alertdialog', { name: 'Restart this PC’s host on floti 2.4.1? No session ends.' })
    const accept = within(dialog).getByRole('button', { name: 'Restart host' })
    expect(accept.className).toContain('border-accent')
    expect(accept.className).toContain('text-accent-text')
    expect(accept.className).not.toMatch(/danger/)
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('S16: a restart that ends sessions confirms with the danger button, Cancel in focus', () => {
    renderDialog({
      kind: 'restart-host',
      message: 'Restart this PC’s host on floti 2.4.1, ending 2 sessions?',
      detail: 'The host runs floti 2.4.0, whose sessions the new floti cannot take over, so they end.',
      confirmLabel: 'Restart host',
      confirmTone: 'danger',
      sessionNames: []
    })
    const dialog = screen.getByRole('alertdialog', { name: 'Restart this PC’s host on floti 2.4.1, ending 2 sessions?' })
    const accept = within(dialog).getByRole('button', { name: 'Restart host' })
    expect(accept.className).toContain('border-danger/50')
    expect(accept.className).toContain('text-danger')
    expect(accept.className).not.toContain('border-accent')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('draws the danger button when no tone is asked for', () => {
    renderDialog()
    expect(screen.getByRole('button', { name: 'End session' }).className).toContain('text-danger')
  })
})

describe('ConfirmSessionDialog closing a parent', () => {
  const ends = [
    { id: 2, name: 'reviewer', mark: { glyph: 'dot' as const, state: 'waiting' as const }, meta: 'reviewer · main' },
    { id: 3, name: 'worker', mark: { glyph: 'dot' as const, state: 'busy' as const }, meta: 'worker · agent/worker' },
    { id: 4, name: 'tests', mark: { glyph: 'command' as const, state: 'running' as const }, meta: 'command' }
  ]
  const outlives = [{ id: 5, name: 'watcher', mark: { glyph: 'dot' as const, state: 'idle' as const }, meta: 'worker · main' }]

  it('S18: names each child that ends with its dot or glyph and what it is, then says the one that outlives it keeps running in a sentence, counts what it ends on its button and has Cancel in focus', () => {
    renderDialog({
      message: '“api-refactor” is still running on this PC’s host.',
      sessionNames: ['api-refactor', 'reviewer', 'worker', 'tests'],
      confirmLabel: 'End 4 sessions',
      ends,
      outlives
    })
    const dialog = screen.getByRole('alertdialog')
    const ending = dialog.querySelector('[data-confirm-children="ends"]')!
    expect([...ending.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'reviewerreviewer · main',
      'workerworker · agent/worker',
      'testscommand'
    ])
    // The dot of a child that needs you is warn; a command wears the terminal glyph.
    expect(ending.querySelector('[data-confirm-child="2"] [data-child-dot="waiting"]')?.className).toContain('bg-warn')
    expect(ending.querySelector('[data-confirm-child="3"] [data-child-dot="busy"]')).not.toBeNull()
    expect(ending.querySelector('[data-confirm-child="4"] [data-child-command="running"]')).not.toBeNull()

    expect(dialog.querySelector('[data-confirm-outlives]')?.textContent).toBe(
      'watcher was started to outlive it and keeps running.'
    )
    expect(dialog.querySelector('[data-confirm-children="outlives"]')).toBeNull()
    expect(dialog.textContent).not.toContain('Keep running')

    expect(within(dialog).getByRole('button', { name: 'End 4 sessions' })).toBeTruthy()
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))
    // The sessions are listed once, as children, not again as names.
    expect(dialog.querySelectorAll('li')).toHaveLength(3)
  })

  it('names only the children that outlive it, in a sentence, when none ends', () => {
    renderDialog({ sessionNames: ['api-refactor'], outlives })
    expect(document.querySelector('[data-confirm-children="ends"]')).toBeNull()
    expect(document.querySelector('[data-confirm-outlives]')).not.toBeNull()
  })

  it('names several that outlive it together', () => {
    const two = [...outlives, { ...outlives[0]!, id: 6, name: 'logger' }]
    renderDialog({ sessionNames: ['api-refactor'], outlives: two })
    expect(document.querySelector('[data-confirm-outlives]')?.textContent).toBe(
      'watcher and logger were started to outlive it and keep running.'
    )
  })

  it('says nothing of keeping running when no child does', () => {
    renderDialog({ sessionNames: ['api-refactor', 'reviewer'], ends: ends.slice(0, 1) })
    expect(screen.queryByText('Keep running')).toBeNull()
  })

  it('counts past six children rather than printing them', () => {
    const many = Array.from({ length: 8 }, (_, at) => ({ ...ends[1]!, id: 10 + at, name: `w${String(at)}` }))
    renderDialog({ sessionNames: [], ends: many })
    expect(document.querySelectorAll('[data-confirm-children="ends"] [data-confirm-child]')).toHaveLength(6)
    expect(screen.getByText('and 2 more sessions')).toBeTruthy()
  })
})
