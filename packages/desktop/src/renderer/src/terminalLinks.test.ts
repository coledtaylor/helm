import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IBufferRange, ILinkHandler } from '@xterm/xterm'
import { createTerminal, type TerminalHost } from './terminal'
import { LINK_CHORD_CLASS } from './terminalLinks'
import { FakeResizeObserver, layout, Terminal, WebLinksAddon } from './app/terminal.testkit'

vi.mock('@xterm/xterm', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./app/terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./app/terminal.testkit'))

/**
 * Ctrl+click on a link in a terminal (`terminalLinks.ts`).
 *
 * The fake xterm cannot find links on a canvas, so the tests play its part:
 * they call the hover and leave callbacks xterm calls as the pointer crosses a
 * link, then press the mouse on the screen the way a person would. What is
 * under test is what Helm does with a press - open the link and keep the press
 * from the program, or leave it alone.
 */

const DOCS = 'https://example.test/docs'
const BARE = 'https://example.test/bare'
const RANGE: IBufferRange = { start: { x: 1, y: 1 }, end: { x: 13, y: 1 } }

interface Pane {
  host: TerminalHost
  term: Terminal
  screen: Element
  /** Presses that reached xterm's own screen: what the program would be sent. */
  reached: ReturnType<typeof vi.fn>
  opened: string[]
  /** xterm's OSC 8 hyperlinks report through the link handler option. */
  osc: ILinkHandler
  /** Any other web address on screen is the web links addon's. */
  web: WebLinksAddon
}

function pane(): Pane {
  const box = document.createElement('div')
  document.body.appendChild(box)
  const opened: string[] = []
  const host = createTerminal(
    box,
    { cols: 80, rows: 24, fit: false },
    {
      onInput: vi.fn(),
      onResize: vi.fn(),
      readClipboard: () => Promise.resolve(''),
      writeClipboard: () => Promise.resolve(),
      openLink: (url) => opened.push(url)
    }
  )
  const term = Terminal.instances.at(-1)
  const web = WebLinksAddon.instances.at(-1)
  const screen = box.querySelector('.xterm-screen')
  if (term === undefined || web === undefined || screen === null) throw new Error('the terminal did not open')
  const reached = vi.fn()
  screen.addEventListener('mousedown', reached)
  return { host, term, screen, reached, opened, osc: term.options['linkHandler'] as ILinkHandler, web }
}

const pointer = (init: MouseEventInit = {}): MouseEvent => new MouseEvent('mousemove', init)

/** A press on the screen, as a mouse makes it. Returns the event, to ask whether it was cancelled. */
function press(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init })
  target.dispatchEvent(event)
  return event
}

const chordSet = (): boolean => document.documentElement.classList.contains(LINK_CHORD_CLASS)

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Terminal.instances = []
  WebLinksAddon.instances = []
})

