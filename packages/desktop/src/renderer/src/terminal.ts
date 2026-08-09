import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import '@xterm/xterm/css/xterm.css'
import type { TermCreateOptions } from '../../shared/protocol'

/**
 * A 24-bit theme. Every entry is an exact hex triple so that a screenshot can
 * be checked pixel-for-pixel: if the compositor or the renderer quantised
 * anything, these values would not survive.
 */
const THEME = {
  background: '#11121a',
  foreground: '#c9d1d9',
  cursor: '#f0c674',
  cursorAccent: '#11121a',
  selectionBackground: '#2b4a6f',
  black: '#1c1e26',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#ff7b86',
  brightGreen: '#b5e890',
  brightYellow: '#ffd68a',
  brightBlue: '#7cc4ff',
  brightMagenta: '#dd93f0',
  brightCyan: '#6fd3e0',
  brightWhite: '#ffffff'
}

/**
 * The pane's font metrics, in one place because two things need them: the
 * terminal itself, and the estimate of how many cells fit in a pane that does
 * not have a terminal in it yet (see `estimateGrid`).
 */
export const TERMINAL_FONT = {
  family: '"Cascadia Mono", "Consolas", monospace',
  size: 14,
  lineHeight: 1.0
} as const

export interface WheelRecord {
  deltaY: number
  deltaMode: number
  /** The legacy property VS Code's scrollable element actually reads. */
  wheelDeltaY: number | undefined
  target: string
  count: number
}

export interface TerminalHost {
  term: Terminal
  serialize: SerializeAddon
  fit: FitAddon | null
  /** Live, not a snapshot: it flips to 'dom' if the GL context is ever lost. */
  readonly rendererKind: 'webgl' | 'dom'
  element: HTMLElement
  lastWheel: () => WheelRecord | null
  /** Re-measure against the container. Call after the pane becomes visible. */
  refit: () => void
  /** Releases the terminal, its addons, and the resize observer. */
  dispose: () => void
}

export interface TerminalHooks {
  /** Host -> pty. Everything the user types funnels through here. */
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<void>
  /** Fired on every keydown that xterm will translate, for latency timing. */
  onKeyDown?: (at: number) => void
}

