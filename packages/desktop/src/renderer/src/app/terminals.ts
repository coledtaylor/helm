import { createTerminal, TERMINAL_FONT, type TerminalHost } from '../terminal'
import { helm } from './bridge'
import { attachSessionSink, forgetSession } from './sessionStream'

/**
 * One live terminal per session, owned outside React.
 *
 * A terminal is not a rendering of state - it *is* the state. Ten thousand
 * lines of scrollback, the alternate buffer a `/resume` picker is drawing in,
 * the selection someone is halfway through making: none of it can be rebuilt
 * from props, so none of it may depend on a component staying mounted. Tab
 * reordering moves panes around the tree and React's StrictMode remounts every
 * effect twice in development; either would wipe a session's history if the
 * terminal lived in a `useEffect`.
 *
 * So the component only says *where* a session's terminal should appear. The
 * terminal, its output subscription and its lifetime live here, and end when
 * the tab is closed rather than when a render happens to unmount a node.
 */

interface Pane {
  host: TerminalHost
  /** The terminal's own element, moved between containers as tabs change. */
  element: HTMLDivElement
  detach: () => void
}

const panes = new Map<number, Pane>()

export interface MountOptions {
  /** From `app:info`; picks xterm's ConPTY quirk handling. */
  windowsBuild: number | null
}

/** The terminal for `id`, created on first call, re-parented on later ones. */
export function mountTerminal(id: number, container: HTMLElement, opts: MountOptions): TerminalHost {
  const existing = panes.get(id)
  if (existing) {
    if (existing.element.parentElement !== container) {
      container.appendChild(existing.element)
      existing.host.refit()
    }
    return existing.host
  }

  const element = document.createElement('div')
  element.style.width = '100%'
  element.style.height = '100%'
  container.appendChild(element)

  const host = createTerminal(
    element,
    {
      // Corrected by the fit below before the first frame; the pty was opened
      // at whatever `estimateGrid` guessed and takes the real size from here.
      cols: 100,
      rows: 30,
      fit: true,
      ...(opts.windowsBuild !== null ? { windowsBuild: opts.windowsBuild } : {})
    },
    {
      onInput: (data) => helm.send('session:input', { id, data }),
      onResize: (cols, rows) => helm.send('session:resize', { id, cols, rows }),
      readClipboard: () => helm.invoke('clipboard:read'),
      writeClipboard: (text) => helm.invoke('clipboard:write', text)
    }
  )

  panes.set(id, {
    host,
    element,
    detach: attachSessionSink(id, (data) => host.term.write(data))
  })
  return host
}

export function getTerminal(id: number): TerminalHost | undefined {
  return panes.get(id)?.host
}

/** Ends a terminal for good. Called when its tab closes, not when it unmounts. */
export function disposeTerminal(id: number): void {
  const pane = panes.get(id)
  if (!pane) return
  panes.delete(id)
  pane.detach()
  pane.host.dispose()
  pane.element.remove()
  forgetSession(id)
}

/**
 * How many cells fit in `container`, for opening a pty before its terminal
 * exists.
 *
 * Measured with the terminal's own font rather than assumed, so the pty starts
 * within a column or so of the grid the pane settles on. It is an estimate on
 * purpose: the pane reports its real size the moment it mounts, and waiting for
 * that before spawning would mean a tab that sits empty until React has
 * committed.
 */
export function estimateGrid(container: HTMLElement | null): { cols: number; rows: number } {
  const fallback = { cols: 100, rows: 30 }
  if (!container) return fallback

  const { width, height } = container.getBoundingClientRect()
  const context = document.createElement('canvas').getContext('2d')
  if (!context || width < 1 || height < 1) return fallback

  context.font = `${String(TERMINAL_FONT.size)}px ${TERMINAL_FONT.family}`
  const cellWidth = context.measureText('W').width
  const cellHeight = TERMINAL_FONT.size * TERMINAL_FONT.lineHeight
  if (cellWidth < 1) return fallback

  return {
    cols: Math.max(Math.floor(width / cellWidth), 2),
    rows: Math.max(Math.floor(height / cellHeight), 2)
  }
}
