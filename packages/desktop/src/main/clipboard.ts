import type { ClipboardRead, ClipboardWriteOutcome } from '../shared/ipc'

/**
 * Text in and out of the system clipboard, for the copies and pastes Helm makes
 * itself: a terminal's selection, a file's path.
 *
 * Electron's `writeText` and `readText` never say they failed. On Windows the
 * clipboard is one lock for the whole desktop: while another program has it
 * open, `OpenClipboard` is refused, Chromium tries five times over 25ms, and
 * then a write is dropped and a read gives `''`, without a word to anyone.
 * Clipboard managers, sync tools and remote-desktop clients open it after
 * every change, and a program that opens it and never closes it locks every
 * other program out until it exits.
 *
 * So a write is read back to see whether it landed, and written again after a
 * short and growing pause until it does or the pauses run out; the caller is
 * told which, so the surface that copied can say it could not. A read that
 * comes back empty while the clipboard says it holds text is tried again on
 * the same pauses, and reported as refused if it never gets through.
 *
 * Nothing here differs by OS. The read-back is how a refused write is seen on
 * every platform; macOS and Linux just never refuse in practice.
 */

/** The part of Electron's `clipboard` this uses, so a test can stand in for it. */
export interface TextClipboard {
  writeText(text: string): void
  readText(): string
  availableFormats(): string[]
}

/**
 * The pauses between tries, in milliseconds: about 0.6s in all, past which a
 * person who pressed copy has moved on and needs telling instead.
 */
export const CLIPBOARD_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80, 160, 320]

export interface ClipboardText {
  write(text: string): Promise<ClipboardWriteOutcome>
  read(): Promise<ClipboardRead>
}

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * The text as the clipboard gives it back: Windows may hand back CRLF line
 * endings, and a NUL ends the text it stores.
 */
function asStored(text: string): string {
  const nul = text.indexOf('\0')
  return (nul === -1 ? text : text.slice(0, nul)).replace(/\r\n/g, '\n')
}

export function createClipboardText(
  board: TextClipboard,
  delays: readonly number[] = CLIPBOARD_RETRY_DELAYS_MS
): ClipboardText {
  // Each write takes a number; a later write supersedes an earlier one still
  // retrying, which would otherwise land last and put back what the person
  // copied before.
  let latest = 0

  const landed = (text: string): boolean => asStored(board.readText()) === asStored(text)

  return {
    async write(text) {
      const mine = ++latest
      for (let attempt = 0; ; attempt++) {
        board.writeText(text)
        if (landed(text)) return 'copied'
        if (attempt === delays.length) return 'refused'
        await pause(delays[attempt]!)
        if (mine !== latest) return 'superseded'
      }
    },

    async read() {
      const first = board.readText()
      if (first !== '') return { text: first }
      // Empty because there is no text (nothing copied, or an image) is the
      // common case and is answered at once.
      if (!board.availableFormats().includes('text/plain')) return { text: '' }
      for (const delay of delays) {
        await pause(delay)
        const text = board.readText()
        if (text !== '') return { text }
      }
      return { refused: true }
    }
  }
}