export function createTerminal(
  container: HTMLElement,
  opts: TermCreateOptions,
  hooks: TerminalHooks
): TerminalHost {
  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    // Unicode 11 widths are proposed API; without this the addon cannot load
    // and emoji fall back to Unicode 6 widths, which mis-measures most of them.
    allowProposedApi: true,
    fontFamily: TERMINAL_FONT.family,
    fontSize: TERMINAL_FONT.size,
    lineHeight: TERMINAL_FONT.lineHeight,
    letterSpacing: 0,
    scrollback: 10000,
    // Any value above 1 rewrites colours to hit a contrast target. A host that
    // claims to render the TUI faithfully must leave them alone.
    minimumContrastRatio: 1,
    // Likewise: do not promote bold text into the bright palette.
    drawBoldTextInBrightColors: false,
    rescaleOverlappingGlyphs: true,
    cursorBlink: true,
    cursorStyle: 'block',
    theme: THEME,
    // Spread rather than `windowsPty: cond ? {...} : undefined`. Same value
    // reaches xterm either way - it tests the property for truthiness - but
    // under `exactOptionalPropertyTypes` an explicit `undefined` is not a legal
    // value for an optional property, and omitting the key is what "no ConPTY
    // quirk handling" actually means.
    ...(opts.windowsBuild
      ? { windowsPty: { backend: 'conpty' as const, buildNumber: opts.windowsBuild } }
      : {})
  })

  const unicode11 = new Unicode11Addon()
  term.loadAddon(unicode11)
  term.unicode.activeVersion = '11'

  const serialize = new SerializeAddon()
  term.loadAddon(serialize)

  let fit: FitAddon | null = null
  if (opts.fit) {
    fit = new FitAddon()
    term.loadAddon(fit)
  }

  term.open(container)

  // Held in an object rather than a bare `let` because the context-loss
  // handler fires long after `createTerminal` has returned: copying the
  // variable into the returned host would freeze it at 'webgl' and the fallback
  // would never be visible to anything that asks.
  const renderer: { kind: 'webgl' | 'dom' } = { kind: 'dom' }
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      // A lost GL context leaves a blank pane; drop back to the DOM renderer
      // rather than showing nothing.
      webgl.dispose()
      renderer.kind = 'dom'
    })
    term.loadAddon(webgl)
    renderer.kind = 'webgl'
  } catch {
    renderer.kind = 'dom'
  }

  term.onData(hooks.onInput)
  term.onBinary((data) => {
    let out = ''
    for (let i = 0; i < data.length; i++) out += String.fromCharCode(data.charCodeAt(i) & 255)
    hooks.onInput(out)
  })

  /**
   * Fit, then tell the pty - but only when there is something to fit to and
   * only when the answer changed.
   *
   * A hidden pane measures 0x0 and FitAddon turns that into a 1x1 grid. That is
   * a real resize as far as the child process is concerned: it redraws its
   * whole UI into one column, and the damage is still there when the tab comes
   * back. Reporting an unchanged size is the milder version of the same
   * problem - every pixel of a window drag would be a SIGWINCH, and Claude
   * Code repaints on each one.
   */
  let reported: { cols: number; rows: number } | null = null
  const applyFit = (): void => {
    if (!fit) return
    const { width, height } = container.getBoundingClientRect()
    if (width < 1 || height < 1) return
    fit.fit()
    if (reported?.cols === term.cols && reported.rows === term.rows) return
    reported = { cols: term.cols, rows: term.rows }
    hooks.onResize(term.cols, term.rows)
  }

  let observer: ResizeObserver | null = null
  if (fit) {
    applyFit()
    observer = new ResizeObserver(applyFit)
    observer.observe(container)
  }

  attachKeyBindings(term, hooks)

  // Diagnostic only: records what a wheel event actually looked like by the
  // time it reached the pane, so a "scrolling does not work" result can name
  // whether the event arrived at all.
  let wheel: WheelRecord | null = null
  container.addEventListener(
    'wheel',
    (e) => {
      const ev = e as WheelEvent & { wheelDeltaY?: number }
      wheel = {
        deltaY: ev.deltaY,
        deltaMode: ev.deltaMode,
        wheelDeltaY: ev.wheelDeltaY,
        target: (ev.target as HTMLElement)?.className || '(none)',
        count: (wheel?.count ?? 0) + 1
      }
    },
    { capture: true, passive: true }
  )

  term.focus()
  return {
    term,
    serialize,
    fit,
    get rendererKind() {
      return renderer.kind
    },
    element: container,
    lastWheel: () => wheel,
    refit: applyFit,
    dispose: () => {
      observer?.disconnect()
      observer = null
      // Disposes the loaded addons with it, webgl's GL context included.
      term.dispose()
    }
  }
}

/**
 * Windows Terminal's contract, which is the bar this spike is measured against:
 *
 *  - Ctrl-C copies when there is a selection and interrupts otherwise
 *  - Ctrl-Shift-C / Ctrl-Shift-V always copy and paste
 *  - Ctrl-V pastes
 *
 * The interrupt is the interaction Claude Code depends on most, so any other
 * keystroke drops a stale selection - otherwise a selection made minutes ago
 * would silently swallow the next Ctrl-C.
 */
function attachKeyBindings(term: Terminal, hooks: TerminalHooks): void {
  const copy = async (): Promise<void> => {
    const text = term.getSelection()
    if (text) await hooks.writeClipboard(text)
  }
  const paste = async (): Promise<void> => {
    const text = await hooks.readClipboard()
    if (text) term.paste(text)
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    hooks.onKeyDown?.(performance.now())

    // Shift+Enter has no standard encoding, so xterm sends plain CR for it and
    // the composer submits instead of adding a line. Spike C measured which
    // sequences Claude Code's composer accepts as an inline newline - ESC CR,
    // LF, CSI 13;2u and backslash-CR all work - and ESC CR is the conventional
    // meta-Enter, so that is what the host emits.
    if (
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      (e.code === 'Enter' || e.code === 'NumpadEnter')
    ) {
      hooks.onInput('\x1b\r')
      return false
    }

    const mod = e.ctrlKey && !e.altKey
    if (mod && e.shiftKey && e.code === 'KeyC') {
      void copy()
      return false
    }
    if (mod && e.shiftKey && e.code === 'KeyV') {
      void paste()
      return false
    }
    if (mod && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      void copy()
      term.clearSelection()
      return false
    }
    if (mod && !e.shiftKey && e.code === 'KeyV') {
      void paste()
      return false
    }

    const isModifierOnly = ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)
    if (!isModifierOnly && term.hasSelection()) term.clearSelection()
    return true
  })
}
