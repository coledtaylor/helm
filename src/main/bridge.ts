import { BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProbeOp } from '../shared/protocol'

// ---------------------------------------------------------------------------
// main -> renderer request/response
// ---------------------------------------------------------------------------

let nextProbeId = 1
const pendingProbes = new Map<number, (value: unknown) => void>()

ipcMain.on('probe:res', (_e, { id, value }: { id: number; value: unknown }) => {
  pendingProbes.get(id)?.(value)
  pendingProbes.delete(id)
})

export function probe<T = any>(win: BrowserWindow, req: ProbeOp, timeoutMs = 10000): Promise<T> {
  const id = nextProbeId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingProbes.delete(id)
      reject(new Error(`probe timed out: ${req.op}`))
    }, timeoutMs)
    pendingProbes.set(id, (value) => {
      clearTimeout(timer)
      resolve(value as T)
    })
    win.webContents.send('probe:req', { id, req })
  })
}

// ---------------------------------------------------------------------------
// Synthetic input - real Chromium events, so keystrokes take the same route
// through xterm that a user's typing does.
// ---------------------------------------------------------------------------

export type Modifier = 'shift' | 'control' | 'alt' | 'meta'

const PRINTABLE = /^[\x20-\x7e]$/

export async function sendKey(
  win: BrowserWindow,
  keyCode: string,
  modifiers: Modifier[] = [],
  settleMs = 20
): Promise<void> {
  const wc = win.webContents
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  // Chromium only inserts text when a char event follows, and only for an
  // unmodified printable key.
  if (PRINTABLE.test(keyCode) && !modifiers.some((m) => m === 'control' || m === 'alt')) {
    wc.sendInputEvent({ type: 'char', keyCode, modifiers })
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  await sleep(settleMs)
}

export async function typeText(win: BrowserWindow, text: string, perKeyMs = 12): Promise<void> {
  for (const ch of text) {
    // Without the shift modifier Chromium delivers the unshifted character, so
    // typed text silently arrives lower-cased.
    const shifted = ch !== ch.toLowerCase() && ch === ch.toUpperCase()
    await sendKey(win, ch, shifted ? ['shift'] : [], perKeyMs)
  }
}

export async function sendMouse(
  win: BrowserWindow,
  type: 'mouseDown' | 'mouseUp' | 'mouseMove',
  x: number,
  y: number
): Promise<void> {
  win.webContents.sendInputEvent({
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    clickCount: 1
  })
  await sleep(20)
}

/**
 * Scroll the pane by `notches`; positive scrolls back toward older output.
 *
 * Two things this has to get right. Chromium routes a wheel event to whatever
 * is under the cursor, so the hover target must be set with a move first, and
 * it needs wheelTicks as well as deltas. And sendInputEvent's deltaY is the
 * inverse of the DOM's: a +400 here arrives in the page as deltaY -400.
 */
export async function sendWheel(
  win: BrowserWindow,
  x: number,
  y: number,
  notches: number
): Promise<void> {
  const at = { x: Math.round(x), y: Math.round(y) }
  win.webContents.sendInputEvent({ type: 'mouseMove', ...at })
  win.webContents.sendInputEvent({
    type: 'mouseWheel',
    ...at,
    deltaX: 0,
    deltaY: notches * 100,
    wheelTicksX: 0,
    wheelTicksY: notches,
    hasPreciseScrollingDeltas: false,
    canScroll: true
  } as Electron.MouseWheelInputEvent)
  await sleep(60)
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export async function screenshot(
  win: BrowserWindow,
  dir: string,
  name: string
): Promise<{ file: string; bitmap: Buffer; width: number; height: number }> {
  mkdirSync(dir, { recursive: true })
  const image = await win.webContents.capturePage()
  const file = join(dir, name)
  writeFileSync(file, image.toPNG())
  const size = image.getSize()
  return { file, bitmap: image.toBitmap(), width: size.width, height: size.height }
}

/**
 * Count pixels in a captured frame that are *exactly* this colour. The 256
 * colour palette contains none of the values this spike paints, so a non-zero
 * count is proof the whole path - SGR parse, renderer, compositor - carried 24
 * bits rather than quantising to the nearest palette entry.
 */
export function countExactPixels(
  bitmap: Buffer,
  rgb: { r: number; g: number; b: number }
): number {
  let n = 0
  // capturePage yields BGRA on Windows.
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (bitmap[i] === rgb.b && bitmap[i + 1] === rgb.g && bitmap[i + 2] === rgb.r) n++
  }
  return n
}

export function nearestPixel(
  bitmap: Buffer,
  width: number,
  x: number,
  y: number
): { r: number; g: number; b: number } {
  const i = (y * width + x) * 4
  return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2] }
}

// ---------------------------------------------------------------------------

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      let ok = false
      try {
        ok = predicate()
      } catch {
        ok = false
      }
      if (ok) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, intervalMs)
  })
}

/**
 * TUI output interleaves cursor-movement and style sequences inside words and
 * positions text without emitting spaces, so any text assertion has to run
 * against a stripped view of the stream.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][A-Z0-9]|\x1b[=><]|\x1b[PX^_][^\x1b]*\x1b\\/g

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '')

/**
 * Claude's TUI positions text without emitting the spaces between words and
 * interleaves style sequences inside them, so whitespace in the output stream
 * is not a reliable landmark. Squashing it away makes text assertions survive
 * that.
 */
export const squash = (text: string): string =>
  stripAnsi(text).replace(/\s+/g, '').toLowerCase()
