import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { createTerminal } from '../terminal'
import { helm } from './bridge'
import type { PeekGrid } from './peek'
import { terminalPrefs } from './termprefs'

const HIDE_CURSOR = '\x1b[?25l'

/** The screen's type, as the design sets it: 11px mono at 1.5. */
const PEEK_FONT_SIZE = 11
const PEEK_LINE_HEIGHT = 1.5

/**
 * How many rows under the last one with something on it (or the cursor) the
 * peek leaves out, so the box ends on what the child drew.
 *
 * A program that draws from the top, a shell for one, leaves the bottom of its
 * grid empty, so a view anchored to the grid's bottom would show nothing.
 */
export function peekHiddenRows(lines: readonly string[], cursorRow: number): number {
  let last = Math.min(Math.max(cursorRow, 0), lines.length - 1)
  for (let y = lines.length - 1; y > last; y--) {
    if ((lines[y] ?? '').trim() !== '') {
      last = y
      break
    }
  }
  return Math.max(0, lines.length - 1 - last)
}

export interface PeekTerminalProps {
  /** Draws the peek's output into `sink`: what has arrived, then each chunk. Returns the way to stop (`PeekStore.attach`). */
  attach: (sink: (text: string) => void) => () => void
  /** The child's own grid, which the screen is drawn at so nothing wraps differently than it does for the child. */
  grid: PeekGrid
  windowsBuild: number | null
}

/**
 * A child's screen in the peek: read-only, at the child's own grid, in 11px
 * mono at a line height of 1.5, as the design sets the screen. What does not
 * fit the box is cut at its right and top, and the box ends on the last row
 * with anything on it.
 *
 * It has no way to type or to size the child. Input is off, nothing it is given
 * goes anywhere, it never fits itself to its box (the grid is the child's), and
 * it is never given the keyboard. The only thing it reaches outside itself is
 * the clipboard, to copy text the user selected.
 */
export function PeekTerminal({ attach, grid, windowsBuild }: PeekTerminalProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const fitRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    const wrap = fitRef.current
    if (box === null || wrap === null) return
    const element = document.createElement('div')
    wrap.appendChild(element)
    const host = createTerminal(
      element,
      {
        cols: grid.cols,
        rows: grid.rows,
        fit: false,
        focus: false,
        ...(windowsBuild !== null ? { windowsBuild } : {})
      },
      {
        onInput: () => undefined,
        onResize: () => undefined,
        readClipboard: () => Promise.resolve({ refused: true }),
        writeClipboard: async (text) => (await helm.invoke('clipboard:write', text)).outcome,
        openLink: () => undefined
      },
      // The screen only: what scrolled off is not this view's to keep.
      { ...terminalPrefs(), fontSize: PEEK_FONT_SIZE, scrollback: 0 }
    )
    host.term.options.lineHeight = PEEK_LINE_HEIGHT
    host.term.options.disableStdin = true
    host.term.options.cursorBlink = false
    // Nothing is typed here, so no cursor is drawn: the program's own cursor
    // position is not a place the user can act.
    host.term.options.cursorInactiveStyle = 'none'

    // The box ends on the last row that has anything on it.
    const settle = (): void => {
      const screen = element.querySelector<HTMLElement>('.xterm-screen')
      const height = screen?.offsetHeight ?? 0
      if (height < 1) return
      const buffer = host.term.buffer.active
      const lines: string[] = []
      for (let y = buffer.viewportY; y < buffer.viewportY + grid.rows; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
      }
      wrap.style.bottom = `${String(-peekHiddenRows(lines, buffer.cursorY) * (height / grid.rows))}px`
    }
    settle()

    // Hidden again after every chunk, because the program shows its cursor
    // whenever it likes and this view has none to show.
    const detach = attach((text) => {
      host.term.write(text, () => {
        host.term.write(HIDE_CURSOR, settle)
      })
    })
    return () => {
      detach()
      host.dispose()
      element.remove()
    }
  }, [attach, grid.cols, grid.rows, windowsBuild])

  return (
    <div className="absolute inset-0 overflow-hidden px-2.5 py-[9px]" data-peek-terminal>
      <div ref={boxRef} className="relative size-full overflow-hidden">
        <div ref={fitRef} className="absolute bottom-0 left-0" />
      </div>
    </div>
  )
}
