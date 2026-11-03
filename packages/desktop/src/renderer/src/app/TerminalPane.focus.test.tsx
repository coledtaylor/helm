import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@helm/core/types'
import { TerminalPane } from './TerminalPane'

/** The terminal a pane shows lives outside React; this is the part of it a pane touches. */
const terminal = vi.hoisted(() => ({
  refit: vi.fn(),
  term: { focus: vi.fn(), blur: vi.fn(), options: {} as Record<string, unknown> }
}))

vi.mock('./terminals', () => ({
  mountTerminal: vi.fn(() => terminal),
  getTerminal: () => terminal
}))

const SESSION: SessionRecord = {
  id: 3,
  name: 'alpha',
  label: null,
  cwd: 'C:\\work\\alpha',
  branch: 'main',
  projectPath: 'C:\\work\\alpha',
  profileId: null,
  argv: [],
  claudeSessionId: null,
  status: 'running',
  startedAt: '2026-10-02T10:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null
}

beforeEach(() => {
  terminal.refit.mockClear()
  terminal.term.focus.mockClear()
  terminal.term.blur.mockClear()
  terminal.term.options = { cursorBlink: true }
})

describe('TerminalPane', () => {
  it('takes the focus when its tab comes to the front, and not when the session’s row changes under it', () => {
    const onClose = vi.fn()
    const { rerender } = render(<TerminalPane session={SESSION} active={false} windowsBuild={null} onClose={onClose} />)
    expect(terminal.term.focus).not.toHaveBeenCalled()

    rerender(<TerminalPane session={SESSION} active windowsBuild={null} onClose={onClose} />)
    expect(terminal.refit).toHaveBeenCalledTimes(1)
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)

    // A rename, or anything else that hands the pane a new row, leaves the
    // focus where the user put it - in the rename field, say.
    rerender(<TerminalPane session={{ ...SESSION, label: 'review' }} active windowsBuild={null} onClose={onClose} />)
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps an ended session’s pane, stops its input, and offers the close', async () => {
    const onClose = vi.fn()
    const ended: SessionRecord = { ...SESSION, status: 'exited', exitCode: 0, durationMs: 4_000 }
    render(<TerminalPane session={ended} active windowsBuild={null} onClose={onClose} />)

    expect(terminal.term.options).toMatchObject({ cursorBlink: false, disableStdin: true })
    expect(terminal.term.blur).toHaveBeenCalled()
    expect(terminal.term.focus).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Session ended')

    await userEvent.click(screen.getByRole('button', { name: 'Close tab' }))
    expect(onClose).toHaveBeenCalledWith(3)
  })

  it('keeps a session lost with its host on its last screen, dimmed with input off, and offers Restore', async () => {
    const onRestore = vi.fn()
    const lostSession: SessionRecord = {
      ...SESSION,
      status: 'lost',
      exitCode: null
    }
    const { container } = render(
      <TerminalPane
        session={lostSession}
        active
        windowsBuild={null}
        onClose={vi.fn()}
        lost={{ hostName: 'this PC’s host', restoreReady: true, onRestore }}
      />
    )

    expect(terminal.term.options).toMatchObject({
      cursorBlink: false,
      disableStdin: true
    })
    expect(terminal.term.focus).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Session lost on this PC’s host')
    expect(container.querySelector('[data-terminal-lost]')?.className).toContain('opacity-60')

    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onRestore).toHaveBeenCalledTimes(1)
  })

  it('keeps a running session’s screen dimmed with input off while its host is gone, and turns input back on when the next host takes it back', () => {
    const onClose = vi.fn()
    const { container, rerender } = render(
      <TerminalPane session={SESSION} active windowsBuild={null} onClose={onClose} hostGone />
    )

    expect(terminal.term.options).toMatchObject({ cursorBlink: false, disableStdin: true })
    expect(terminal.term.blur).toHaveBeenCalled()
    expect(terminal.term.focus).not.toHaveBeenCalled()
    // Still running: no ended bar, only the host-stopped notice the window shows.
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('[data-terminal-waiting]')?.className).toContain('opacity-60')

    rerender(<TerminalPane session={SESSION} active windowsBuild={null} onClose={onClose} hostGone={false} />)

    expect(terminal.term.options).toMatchObject({ cursorBlink: true, disableStdin: false })
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-terminal-waiting]')).toBeNull()
    expect(container.querySelector('.opacity-60')).toBeNull()
  })
})
