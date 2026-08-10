import { closeSync, openSync, readSync, statSync } from 'node:fs'

/**
 * Reading the part of an append-only file that has appeared since last time.
 *
 * Extracted because two indexes now need exactly this and the byte arithmetic
 * is the part that is easy to get subtly wrong: `history.jsonl` for the session
 * index (M4) and `projects/*.jsonl` for the usage index. Both are written by
 * Claude Code while Helm reads them, both only ever grow, and both would
 * otherwise be re-read whole - 875 KB and 214 MB respectively - to learn about
 * one appended line.
 */

export interface TailRead {
  /**
   * Complete lines only. Everything after the final newline is a record still
   * being written and is left for the next pass.
   */
  text: string
  /**
   * Byte offset the next pass should resume from - always the byte after a
   * `\n`, which is also why reading from it cannot split a UTF-8 sequence.
   */
  bytes: number
  /**
   * The file is not the one the cursor belonged to: it shrank, or it is gone.
   * The caller has to discard what it had rather than append to it.
   */
  reset: boolean
  /** Set when the file could not be read at all. */
  error?: string
}

/**
 * Bytes `fromBytes`..EOF, truncated to the last complete line.
 *
 * The two things that break a naive cursor are handled explicitly: a file
 * smaller than the cursor is a different file (rotated, cleared, or a different
 * `CLAUDE_CONFIG_DIR`) and forces a full re-read from zero, and a trailing
 * fragment with no newline is left unconsumed.
 */
export function readTail(file: string, fromBytes: number): TailRead {
  let size: number
  try {
    size = statSync(file).size
  } catch (err) {
    return {
      text: '',
      bytes: 0,
      reset: true,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  const reset = size < fromBytes
  const start = reset ? 0 : fromBytes
  if (size === start) return { text: '', bytes: size, reset }

  const length = size - start
  const buffer = Buffer.allocUnsafe(length)
  let read = 0
  const fd = openSync(file, 'r')
  try {
    // `readSync` is allowed to return short. Loop rather than assume.
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n === 0) break
      read += n
    }
  } catch (err) {
    return {
      text: '',
      bytes: fromBytes,
      reset: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    closeSync(fd)
  }

  const chunk = buffer.subarray(0, read)
  // The *byte* length of the trailing fragment - not its character length - is
  // what the cursor has to be held back by.
  const lastBreak = chunk.lastIndexOf(0x0a)
  const complete = lastBreak < 0 ? Buffer.alloc(0) : chunk.subarray(0, lastBreak + 1)

  return { text: complete.toString('utf8'), bytes: start + complete.length, reset }
}
