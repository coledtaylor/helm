import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type SessionRecord } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout, Terminal } from './terminal.testkit'
import { TerminalPane } from './TerminalPane'
import { disposeTerminal, estimateGrid, getTerminal } from './terminals'
import { applyTerminalSettings } from './termprefs'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * Session terminals: the grid a pty is opened at before its terminal exists,
 * and a terminal's lifetime, which is its tab's rather than its component's.
 */

const SAMPLE = 'W'.repeat(32)

/** What the font measures in this "machine": a cell's advance and line box. */
const FONT: Record<number, { advance: number; line: number }> = {
  14: { advance: 8.7, line: 16.2 },
  20: { advance: 11.72, line: 23.4 }
}

/** Every probe `estimateGrid` measured, with what it was styled as. */
let probes: Array<{ tag: string; fontFamily: string; fontSize: string; whiteSpace: string }> = []

function measureFonts(): void {
  layout.text((element) => {
    if (element.textContent !== SAMPLE) return null
    probes.push({
      tag: element.tagName,
      fontFamily: element.style.fontFamily,
      fontSize: element.style.fontSize,
      whiteSpace: element.style.whiteSpace
    })
    const metrics = FONT[Number.parseFloat(element.style.fontSize)]
    if (metrics === undefined) return { width: 0, height: 0 }
    return { width: metrics.advance * SAMPLE.length, height: metrics.line }
  })
}

function pane(width: number, height: number): HTMLDivElement {
  const box = document.createElement('div')
  document.body.appendChild(box)
  layout.set(box, { width, height })
  return box
}

function setDevicePixelRatio(ratio: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true })
}

function session(id: number, fields: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    name: `session-${String(id)}`,
    label: null,
    cwd: 'C:\\work\\alpha',
    branch: 'main',
    projectPath: 'C:\\work\\alpha',
    profileId: null,
    argv: [],
    claudeSessionId: null,
    status: 'running',
    startedAt: '2026-08-10T09:00:00.000Z',
    endedAt: null,
    durationMs: null,
    exitCode: null,
    ...fields
  }
}

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  probes = []
  measureFonts()
  setDevicePixelRatio(1)
})

afterEach(() => {
  for (const id of [1, 2, 3]) disposeTerminal(id)
  document.body.replaceChildren()
  applyTerminalSettings(DEFAULT_SETTINGS)
  layout.text(null)
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('estimateGrid', () => {
  it('measures the font with a span in the document, styled as the terminal is', () => {
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontFamily: 'Iosevka', terminalFontSize: 20 })

    estimateGrid(pane(1010, 610))

    expect(probes).toHaveLength(1)
    expect(probes[0]?.tag).toBe('SPAN')
    expect(probes[0]?.fontSize).toBe('20px')
    expect(probes[0]?.fontFamily).toMatch(/^"?Iosevka"?, "?Cascadia Mono"?/)
    expect(probes[0]?.whiteSpace).toBe('pre')
    // The probe is gone again: nothing is left in the document.
    expect(document.body.querySelectorAll('span')).toHaveLength(0)
  })

  it('floors the cell width and rounds the row up, and reserves the 14px ruler', () => {
    // 8.7px advance floors to 8; a 16.2px line rounds up to 17.
    // (1000 - 14) / 8 = 123.25 and 600 / 17 = 35.3.
    expect(estimateGrid(pane(1000, 600))).toEqual({ cols: 123, rows: 35 })
  })

  it('quantises to device pixels at the configured font size', () => {
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: 20 })
    setDevicePixelRatio(1.5)

    // 11.72px x 1.5 = 17.58 device px, floored to 17 = 11.33 CSS px across;
    // 23.4px x 1.5 = 35.1, rounded up to 36 = 24 CSS px down.
    // (1010 - 14) / 11.33 = 87.9 and 610 / 24 = 25.4.
    expect(estimateGrid(pane(1010, 610))).toEqual({ cols: 87, rows: 25 })
  })

  it('reserves no ruler when there is no scrollback to scroll', () => {
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalScrollback: 0 })

    expect(estimateGrid(pane(1000, 600))).toEqual({ cols: 125, rows: 35 })
  })

  it('guesses 100x30 when there is nothing to measure', () => {
    expect(estimateGrid(null)).toEqual({ cols: 100, rows: 30 })
    expect(estimateGrid(pane(0, 0))).toEqual({ cols: 100, rows: 30 })

    layout.text(() => ({ width: 0, height: 0 }))
    expect(estimateGrid(pane(1000, 600))).toEqual({ cols: 100, rows: 30 })
  })
})

describe('a session terminal', () => {
  const resizes = (): unknown[] => bridge.sent('session:resize')

  it('outlives its pane: an unmount keeps it, and closing the tab ends it', () => {
    const first = render(<TerminalPane session={session(1)} active windowsBuild={null} onClose={vi.fn()} />)
    const host = getTerminal(1)
    expect(host).toBeDefined()
    expect(Terminal.instances.filter((t) => !t.disposed)).toHaveLength(1)

    first.unmount()
    expect(getTerminal(1)).toBe(host)
    expect(Terminal.instances.at(-1)?.disposed).toBe(false)

    // Output that arrives while no pane shows it still lands in the terminal.
    bridge.emit('session:data', { id: 1, data: 'while away' })
    expect(Terminal.instances.at(-1)?.written).toContain('while away')

    // Shown again: the same terminal moves into the new pane, nothing is rebuilt.
    const created = Terminal.instances.length
    render(<TerminalPane session={session(1)} active windowsBuild={null} onClose={vi.fn()} />)
    expect(Terminal.instances).toHaveLength(created)
    expect(host?.element.isConnected).toBe(true)

    disposeTerminal(1)
    expect(getTerminal(1)).toBeUndefined()
    expect(Terminal.instances.at(-1)?.disposed).toBe(true)
    expect(host?.element.isConnected).toBe(false)
  })

  it('keeps its grid while hidden at 0x0, and re-measures when it is shown', () => {
    const box = pane(700, 350)
    const view = render(<TerminalPane session={session(2)} active windowsBuild={null} onClose={vi.fn()} />, {
      container: box
    })
    // 700x350 at 14px, with the fake cell of 7x17.5: 100 columns by 20 rows.
    expect(resizes()).toEqual([{ id: 2, cols: 100, rows: 20 }])

    // Another tab comes to the front: the pane's box collapses.
    layout.set(box, { width: 0, height: 0 })
    view.rerender(<TerminalPane session={session(2)} active={false} windowsBuild={null} onClose={vi.fn()} />)
    FakeResizeObserver.notifyAll()
    expect(resizes()).toHaveLength(1)
    expect(getTerminal(2)?.term.cols).toBe(100)
    expect(getTerminal(2)?.term.rows).toBe(20)

    // The window was resized while it was hidden; showing it reports that.
    layout.set(box, { width: 1400, height: 350 })
    view.rerender(<TerminalPane session={session(2)} active windowsBuild={null} onClose={vi.fn()} />)
    expect(resizes()).toEqual([
      { id: 2, cols: 100, rows: 20 },
      { id: 2, cols: 200, rows: 20 }
    ])
  })

  it('opens hidden without ever sending the pty a grid', () => {
    const box = pane(0, 0)
    render(<TerminalPane session={session(3)} active={false} windowsBuild={null} onClose={vi.fn()} />, {
      container: box
    })
    FakeResizeObserver.notifyAll()

    expect(resizes()).toEqual([])
  })
})
