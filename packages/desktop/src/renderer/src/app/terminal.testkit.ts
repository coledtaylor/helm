import { vi } from 'vitest'

/**
 * Stand-ins for the renderer's terminal tests: xterm, the layout jsdom does
 * not do, and `ResizeObserver`. The preload's bridge is `bridge.testkit.ts`.
 *
 * xterm needs a canvas and a layout engine, and jsdom has neither, so the
 * terminal tests assert the logic Helm wraps around it - which preferences a
 * terminal is built with, when a pane is fitted, which change tells a pty its
 * grid - against a fake that does only what that logic touches. What xterm
 * then paints is the diagnostic drivers' to look at (docs/TESTING.md).
 *
 * The xterm part is shaped as a module so one file can stand in for all of
 * them:
 *
 *   vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
 *   vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface Box {
  left?: number
  top?: number
  width: number
  height: number
}

const boxes = new WeakMap<Element, Box>()
let textMetrics: ((element: HTMLElement) => Box | null) | null = null

/** The box `element` lays out at: its own, or the nearest ancestor's. */
function declaredBox(element: Element): Box | null {
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    const box = boxes.get(at)
    if (box !== undefined) return box
  }
  return null
}

function rect({ left = 0, top = 0, width, height }: Box): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }
}

/**
 * The boxes elements are drawn at, as a test declares them.
 *
 * An element without a box of its own fills its nearest ancestor that has one,
 * which is what the terminal containers do (`width: 100%; height: 100%`), and
 * an element outside the document measures 0x0, as it does in a browser.
 * `text` sizes a text probe instead - the span `estimateGrid` measures a font
 * with - so a test can say what a font measures at a given size.
 */
export const layout = {
  set(element: Element, box: Box): void {
    boxes.set(element, box)
  },
  text(metrics: ((element: HTMLElement) => Box | null) | null): void {
    textMetrics = metrics
  },
  install(): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (!this.isConnected) return rect({ width: 0, height: 0 })
      if (textMetrics !== null && this instanceof HTMLElement) {
        const measured = textMetrics(this)
        if (measured !== null) return rect(measured)
      }
      return rect(declaredBox(this) ?? { width: 0, height: 0 })
    })
  }
}

// ---------------------------------------------------------------------------
// ResizeObserver
// ---------------------------------------------------------------------------

/** jsdom has none. `notifyAll` is the browser noticing every observed box. */
export class FakeResizeObserver {
  static live = new Set<FakeResizeObserver>()

  readonly targets = new Set<Element>()

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.live.add(this)
  }

  observe(target: Element): void {
    this.targets.add(target)
  }

  unobserve(target: Element): void {
    this.targets.delete(target)
  }

  disconnect(): void {
    this.targets.clear()
    FakeResizeObserver.live.delete(this)
  }

  static notifyAll(): void {
    for (const observer of FakeResizeObserver.live) {
      if (observer.targets.size > 0) observer.callback([], observer as unknown as ResizeObserver)
    }
  }
}

// ---------------------------------------------------------------------------
// xterm
// ---------------------------------------------------------------------------

/**
 * How big a cell is at a given font size, for the fake fit. Round numbers so a
 * test can work out the grid it expects by hand: half the point size across,
 * one and a quarter down - 7x17.5 at 14px, 10x25 at 20px.
 */
export function fakeCell(fontSize: number): { width: number; height: number } {
  return { width: fontSize * 0.5, height: fontSize * 1.25 }
}

interface Addon {
  activate: (terminal: Terminal) => void
  dispose: () => void
}

type Listener<T> = (value: T) => void

/** The surface of xterm's `Terminal` Helm's code reaches for, and no more. */
export class Terminal {
  static instances: Terminal[] = []

  options: Record<string, unknown>
  cols: number
  rows: number
  /** The container `open` was given. */
  parent: HTMLElement | null = null
  /** xterm's own root, which holds the screen; here the container itself. */
  element: HTMLElement | undefined
  disposed = false
  readonly written: string[] = []
  readonly unicode = { activeVersion: '6' }
  readonly buffer = {
    active: { viewportY: 0, getLine: (): undefined => undefined }
  }
  private readonly dataListeners = new Set<Listener<string>>()

  constructor(options: Record<string, unknown>) {
    this.options = { ...options }
    this.cols = Number(options['cols'])
    this.rows = Number(options['rows'])
    Terminal.instances.push(this)
  }

  loadAddon(addon: Addon): void {
    addon.activate(this)
  }

  open(container: HTMLElement): void {
    this.parent = container
    this.element = container
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    container.appendChild(screen)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
  }

  onData(listener: Listener<string>): { dispose: () => void } {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onBinary(_listener: Listener<string>): { dispose: () => void } {
    return { dispose: () => undefined }
  }

  /** Types as if the user had: what `onData` would hand Helm. */
  type(data: string): void {
    for (const listener of this.dataListeners) listener(data)
  }

  attachCustomKeyEventHandler(_handler: (event: KeyboardEvent) => boolean): void {}

  write(data: string): void {
    this.written.push(data)
  }

  focus(): void {}
  blur(): void {}
  hasSelection(): boolean {
    return false
  }
  getSelection(): string {
    return ''
  }
  clearSelection(): void {}
  paste(_text: string): void {}

  dispose(): void {
    this.disposed = true
  }
}

/**
 * FitAddon, fitting to the box the container measures and the fake cell size.
 *
 * Like the real one, it fits a 0x0 container to the smallest grid it allows -
 * which is the resize a hidden pane must never send - rather than declining.
 */
export class FitAddon implements Addon {
  static instances: FitAddon[] = []

  fits = 0
  private terminal: Terminal | null = null

  constructor() {
    FitAddon.instances.push(this)
  }

  activate(terminal: Terminal): void {
    this.terminal = terminal
  }

  fit(): void {
    const terminal = this.terminal
    if (terminal === null || terminal.parent === null) return
    this.fits++
    const box = terminal.parent.getBoundingClientRect()
    const cell = fakeCell(Number(terminal.options['fontSize']))
    terminal.resize(
      Math.max(2, Math.floor(box.width / cell.width)),
      Math.max(1, Math.floor(box.height / cell.height))
    )
  }

  dispose(): void {}
}

export class Unicode11Addon implements Addon {
  activate(): void {}
  dispose(): void {}
}

export class SerializeAddon implements Addon {
  activate(): void {}
  dispose(): void {}
}

type LinkCallback = (event: MouseEvent, text: string) => void

/**
 * The web links addon, keeping what it was handed. A test plays xterm with it:
 * `options.hover` and `options.leave` are what xterm calls as the pointer
 * crosses a web address on screen, and `handler` is xterm following one.
 */
export class WebLinksAddon implements Addon {
  static instances: WebLinksAddon[] = []

  disposed = false

  constructor(
    readonly handler: LinkCallback | undefined,
    readonly options: { hover?: LinkCallback; leave?: LinkCallback } = {}
  ) {
    WebLinksAddon.instances.push(this)
  }

  activate(): void {}
  dispose(): void {
    this.disposed = true
  }
}

/** jsdom has no WebGL, so the real addon would throw on load; this one loads. */
export class WebglAddon implements Addon {
  activate(): void {}
  dispose(): void {}
  onContextLoss(_listener: () => void): { dispose: () => void } {
    return { dispose: () => undefined }
  }
}
