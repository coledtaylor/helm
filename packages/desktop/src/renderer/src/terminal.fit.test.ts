import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminal } from './terminal'

/**
 * The pane a terminal sits in, and the fit the addon would make of it.
 *
 * xterm and its addons are stood in for: jsdom does no layout, so the real
 * FitAddon has nothing to measure. What is under test is Helm's own rule
 * around it - when a fit may happen and when the pty is told - and the
 * stand-in fits the way the addon does, a grid of whatever the box holds and
 * never less than one cell, which is how a hidden 0x0 pane becomes a 1-row
 * grid.
 */
const stage = vi.hoisted(() => ({
  box: { width: 0, height: 0 },
  observers: [] as (() => void)[],
  fits: 0
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols: number
    rows: number
    options: Record<string, unknown>
    unicode = { activeVersion: '' }
    constructor(options: { cols: number; rows: number }) {
      this.cols = options.cols
      this.rows = options.rows
      this.options = { ...options }
    }
    loadAddon(addon: { activate?: (term: Terminal) => void }): void {
      addon.activate?.(this)
    }
    open(): void {}
    onData(): void {}
    onBinary(): void {}
    attachCustomKeyEventHandler(): void {}
    focus(): void {}
    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
    }
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    private term: { resize: (cols: number, rows: number) => void } | null = null
    activate(term: { resize: (cols: number, rows: number) => void }): void {
      this.term = term
    }
    fit(): void {
      stage.fits += 1
      this.term?.resize(
        Math.max(2, Math.floor(stage.box.width / 10)),
        Math.max(1, Math.floor(stage.box.height / 20))
      )
    }
  }
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { dispose(): void {} } }))
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      throw new Error('no WebGL in jsdom')
    }
  }
}))

vi.stubGlobal(
  'ResizeObserver',
  class {
    constructor(callback: () => void) {
      stage.observers.push(callback)
    }
    observe(): void {}
    disconnect(): void {}
  }
)

afterEach(() => {
  stage.box = { width: 0, height: 0 }
  stage.observers.length = 0
  stage.fits = 0
})

function pane(): HTMLElement {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => ({ ...stage.box, x: 0, y: 0, top: 0, left: 0, right: stage.box.width, bottom: stage.box.height, toJSON: () => ({}) }) as DOMRect
  return container
}

describe('a session terminal’s fit', () => {
  it('never fits a hidden pane, keeps its grid while backgrounded, and tells the pty only about a real change', () => {
    const onResize = vi.fn()
    // Opened in a pane that is not on screen yet.
    const host = createTerminal(
      pane(),
      { cols: 100, rows: 30, fit: true },
      {
        onInput: vi.fn(),
        onResize,
        readClipboard: () => Promise.resolve(''),
        writeClipboard: () => Promise.resolve(),
        openLink: vi.fn()
      }
    )
    expect(stage.fits).toBe(0)
    expect(onResize).not.toHaveBeenCalled()
    expect([host.term.cols, host.term.rows]).toEqual([100, 30])

    // On screen: fitted, and the pty told once.
    stage.box = { width: 800, height: 600 }
    host.refit()
    expect(onResize.mock.calls).toEqual([[80, 30]])
    host.refit()
    for (const observe of stage.observers) observe()
    expect(onResize).toHaveBeenCalledTimes(1)

    // Behind another tab its box is 0x0: no fit, nothing sent, the grid kept.
    stage.box = { width: 0, height: 0 }
    const fitsBefore = stage.fits
    host.refit()
    for (const observe of stage.observers) observe()
    expect(stage.fits).toBe(fitsBefore)
    expect(onResize).toHaveBeenCalledTimes(1)
    expect([host.term.cols, host.term.rows]).toEqual([80, 30])

    // Back at the size it left at: nothing for the pty to redraw.
    stage.box = { width: 800, height: 600 }
    host.refit()
    expect(onResize).toHaveBeenCalledTimes(1)

    // A window resize while it is in front is a real change, and it is sent.
    stage.box = { width: 1000, height: 600 }
    for (const observe of stage.observers) observe()
    expect(onResize.mock.calls).toEqual([
      [80, 30],
      [100, 30]
    ])
  })
})
