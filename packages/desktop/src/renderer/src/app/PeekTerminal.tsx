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

    // Fit the child's grid to the box's width, never larger than the grid is.
    const scaleToFit = (): void => {
      const screen = element.querySelector<HTMLElement>('.xterm-screen')
      const width = screen?.offsetWidth ?? 0
      if (width < 1 || box.clientWidth < 1) return
      wrap.style.transform = `scale(${String(Math.min(1, box.clientWidth / width))})`
    }
    scaleToFit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scaleToFit)
    observer?.observe(box)

    const detach = attach((text) => host.term.write(text))
    return () => {
      detach()
      observer?.disconnect()
      host.dispose()
      element.remove()
    }
  }, [attach, windowsBuild])

  return (
    <div className="absolute inset-0 overflow-hidden px-2.5 py-[9px]" data-peek-terminal>
      <div ref={boxRef} className="relative size-full">
        <div ref={fitRef} className="absolute bottom-0 left-0 origin-bottom-left" />
      </div>
    </div>
  )
}