afterEach(() => {
  window.dispatchEvent(new Event('blur'))
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Ctrl+click on a link', () => {
  it('opens a hyperlink once, and the press never reaches the program', () => {
    const { term, screen, reached, opened, osc } = pane()
    const focus = vi.spyOn(term, 'focus')

    osc.hover?.(pointer(), DOCS, RANGE)
    const event = press(screen, { ctrlKey: true })

    expect(opened).toEqual([DOCS])
    expect(reached).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('opens the link once for a double-click, and keeps both presses from the program', () => {
    const { screen, reached, opened, osc } = pane()

    osc.hover?.(pointer(), DOCS, RANGE)
    press(screen, { ctrlKey: true, detail: 1 })
    press(screen, { ctrlKey: true, detail: 2 })

    expect(opened).toEqual([DOCS])
    expect(reached).not.toHaveBeenCalled()
  })

  it('opens a web address found on screen the same way', () => {
    const { screen, reached, opened, web } = pane()

    web.options.hover?.(pointer(), BARE)
    press(screen, { ctrlKey: true })

    expect(opened).toEqual([BARE])
    expect(reached).not.toHaveBeenCalled()
  })

  it('leaves a plain click on a link to the program', () => {
    const { screen, reached, opened, osc } = pane()

    osc.hover?.(pointer(), DOCS, RANGE)
    const event = press(screen)

    expect(opened).toEqual([])
    expect(reached).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves Ctrl with another modifier, and Ctrl with another button, to the program', () => {
    const { screen, reached, opened, osc } = pane()

    osc.hover?.(pointer(), DOCS, RANGE)
    press(screen, { ctrlKey: true, shiftKey: true })
    press(screen, { ctrlKey: true, altKey: true })
    press(screen, { ctrlKey: true, button: 1 })
    press(screen, { ctrlKey: true, button: 2 })

    expect(opened).toEqual([])
    expect(reached).toHaveBeenCalledTimes(4)
  })

  it('leaves a Ctrl+click to the program once the pointer is off the link', () => {
    const { screen, reached, opened, osc, web } = pane()

    press(screen, { ctrlKey: true })
    osc.hover?.(pointer(), DOCS, RANGE)
    osc.leave?.(pointer(), DOCS, RANGE)
    press(screen, { ctrlKey: true })
    web.options.hover?.(pointer(), BARE)
    web.options.leave?.(pointer(), BARE)
    press(screen, { ctrlKey: true })

    expect(opened).toEqual([])
    expect(reached).toHaveBeenCalledTimes(3)
  })

  describe('when xterm has lost the link under the pointer', () => {
    // 24 rows of 20px from the top-left of the window; row 5 is y 100 to 120.
    const GRID = { left: 0, top: 0, width: 800, height: 480 }

    /** Plays xterm's Linkifier: a link on row 5, found by a move onto it. */
    function linkifier(screen: Element, osc: ILinkHandler): { x: number; y: number; bubbles: boolean }[] {
      const moves: { x: number; y: number; bubbles: boolean }[] = []
      screen.addEventListener('mousemove', (event) => {
        const move = event as MouseEvent
        moves.push({ x: move.clientX, y: move.clientY, bubbles: move.bubbles })
        if (move.clientY >= 100 && move.clientY < 120) osc.hover?.(move, DOCS, RANGE)
        else osc.leave?.(move, DOCS, RANGE)
      })
      return moves
    }

    it('has it look again where the press is, a row away first, without the program seeing the moves', () => {
      const { screen, reached, opened, osc } = pane()
      layout.set(screen, GRID)
      const moves = linkifier(screen, osc)

      press(screen, { ctrlKey: true, clientX: 50, clientY: 110 })

      expect(moves).toEqual([
        { x: 50, y: 90, bubbles: false },
        { x: 50, y: 110, bubbles: false }
      ])
      expect(opened).toEqual([DOCS])
      expect(reached).not.toHaveBeenCalled()
    })

    it('looks a row down from the top row', () => {
      const { screen, osc } = pane()
      layout.set(screen, GRID)
      const moves = linkifier(screen, osc)

      press(screen, { ctrlKey: true, clientX: 50, clientY: 5 })

      expect(moves.map((move) => move.y)).toEqual([25, 5])
    })

    it('leaves the press to the program when there is still no link there', () => {
      const { screen, reached, opened, osc } = pane()
      layout.set(screen, GRID)
      const moves = linkifier(screen, osc)

      press(screen, { ctrlKey: true, clientX: 50, clientY: 150 })

      expect(moves).toHaveLength(2)
      expect(opened).toEqual([])
      expect(reached).toHaveBeenCalledTimes(1)
    })

    it('does not look outside the grid, where xterm would clamp to a cell the pointer is not on', () => {
      const { screen, reached, opened, osc } = pane()
      layout.set(screen, GRID)
      const moves = linkifier(screen, osc)

      press(screen, { ctrlKey: true, clientX: 50, clientY: 480 })
      press(screen, { ctrlKey: true, clientX: 800, clientY: 110 })

      expect(moves).toEqual([])
      expect(opened).toEqual([])
      expect(reached).toHaveBeenCalledTimes(2)
    })

    it('does not look for a plain click', () => {
      const { screen, osc } = pane()
      layout.set(screen, GRID)
      const moves = linkifier(screen, osc)

      press(screen, { clientX: 50, clientY: 110 })

      expect(moves).toEqual([])
    })
  })

  it("does nothing when xterm follows a link itself, which would be a second open", () => {
    const { opened, osc, web } = pane()
    const confirm = vi.spyOn(window, 'confirm')
    const open = vi.spyOn(window, 'open')

    osc.activate(pointer({ ctrlKey: true }), DOCS, RANGE)
    web.handler?.(pointer({ ctrlKey: true }), BARE)

    expect(opened).toEqual([])
    // xterm's default for a hyperlink, had Helm not handed it one.
    expect(confirm).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    // Only http and https: a `file://` hyperlink is not xterm's, and its click is the program's.
    expect(osc.allowNonHttpProtocols).toBe(false)
  })

  it('stops taking presses when the terminal is disposed', () => {
    const { host, screen, reached, opened, osc, web } = pane()

    host.dispose()
    osc.hover?.(pointer(), DOCS, RANGE)
    press(screen, { ctrlKey: true })

    expect(opened).toEqual([])
    expect(reached).toHaveBeenCalledTimes(1)
    expect(web.disposed).toBe(true)
  })
})

describe('the pointer over a link', () => {
  it('shows only while Ctrl alone is held', () => {
    pane()
    expect(chordSet()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))
    expect(chordSet()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', ctrlKey: true, shiftKey: true }))
    expect(chordSet()).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', ctrlKey: true }))
    expect(chordSet()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))
    expect(chordSet()).toBe(false)
  })

  it('follows the pointer, for Ctrl pressed or let go while the window was elsewhere', () => {
    pane()

    window.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true }))
    expect(chordSet()).toBe(true)

    window.dispatchEvent(new MouseEvent('mousemove'))
    expect(chordSet()).toBe(false)
  })

  it('drops the chord when the window loses focus', () => {
    pane()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }))

    window.dispatchEvent(new Event('blur'))

    expect(chordSet()).toBe(false)
  })
})
