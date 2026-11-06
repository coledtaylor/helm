import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, familyRoom, gridOf, PARENT_GUTTER_PX, type SessionRecord } from '@helm/core/types'
import { bridge, remoteBridge } from './bridge.testkit'
import { FakeResizeObserver, layout, Terminal } from './terminal.testkit'
import { TerminalPane } from './TerminalPane'
import {
  disposeTerminal,
  estimateGrid,
  getTerminal,
  mountTerminal,
  terminalCell,
  terminalScrollback
} from './terminals'
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

describe('the cell the family view’s room rule reads', () => {
  it('is the cell estimateGrid measures, so the rule and the terminal count the same columns and rows at the default font and a larger one', () => {
    for (const [fontSize, ratio] of [
      [14, 1],
      [20, 1],
      [20, 1.5]
    ] as const) {
      applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: fontSize })
      setDevicePixelRatio(ratio)
      const cell = terminalCell()
      expect(cell).not.toBeNull()
      expect(estimateGrid(pane(1440, 860))).toEqual(gridOf({ width: 1440, height: 860 }, cell!, terminalScrollback()))
    }
  })

  it('is larger at a larger font, so the same floors in columns and rows take more pixels', () => {
    const small = terminalCell()
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: 20 })
    const large = terminalCell()
    expect(small).toEqual({ width: 8, height: 17 })
    expect(large).toEqual({ width: 11, height: 24 })
  })

  it('judges a pane by the grid a terminal opened in its 55% gets: the parent keeps what estimateGrid says of that share, less its gutter', () => {
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: 20 })
    const room = familyRoom({
      body: { width: 1800, height: 900 },
      cell: terminalCell()!,
      headerHeight: 26,
      scrollback: terminalScrollback(),
      children: 2
    })
    expect(room.fits).toBe(true)
    if (!room.fits) return
    expect(room.parent).toEqual(estimateGrid(pane(1800 * 0.55 - 2 * PARENT_GUTTER_PX, 900 - 2 * PARENT_GUTTER_PX)))
  })

  it('is null where nothing can be measured, so a pane is not judged by a guess', () => {
    layout.text(() => ({ width: 0, height: 0 }))
    expect(terminalCell()).toBeNull()
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

  it('takes the keyboard when its tab opens, and a card made beside a parent leaves it with the parent', () => {
    const focus = vi.spyOn(Terminal.prototype, 'focus')
    render(<TerminalPane session={session(1)} active windowsBuild={null} onClose={vi.fn()} />)
    expect(focus).toHaveBeenCalled()
    focus.mockClear()

    render(<TerminalPane card session={session(2, { parentId: 1 })} active windowsBuild={null} onClose={vi.fn()} />)
    expect(Terminal.instances.filter((t) => !t.disposed)).toHaveLength(2)
    expect(focus).not.toHaveBeenCalled()
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

  it('is kept by host and id: build-box’s session 1 and this PC’s session 1 are two terminals, each streaming over its own host’s bridge', () => {
    const build = remoteBridge('h-build')
    const mine = mountTerminal(1, pane(700, 350), { windowsBuild: null })
    const mineTerm = Terminal.instances.at(-1)!
    const theirs = mountTerminal(1, pane(700, 350), { windowsBuild: null }, 'h-build')
    const theirTerm = Terminal.instances.at(-1)!
    expect(theirs).not.toBe(mine)
    expect(getTerminal(1)).toBe(mine)
    expect(getTerminal(1, 'h-build')).toBe(theirs)

    // Output is heard on each host's own bridge, and lands only in that host's terminal.
    build.emit('session:data', { id: 1, data: 'from build-box' })
    bridge.emit('session:data', { id: 1, data: 'from this PC' })
    expect(theirTerm.written).toContain('from build-box')
    expect(theirTerm.written).not.toContain('from this PC')
    expect(mineTerm.written).toContain('from this PC')
    expect(mineTerm.written).not.toContain('from build-box')

    // Keys typed in build-box's terminal go to build-box only.
    theirTerm.type('ls\r')
    expect(build.sent('session:input')).toEqual([{ id: 1, data: 'ls\r' }])
    expect(bridge.sent('session:input')).toEqual([])
    mineTerm.type('pwd\r')
    expect(bridge.sent('session:input')).toEqual([{ id: 1, data: 'pwd\r' }])

    disposeTerminal(1, 'h-build')
    expect(getTerminal(1, 'h-build')).toBeUndefined()
    expect(getTerminal(1)).toBe(mine)
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
