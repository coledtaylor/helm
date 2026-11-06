import {
  applyPrefs,
  createTerminal,
  describeTerminal,
  TERMINAL_FONT,
  type TerminalHost,
  type TerminalReport
} from '../terminal'
import { LOCAL_HOST_KEY, gridOf, type CellSize } from '@helm/core/types'
import { bridgeFor, helm } from './bridge'
import { attachSessionSink, forgetSession } from './sessionStream'
import { onTerminalPrefs, terminalPrefs } from './termprefs'

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
 *
 * A session is its host and its row id there (this PC's host is
 * `LOCAL_HOST_KEY`, the default): each host numbers its own sessions, so a
 * terminal is kept by both, and its keys and size go to its own host's bridge.
 * The clipboard and links are this PC's, through `helm`.
 */

interface Pane {
  /** The session's host. */
  on: string
  id: number
  host: TerminalHost
  /** The terminal's own element, moved between containers as tabs change. */
  element: HTMLDivElement
  detach: () => void
}

const panes = new Map<string, Pane>()

/** One session's key across every host. */
const keyOf = (host: string, id: number): string => `${host}\n${String(id)}`

/**
 * Every open session terminal takes the new preferences immediately - the
 * VS Code behaviour, and the only one that lets a person judge a font by
 * looking at the thing they are going to read in it.
 *
 * A hidden pane is included and refits to nothing: its container is 0x0 while
 * another tab is in front, and `applyFit` refuses to act on that. It re-measures
 * when it comes back, which is the same path a window resize already takes.
 */
onTerminalPrefs((prefs) => {
  for (const pane of panes.values()) applyPrefs(pane.host, prefs)
})

export interface MountOptions {
  /** From `app:info`; picks xterm's ConPTY quirk handling. */
  windowsBuild: number | null
  /**
   * Whether a terminal made by this call takes the keyboard. A child's card in
   * its parent's tab says false, because its parent keeps the caret. Only the
   * call that makes the terminal reads it.
   */
  focus?: boolean
}

/** The terminal for session `id` on `on`, created on first call, re-parented on later ones. */
export function mountTerminal(
  id: number,
  container: HTMLElement,
  opts: MountOptions,
  on: string = LOCAL_HOST_KEY
): TerminalHost {
  const key = keyOf(on, id)
  const existing = panes.get(key)
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

  const session = bridgeFor(on)
  const host = createTerminal(
    element,
    {
      // Corrected by the fit below before the first frame; the pty was opened
      // at whatever `estimateGrid` guessed and takes the real size from here.
      cols: 100,
      rows: 30,
      fit: true,
      ...(opts.windowsBuild !== null ? { windowsBuild: opts.windowsBuild } : {}),
      ...(opts.focus === false ? { focus: false } : {})
    },
    {
      onInput: (data) => session.send('session:input', { id, data }),
      onResize: (cols, rows) => session.send('session:resize', { id, cols, rows }),
      readClipboard: () => helm.invoke('clipboard:read'),
      writeClipboard: async (text) => (await helm.invoke('clipboard:write', text)).outcome,
      openLink: (url) => void helm.invoke('shell:openExternal', { url })
    },
    terminalPrefs()
  )

  panes.set(key, {
    on,
    id,
    host,
    element,
    detach: attachSessionSink(id, (data) => host.term.write(data), on)
  })
  return host
}

export function getTerminal(id: number, on: string = LOCAL_HOST_KEY): TerminalHost | undefined {
  return panes.get(keyOf(on, id))?.host
}

