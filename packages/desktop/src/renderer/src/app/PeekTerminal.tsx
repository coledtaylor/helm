import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { createTerminal } from '../terminal'
import { helm } from './bridge'
import { terminalPrefs } from './termprefs'

/**
 * The grid a child's terminal starts at on the host (`CHILD_SIZE` in
 * `server/hosted/children.rs`). The host's watch-only attach sends the screen
 * at the child's own size and never changes it, and the first terminal that
 * attaches to type resizes the child to its pane. A peek is for a child nobody
 * here is typing into, which is at this grid unless another device has sized
 * it, so the peek draws that grid.
 */
export const PEEK_GRID = { cols: 120, rows: 32 } as const

const HIDE_CURSOR = '\x1b[?25l'

/** The fewest columns the peek fits to its box's width, so a short screen is not drawn tiny. */
const MIN_FIT_COLS = 60
/** How many rows, up from the last one with something on it, decide how wide the screen is drawn. */
const SAMPLE_ROWS = 16

/**
 * Where a child's screen is cut for the peek: its rows (trailing blanks
 * dropped) and the row its cursor is on.
 *
 * A program that draws from the top, a shell for one, leaves the bottom of the
 * grid empty, so a view anchored to the grid's bottom would show nothing.
 * `hiddenRows` is how many empty rows below the last one with something on it
 * (or the cursor) are left out, and `cols` is how many columns the box is fitted
 * to: the widest of the rows shown, never under `MIN_FIT_COLS` or over the grid.
 */
export function peekCut(lines: readonly string[], cursorRow: number, gridCols: number): { hiddenRows: number; cols: number } {
  let last = Math.min(Math.max(cursorRow, 0), lines.length - 1)
  for (let y = lines.length - 1; y > last; y--) {
    if ((lines[y] ?? '').trim() !== '') {
      last = y
      break
    }
  }
  let widest = 0
  for (let y = Math.max(0, last - SAMPLE_ROWS + 1); y <= last; y++) {
    widest = Math.max(widest, (lines[y] ?? '').trimEnd().length)
  }
  return {
    hiddenRows: Math.max(0, lines.length - 1 - last),
    cols: Math.min(gridCols, Math.max(MIN_FIT_COLS, widest + 1))
  }
}

export interface PeekTerminalProps {
  /** Draws the peek's output into `sink`: what has arrived, then each chunk. Returns the way to stop (`PeekStore.attach`). */
  attach: (sink: (text: string) => void) => () => void
  windowsBuild: number | null
}

/**
 * A child's screen in the peek: read-only, at the child's own grid, scaled down
 * to fit the width of its box and anchored to the bottom, where a terminal
 * program does its drawing.
 *
 * It has no way to type or to size the child. Input is off, nothing it is given
 * goes anywhere, it never fits itself to its box (the grid is the child's, so
 * the box is fitted to the grid, by scale), and it is never given the keyboard.
 * The only thing it reaches outside itself is the clipboard, to copy text the
 * user selected.
 */
export function PeekTerminal({ attach, windowsBuild }: PeekTerminalProps): JSX.Element {
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
        ...PEEK_GRID,
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
      { ...terminalPrefs(), scrollback: 0 }
    )
    host.term.options.disableStdin = true
    host.term.options.cursorBlink = false
    // Nothing is typed here, so no cursor is drawn: the program's own cursor
    // position is not a place the user can act.
    host.term.options.cursorInactiveStyle = 'none'

    // Fit what the screen holds to the box's width, never larger than the
    // grid's own size, with the last row that has anything on it at the box's
    // bottom (`peekCut`).
    const scaleToFit = (): void => {
      const screen = element.querySelector<HTMLElement>('.xterm-screen')
      const width = screen?.offsetWidth ?? 0
      const height = screen?.offsetHeight ?? 0
      if (width < 1 || height < 1 || box.clientWidth < 1) return
      const buffer = host.term.buffer.active
      const lines: string[] = []
      for (let y = buffer.viewportY; y < buffer.viewportY + PEEK_GRID.rows; y++) {
        lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
      }
      const cut = peekCut(lines, buffer.cursorY, PEEK_GRID.cols)
      const scale = Math.min(1, box.clientWidth / ((width / PEEK_GRID.cols) * cut.cols))
      wrap.style.transform = `scale(${String(scale)})`
      wrap.style.bottom = `${String(-cut.hiddenRows * (height / PEEK_GRID.rows) * scale)}px`
    }
    scaleToFit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scaleToFit)
    observer?.observe(box)

    // Hidden again after every chunk, because the program shows its cursor
    // whenever it likes and this view has none to show.
    const detach = attach((text) => {
      host.term.write(text, () => {
        host.term.write(HIDE_CURSOR, scaleToFit)
      })
    })
    return () => {
      detach()
      observer?.disconnect()
      host.dispose()
      element.remove()
    }
  }, [attach, windowsBuild])

  return (
    <div className="absolute inset-0 overflow-hidden px-2.5 py-[9px]" data-peek-terminal>
      <div ref={boxRef} className="relative size-full overflow-hidden">
        <div ref={fitRef} className="absolute bottom-0 left-0 origin-bottom-left" />
      </div>
    </div>
  )
}
