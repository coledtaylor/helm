import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_RETRY_DELAYS_MS, createClipboardText, type TextClipboard } from './clipboard'

/**
 * A clipboard another program can hold, as Windows' is: while it is held,
 * Electron's write is dropped and its read gives `''`, and neither says so.
 */
function windowsClipboard(initial = 'before'): TextClipboard & {
  held: boolean
  /** What is on it, with nothing in the way. */
  content: string
  /** Text as Windows hands it back, with CRLF line endings. */
  crlf: boolean
  /** What it says it holds while held: nothing, as for a write left open, or text, as for a reader. */
  heldFormats: string[]
  writes: string[]
} {
  const board = {
    held: false,
    content: initial,
    crlf: false,
    heldFormats: [] as string[],
    writes: [] as string[],
    writeText(text: string) {
      board.writes.push(text)
      if (!board.held) board.content = text
    },
    readText() {
      if (board.held) return ''
      return board.crlf ? board.content.replace(/\n/g, '\r\n') : board.content
    },
    availableFormats() {
      if (board.held) return board.heldFormats
      return board.content === '' ? [] : ['text/plain']
    }
  }
  return board
}

const TOTAL_PAUSE_MS = CLIPBOARD_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)

/** Whether a promise has settled, without waiting for it. */
async function settled<T>(promise: Promise<T>): Promise<boolean> {
  let done = false
  void promise.then(
    () => (done = true),
    () => (done = true)
  )
  await vi.advanceTimersByTimeAsync(0)
  return done
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('writing the clipboard', () => {
  it('writes once when the clipboard takes it', async () => {
    const board = windowsClipboard()
    await expect(createClipboardText(board).write('C:\\p\\a.ts')).resolves.toBe('copied')
    expect(board.writes).toEqual(['C:\\p\\a.ts'])
    expect(board.content).toBe('C:\\p\\a.ts')
  })

  it('writes again after a pause while another program holds the clipboard, until it lets go', async () => {
    const board = windowsClipboard()
    board.held = true
    const writing = createClipboardText(board).write('copied text')
    expect(await settled(writing)).toBe(false)
    expect(board.writes).toHaveLength(1)

    // Each pause ends in another try.
    await vi.advanceTimersByTimeAsync(CLIPBOARD_RETRY_DELAYS_MS[0]!)
    expect(board.writes).toHaveLength(2)

    board.held = false
    await vi.advanceTimersByTimeAsync(CLIPBOARD_RETRY_DELAYS_MS[1]!)
    await expect(writing).resolves.toBe('copied')
    expect(board.writes).toHaveLength(3)
    expect(board.content).toBe('copied text')
  })

  it('gives up as refused once every pause has passed, and not before', async () => {
    const board = windowsClipboard()
    board.held = true
    const writing = createClipboardText(board).write('copied text')

    await vi.advanceTimersByTimeAsync(TOTAL_PAUSE_MS - 1)
    expect(await settled(writing)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(writing).resolves.toBe('refused')
    expect(board.writes).toHaveLength(CLIPBOARD_RETRY_DELAYS_MS.length + 1)
    expect(board.content).toBe('before')
  })

  it('stops retrying a copy that a later one replaced, so the later one stays on the clipboard', async () => {
    const board = windowsClipboard()
    const clipboard = createClipboardText(board)
    board.held = true
    const first = clipboard.write('first')
    await vi.advanceTimersByTimeAsync(0)

    board.held = false
    await expect(clipboard.write('second')).resolves.toBe('copied')
    await vi.advanceTimersByTimeAsync(TOTAL_PAUSE_MS)
    await expect(first).resolves.toBe('superseded')
    expect(board.content).toBe('second')
    expect(board.writes).toEqual(['first', 'second'])
  })

  it('counts text handed back with CRLF line endings as the text it wrote', async () => {
    const board = windowsClipboard()
    board.crlf = true
    await expect(createClipboardText(board).write('one\ntwo\n')).resolves.toBe('copied')
    expect(board.writes).toHaveLength(1)
  })
})

describe('reading the clipboard', () => {
  it('reads text at once', async () => {
    await expect(createClipboardText(windowsClipboard('some text')).read()).resolves.toEqual({ text: 'some text' })
  })

  it('answers an empty clipboard at once, without retrying', async () => {
    const board = windowsClipboard('')
    const reading = createClipboardText(board).read()
    expect(await settled(reading)).toBe(true)
    await expect(reading).resolves.toEqual({ text: '' })
  })

  it('reads again while a program holds a clipboard that says it has text, until it lets go', async () => {
    const board = windowsClipboard('some text')
    board.held = true
    board.heldFormats = ['text/plain']
    const reading = createClipboardText(board).read()
    await vi.advanceTimersByTimeAsync(CLIPBOARD_RETRY_DELAYS_MS[0]!)
    expect(await settled(reading)).toBe(false)

    board.held = false
    await vi.advanceTimersByTimeAsync(CLIPBOARD_RETRY_DELAYS_MS[1]!)
    await expect(reading).resolves.toEqual({ text: 'some text' })
  })

  it('reports a read that stays refused once every pause has passed', async () => {
    const board = windowsClipboard('some text')
    board.held = true
    board.heldFormats = ['text/plain']
    const reading = createClipboardText(board).read()
    await vi.advanceTimersByTimeAsync(TOTAL_PAUSE_MS - 1)
    expect(await settled(reading)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(reading).resolves.toEqual({ refused: true })
  })
})