/** Ends a terminal for good. Called when its tab closes, not when it unmounts. */
export function disposeTerminal(id: number, on: string = LOCAL_HOST_KEY): void {
  const key = keyOf(on, id)
  const pane = panes.get(key)
  if (!pane) return
  panes.delete(key)
  pane.detach()
  pane.host.dispose()
  pane.element.remove()
  forgetSession(id, on)
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
 *
 * "The terminal's own font" is now whatever the settings say, not what the
 * source says. An estimate that kept using the built-in 14px would be a whole
 * grid out at 20px, and the pty would spend its first repaint at a size nothing
 * on screen has.
 */
export function estimateGrid(container: HTMLElement | null): { cols: number; rows: number } {
  const fallback = { cols: 100, rows: 30 }
  if (!container) return fallback

  const { width, height } = container.getBoundingClientRect()
  if (width < 1 || height < 1) return fallback

  const prefs = terminalPrefs()
  const cell = measureCell(prefs)
  if (cell === null) return fallback

  // The same arithmetic the family view's room rule runs (`gridOf`), so a pane
  // the rule calls wide enough for 80 columns is one a terminal fits 80 in.
  return gridOf({ width, height }, cell, prefs.scrollback)
}

/**
 * One cell of this device's terminal font as `estimateGrid` measures it, or
 * null when it cannot be measured. The family view's room rule reads it, so a
 * larger font in Settings needs more pixels for the same floors in columns.
 */
export function terminalCell(prefs: { fontFamily: string; fontSize: number } = terminalPrefs()): CellSize | null {
  return measureCell(prefs)
}

/** The lines of scrollback this device's terminals keep, which decide the ruler's strip (`gridOf`). */
export function terminalScrollback(): number {
  return terminalPrefs().scrollback
}

/** Enough characters that a sub-pixel advance averages out, as xterm uses. */
const SAMPLE = 'W'.repeat(32)

/**
 * One cell, measured the way xterm measures one.
 *
 * A `white-space: pre` element in the document rather than a canvas, and that
 * is not interchangeable: a canvas resolves a font stack per glyph by its own
 * rules and a layout engine resolves it by CSS's, and on a machine where those
 * two disagree the estimate is measured in one font and the terminal is drawn
 * in another. Measured 2026-08-11 with the built-in stack: the canvas answered
 * 11.72px per cell at 20px and the document laid out at 11.00, so a
 * canvas-based estimate opened every pty eight columns narrow.
 *
 * Both axes then follow the WebGL renderer's own arithmetic, which is the one
 * Helm loads: a cell is quantised to whole device pixels, **down** across and
 * **up** down. That is not a detail - the built-in stack measures 11.72px per
 * cell at 20px and the renderer draws it at 11, which is eight columns across a
 * wide pane. The DOM renderer, which only appears after a lost GL context,
 * does not floor the width; being one column out in that case is not worth a
 * second code path.
 */
function measureCell(prefs: {
  fontFamily: string
  fontSize: number
}): { width: number; height: number } | null {
  const probe = document.createElement('span')
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-kerning:none;line-height:normal'
  probe.style.fontFamily = prefs.fontFamily
  probe.style.fontSize = `${String(prefs.fontSize)}px`
  probe.textContent = SAMPLE
  document.body.appendChild(probe)
  const box = probe.getBoundingClientRect()
  probe.remove()
  if (box.width < 1 || box.height < 1) return null

  const dpr = window.devicePixelRatio || 1
  const deviceColumn = Math.floor((box.width / SAMPLE.length) * dpr)
  const deviceRow = Math.floor(Math.ceil(box.height * dpr) * TERMINAL_FONT.lineHeight)
  if (deviceColumn < 1 || deviceRow < 1) return null
  return { width: deviceColumn / dpr, height: deviceRow / dpr }
}

/**
 * What every session terminal is currently configured as, for the real-window
 * drivers.
 *
 * A read-only tap, in the same spirit as `SessionObserver` in `sessions.ts`:
 * these terminals live outside React in a module registry, so a driver working
 * the window through `executeJavaScript` has no other way to see that a
 * font change actually reached them. Nothing in the app calls it.
 */
export function describeSessionTerminals(): TerminalReport[] {
  // This PC's sessions keep the names the drivers know them by.
  return [...panes.values()].map((pane) =>
    describeTerminal(pane.on === LOCAL_HOST_KEY ? String(pane.id) : `${pane.on}:${String(pane.id)}`, pane.host)
  )
}
