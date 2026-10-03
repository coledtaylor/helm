import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DEFAULT_SETTINGS } from '@helm/core/types'
import { applyPrefs, createTerminal, terminalFontStack, type TerminalHooks, type TerminalPrefs } from './terminal'
import { applyTerminalSettings } from './app/termprefs'
import { FakeResizeObserver, FitAddon, layout, Terminal } from './app/terminal.testkit'

vi.mock('@xterm/xterm', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./app/terminal.testkit'))

/**
 * `createTerminal` and `applyPrefs`: the preferences a terminal is built with,
 * and the rule that a pty hears about a grid only when there is a real box to
 * fit and the answer changed (SPEC 8.3).
 */

const BUILT_IN_STACK = '"Cascadia Mono", "Consolas", monospace'

function hooks(): TerminalHooks & { onResize: Mock<(cols: number, rows: number) => void> } {
  return {
    onInput: vi.fn(),
    onResize: vi.fn<(cols: number, rows: number) => void>(),
    readClipboard: () => Promise.resolve(''),
    writeClipboard: () => Promise.resolve()
  }
}

function container(): HTMLDivElement {
  const box = document.createElement('div')
  document.body.appendChild(box)
  return box
}

const latest = (): Terminal => {
  const terminal = Terminal.instances.at(-1)
  if (terminal === undefined) throw new Error('no terminal was created')
  return terminal
}

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Terminal.instances = []
  FitAddon.instances = []
})

afterEach(() => {
  document.body.replaceChildren()
  applyTerminalSettings(DEFAULT_SETTINGS)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createTerminal preferences', () => {
  it('builds the terminal with the preferences it is handed', () => {
    const prefs: TerminalPrefs = {
      fontFamily: `"Iosevka", ${BUILT_IN_STACK}`,
      fontSize: 18,
      cursorStyle: 'bar',
      cursorBlink: false,
      scrollback: 2500
    }
    createTerminal(container(), { cols: 80, rows: 24, fit: false }, hooks(), prefs)

    expect(latest().options).toMatchObject({
      fontFamily: `"Iosevka", ${BUILT_IN_STACK}`,
      fontSize: 18,
      cursorStyle: 'bar',
      cursorBlink: false,
      scrollback: 2500
    })
  })

  it('uses the built-in defaults when it is handed none, whatever the settings say', () => {
    // The spike page's call: three arguments. A settings change reaching it
    // would make the fidelity drivers measure a configuration nobody proved.
    applyTerminalSettings({
      ...DEFAULT_SETTINGS,
      terminalFontFamily: 'Iosevka',
      terminalFontSize: 20,
      terminalCursorStyle: 'underline',
      terminalCursorBlink: false,
      terminalScrollback: 500
    })

    createTerminal(container(), { cols: 80, rows: 24, fit: false }, hooks())

    expect(latest().options).toMatchObject({
      fontFamily: BUILT_IN_STACK,
      fontSize: 14,
      cursorStyle: 'block',
      cursorBlink: true,
      scrollback: 10000
    })
  })
})

describe('terminalFontStack', () => {
  it('puts a chosen family in front of the built-in stack, never instead of it', () => {
    expect(terminalFontStack('Fira Code')).toBe(`"Fira Code", ${BUILT_IN_STACK}`)
    expect(terminalFontStack('  JetBrains Mono  ')).toBe(`"JetBrains Mono", ${BUILT_IN_STACK}`)
  })

  it('is the built-in stack when nothing is chosen', () => {
    expect(terminalFontStack(null)).toBe(BUILT_IN_STACK)
    expect(terminalFontStack('')).toBe(BUILT_IN_STACK)
    expect(terminalFontStack('   ')).toBe(BUILT_IN_STACK)
  })
})

describe('fitting a terminal to its pane', () => {
  it('never fits a hidden 0x0 pane, and reports the grid once it has a box', () => {
    const box = container()
    layout.set(box, { width: 0, height: 0 })
    const h = hooks()
    createTerminal(box, { cols: 100, rows: 30, fit: true }, h)

    FakeResizeObserver.notifyAll()
    expect(FitAddon.instances[0]?.fits).toBe(0)
    expect(h.onResize).not.toHaveBeenCalled()

    // 700x350 at 14px is 100 cells of 7px by 20 rows of 17.5px.
    layout.set(box, { width: 700, height: 350 })
    FakeResizeObserver.notifyAll()
    expect(h.onResize.mock.calls).toEqual([[100, 20]])
  })

  it('tells the pty only when the grid actually changed', () => {
    const box = container()
    layout.set(box, { width: 700, height: 350 })
    const h = hooks()
    createTerminal(box, { cols: 100, rows: 30, fit: true }, h)
    expect(h.onResize.mock.calls).toEqual([[100, 20]])

    FakeResizeObserver.notifyAll()
    layout.set(box, { width: 703, height: 351 })
    FakeResizeObserver.notifyAll()
    expect(h.onResize).toHaveBeenCalledTimes(1)

    layout.set(box, { width: 1400, height: 350 })
    FakeResizeObserver.notifyAll()
    expect(h.onResize.mock.calls).toEqual([[100, 20], [200, 20]])
  })

  it('stops observing the pane when it is disposed', () => {
    const box = container()
    layout.set(box, { width: 700, height: 350 })
    const h = hooks()
    const host = createTerminal(box, { cols: 100, rows: 30, fit: true }, h)

    host.dispose()
    layout.set(box, { width: 1400, height: 350 })
    FakeResizeObserver.notifyAll()

    expect(latest().disposed).toBe(true)
    expect(h.onResize).toHaveBeenCalledTimes(1)
  })
})

describe('applyPrefs', () => {
  const PREFS: TerminalPrefs = {
    fontFamily: BUILT_IN_STACK,
    fontSize: 14,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10000
  }

  function visible(): { host: ReturnType<typeof createTerminal>; h: ReturnType<typeof hooks> } {
    const box = container()
    layout.set(box, { width: 700, height: 350 })
    const h = hooks()
    const host = createTerminal(box, { cols: 100, rows: 30, fit: true }, h, PREFS)
    return { host, h }
  }

  it('re-reports the grid when the font size changes', () => {
    const { host, h } = visible()

    applyPrefs(host, { ...PREFS, fontSize: 20 })

    expect(latest().options['fontSize']).toBe(20)
    // 700x350 at 20px is 70 cells of 10px by 14 rows of 25px.
    expect(h.onResize.mock.calls).toEqual([[100, 20], [70, 14]])
  })

  it('applies cursor, blink and scrollback changes without resizing the pty', () => {
    const { host, h } = visible()

    applyPrefs(host, { ...PREFS, cursorStyle: 'underline', cursorBlink: false, scrollback: 500 })

    expect(latest().options).toMatchObject({ cursorStyle: 'underline', cursorBlink: false, scrollback: 500 })
    expect(h.onResize).toHaveBeenCalledTimes(1)
  })

  it('does not make the cursor of an ended terminal blink again', () => {
    const { host } = visible()
    host.term.options.cursorBlink = false
    host.term.options.disableStdin = true

    applyPrefs(host, { ...PREFS, cursorBlink: true, fontSize: 16 })

    expect(latest().options['cursorBlink']).toBe(false)
    expect(latest().options['fontSize']).toBe(16)
  })
})
