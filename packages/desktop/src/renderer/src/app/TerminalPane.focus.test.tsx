import { fireEvent, render, screen } from '@testing-library/react'
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

  it('S38: a command child the host ended has an ended bar that says it was stopped, not the number the system gave it', () => {
    const stopped: SessionRecord = {
      ...SESSION,
      status: 'exited',
      command: 'pnpm test',
      stopped: true,
      exitCode: 2147483647,
      durationMs: 4_000
    }
    render(<TerminalPane session={stopped} active windowsBuild={null} onClose={vi.fn()} />)
    const bar = screen.getByRole('status')
    expect(bar.textContent).toContain('Stopped')
    expect(bar.textContent).not.toContain('Session exited with code')
    expect(bar.className).toContain('text-fg-muted')
    expect(bar.className).not.toContain('danger')
  })

  it('S38: a command child that exited on its own gives its exit code in the bar, wrapped as the system reports it', () => {
    const crashed: SessionRecord = { ...SESSION, status: 'exited', command: 'pnpm test', exitCode: -1073741819 }
    const { rerender } = render(<TerminalPane session={crashed} active windowsBuild={null} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Session exited with code -1073741819')
    expect(screen.getByRole('status').className).toContain('text-danger')

    rerender(<TerminalPane session={{ ...crashed, exitCode: 0 }} active windowsBuild={null} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Session ended')
    expect(screen.getByRole('status').className).not.toContain('danger')
  })

  it('S38: an agent child the host ended, and a session that is not a child, keep the bar as it is', () => {
    const agent: SessionRecord = { ...SESSION, status: 'exited', parentId: 1, stopped: true, exitCode: 143 }
    const { rerender } = render(<TerminalPane session={agent} active windowsBuild={null} onClose={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Session exited with code 143')

    rerender(
      <TerminalPane session={{ ...SESSION, status: 'exited', exitCode: 2 }} active windowsBuild={null} onClose={vi.fn()} />
    )
    expect(screen.getByRole('status').textContent).toContain('Session exited with code 2')
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

  it('S7: a remote session whose host link dropped keeps its last screen dimmed with input off under the lost-connection banner, and takes input again once the link is back', async () => {
    const onReconnect = vi.fn()
    const deploy: SessionRecord = { ...SESSION, name: 'deploy', cwd: '/home/you/work/infra' }
    const lost = { hostName: 'build-box', lastLine: null, tryLine: 'ssh build-box floti connect', onReconnect }
    const { container, rerender } = render(
      <TerminalPane session={deploy} host="h-build" active windowsBuild={null} onClose={vi.fn()} hostLost={lost} />
    )

    // Keys go nowhere: the terminal takes none, and nothing it shows blinks.
    expect(terminal.term.options).toMatchObject({ cursorBlink: false, disableStdin: true })
    expect(terminal.term.blur).toHaveBeenCalled()
    expect(terminal.term.focus).not.toHaveBeenCalled()
    expect(container.querySelector('[data-terminal-waiting]')?.className).toContain('opacity-60')
    expect(screen.getByRole('status').textContent).toContain('Lost the connection to build-box. deploy keeps running there.')
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)

    // The link is back: the banner goes by itself and the session takes keys again.
    rerender(<TerminalPane session={deploy} host="h-build" active windowsBuild={null} onClose={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(container.querySelector('[data-terminal-waiting]')).toBeNull()
    expect(terminal.term.options).toMatchObject({ cursorBlink: true, disableStdin: false })
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)
  })

  it('as a card in its parent’s tab, never takes the keyboard by showing, and takes it when its terminal is pressed', async () => {
    const child: SessionRecord = { ...SESSION, id: 7, name: 'reviewer', parentId: 3 }
    const { container, rerender } = render(<TerminalPane card session={child} active windowsBuild={null} onClose={vi.fn()} />)
    rerender(<TerminalPane card session={child} active windowsBuild={null} onClose={vi.fn()} />)
    // The parent keeps the caret: the card was refit for its size and nothing more.
    expect(terminal.refit).toHaveBeenCalled()
    expect(terminal.term.focus).not.toHaveBeenCalled()

    await userEvent.click(container.querySelector('[data-terminal-card]')!)
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)
  })

  it('as a card, keeps the keyboard it was given when the press lands on the gutter xterm does not cover', () => {
    const child: SessionRecord = { ...SESSION, id: 7, name: 'reviewer', parentId: 3 }
    const { container } = render(<TerminalPane card session={child} active windowsBuild={null} onClose={vi.fn()} />)
    const gutter = container.querySelector('[data-terminal-card]')!

    // Not cancelled, the browser would move the focus to the page once the press is over.
    expect(fireEvent.mouseDown(gutter)).toBe(false)
    expect(terminal.term.focus).toHaveBeenCalledTimes(1)
    // Inside xterm's own area the press is xterm's, and nothing is cancelled.
    expect(fireEvent.mouseDown(gutter.firstElementChild!)).toBe(true)
    expect(terminal.term.focus).toHaveBeenCalledTimes(2)
  })

  it('as a card, says nothing in a bar of its own and takes no press on an ended session’s last screen', async () => {
    const ended: SessionRecord = { ...SESSION, id: 7, status: 'exited', exitCode: 0, durationMs: 4_000, parentId: 3 }
    const { container } = render(<TerminalPane card session={ended} active windowsBuild={null} onClose={vi.fn()} />)

    // Its header says how it ended, so the pane draws no bar, and the screen takes no keys.
    expect(screen.queryByRole('status')).toBeNull()
    expect(terminal.term.options).toMatchObject({ cursorBlink: false, disableStdin: true })
    await userEvent.click(container.querySelector('[data-terminal-card]')!)
    expect(terminal.term.focus).not.toHaveBeenCalled()
  })

  it('S5: a remote session whose host cannot be reached shows the last line ssh wrote and the line to try by hand on its tab', () => {
    render(
      <TerminalPane
        session={SESSION}
        host="h-build"
        active
        windowsBuild={null}
        onClose={vi.fn()}
        hostLost={{
          hostName: 'build-box',
          lastLine: 'ssh: connect to host build-box port 22: Connection timed out',
          tryLine: 'ssh build-box floti connect',
          onReconnect: vi.fn()
        }}
      />
    )
    const banner = screen.getByRole('status')
    expect(banner.querySelector('[data-host-lost-line]')?.textContent).toBe(
      'ssh: connect to host build-box port 22: Connection timed out'
    )
    expect(banner.querySelector('[data-host-lost-try]')?.textContent).toBe('ssh build-box floti connect')
  })
})
