import { render, waitFor, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings, type SessionRecord } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout, type Terminal } from './terminal.testkit'
import { ProjectShellPane } from './ProjectShellPane'
import { disposeShell, getShell } from './pterms'
import { TerminalPane } from './TerminalPane'
import { disposeTerminal, getTerminal } from './terminals'
import { applyTerminalSettings } from './termprefs'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * Terminal settings applied live: every open terminal takes them, sessions and
 * project shells alike, and only a change that moves cells tells a pty about
 * its grid - and then only a pty whose pane is on screen.
 */

const PROJECT = 'C:\\work\\alpha'
const SHELL_ID = 41
const BUILT_IN_STACK = '"Cascadia Mono", "Consolas", monospace'

const SESSION: SessionRecord = {
  id: 1,
  name: 'alpha',
  label: null,
  cwd: PROJECT,
  branch: 'main',
  projectPath: PROJECT,
  profileId: null,
  argv: [],
  claudeSessionId: null,
  status: 'running',
  startedAt: '2026-08-10T09:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null
}

const settings = (patch: Partial<AppSettings>): AppSettings => ({ ...DEFAULT_SETTINGS, ...patch })

function box(width: number, height: number): HTMLDivElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  layout.set(element, { width, height })
  return element
}

/** A session pane and a project shell, both on screen at 700x350. */
async function openBoth(): Promise<{ sessionBox: HTMLDivElement; sessionView: RenderResult }> {
  const sessionBox = box(700, 350)
  const shellBox = box(700, 350)
  const sessionView = render(<TerminalPane session={SESSION} active windowsBuild={null} onClose={vi.fn()} />, {
    container: sessionBox
  })
  render(
    <ProjectShellPane path={PROJECT} windowsBuild={null} visible shells={[]} heightPct={30} />,
    { container: shellBox }
  )
  await waitFor(() => expect(getShell(PROJECT)).toBeDefined())
  return { sessionBox, sessionView }
}

const sessionTerminal = (): Terminal => {
  const term = getTerminal(SESSION.id)?.term as unknown as Terminal | undefined
  if (term === undefined) throw new Error('no session terminal')
  return term
}

const shellTerminal = (): Terminal => {
  const term = getShell(PROJECT)?.term as unknown as Terminal | undefined
  if (term === undefined) throw new Error('no project shell')
  return term
}

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  bridge.answer('pterm:open', () => ({ id: SHELL_ID, shell: 'C:\\Shells\\pwsh.exe', requested: null, problem: null }))
  bridge.answer('pterm:close', () => undefined)
})

afterEach(async () => {
  disposeTerminal(SESSION.id)
  await disposeShell(PROJECT)
  document.body.replaceChildren()
  applyTerminalSettings(DEFAULT_SETTINGS)
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('terminal settings, applied live', () => {
  it('reach every open terminal, session panes and project shells alike', async () => {
    await openBoth()

    applyTerminalSettings(
      settings({
        terminalFontFamily: 'Iosevka',
        terminalFontSize: 20,
        terminalCursorStyle: 'bar',
        terminalCursorBlink: false,
        terminalScrollback: 2000
      })
    )

    const expected = {
      fontFamily: `"Iosevka", ${BUILT_IN_STACK}`,
      fontSize: 20,
      cursorStyle: 'bar',
      cursorBlink: false,
      scrollback: 2000
    }
    expect(sessionTerminal().options).toMatchObject(expected)
    expect(shellTerminal().options).toMatchObject(expected)

    // Cleared, the family goes back to the built-in stack alone.
    applyTerminalSettings(settings({ terminalFontFamily: null, terminalFontSize: 20 }))
    expect(sessionTerminal().options['fontFamily']).toBe(BUILT_IN_STACK)
    expect(shellTerminal().options['fontFamily']).toBe(BUILT_IN_STACK)
  })

  it('re-report the grid to the pty of a visible pane when the font size changes', async () => {
    await openBoth()
    // 700x350 at 14px with the fake 7x17.5 cell.
    expect(bridge.sent('session:resize')).toEqual([{ id: 1, cols: 100, rows: 20 }])
    expect(bridge.sent('pterm:resize')).toEqual([{ id: SHELL_ID, cols: 100, rows: 20 }])

    applyTerminalSettings(settings({ terminalFontSize: 20 }))

    // 700x350 at 20px with the fake 10x25 cell.
    expect(bridge.sent('session:resize')).toEqual([
      { id: 1, cols: 100, rows: 20 },
      { id: 1, cols: 70, rows: 14 }
    ])
    expect(bridge.sent('pterm:resize')).toEqual([
      { id: SHELL_ID, cols: 100, rows: 20 },
      { id: SHELL_ID, cols: 70, rows: 14 }
    ])
  })

  it('leave a hidden pane’s pty alone, and give it the new grid when it is shown', async () => {
    const { sessionBox, sessionView } = await openBoth()
    // Another tab comes to the front of this pane's group: its box collapses.
    layout.set(sessionBox, { width: 0, height: 0 })
    sessionView.rerender(<TerminalPane session={SESSION} active={false} windowsBuild={null} onClose={vi.fn()} />)

    applyTerminalSettings(settings({ terminalFontSize: 20 }))
    expect(bridge.sent('session:resize')).toEqual([{ id: 1, cols: 100, rows: 20 }])

    layout.set(sessionBox, { width: 700, height: 350 })
    sessionView.rerender(<TerminalPane session={SESSION} active windowsBuild={null} onClose={vi.fn()} />)
    expect(bridge.sent('session:resize')).toEqual([
      { id: 1, cols: 100, rows: 20 },
      { id: 1, cols: 70, rows: 14 }
    ])
  })

  it('resize no pty for a cursor, blink or scrollback change, or for an unchanged size', async () => {
    await openBoth()
    const before = { session: bridge.sent('session:resize').length, shell: bridge.sent('pterm:resize').length }

    applyTerminalSettings(settings({ terminalCursorStyle: 'underline' }))
    applyTerminalSettings(settings({ terminalCursorStyle: 'underline', terminalCursorBlink: false }))
    applyTerminalSettings(
      settings({ terminalCursorStyle: 'underline', terminalCursorBlink: false, terminalScrollback: 500 })
    )
    // The same settings again, as an unrelated write would deliver them.
    applyTerminalSettings(
      settings({ terminalCursorStyle: 'underline', terminalCursorBlink: false, terminalScrollback: 500, scanRoots: [PROJECT] })
    )
    // A size change that lands on the same size it already has.
    applyTerminalSettings(
      settings({ terminalCursorStyle: 'underline', terminalCursorBlink: false, terminalScrollback: 500, terminalFontSize: 14 })
    )

    expect(sessionTerminal().options).toMatchObject({ cursorStyle: 'underline', cursorBlink: false, scrollback: 500 })
    expect(shellTerminal().options).toMatchObject({ cursorStyle: 'underline', cursorBlink: false, scrollback: 500 })
    expect(bridge.sent('session:resize')).toHaveLength(before.session)
    expect(bridge.sent('pterm:resize')).toHaveLength(before.shell)
  })
})
