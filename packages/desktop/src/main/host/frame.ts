import { decode, encode, type DecodeOptions, type EncodeOptions } from 'cborg'
import { MAX_FRAME_LEN, type Message } from './protocol'

/**
 * Frames, as `floti_protocol::frame` makes them: a 4-byte big-endian length,
 * then one CBOR value of that length. Byte strings are `Uint8Array`s both ways.
 *
 * The encoding is pinned to the crate's: a test decodes frames the crate wrote
 * (`floti-protocol.frames.json`, which the crate's own test keeps current),
 * encodes them again and gets the same bytes. That is why maps keep the order
 * their keys were written in rather than cborg's canonical sort (the crate
 * writes a struct's fields in declaration order, `type` first), and why floats
 * take the smallest width that holds them exactly, as ciborium does.
 */

const PREFIX_LEN = 4

const ENCODE: EncodeOptions = {
  // Every pair compares equal and the sort is stable, so keys stay in the
  // order they were written: serde writes fields in declaration order.
  mapSorter: () => 0,
  float64: false,
  // An optional field left out, rather than CBOR's `undefined`, which the
  // crate does not read.
  ignoreUndefinedProperties: true
}

const DECODE: DecodeOptions = {
  // The crate never writes these; a frame that holds one is not the crate's.
  allowUndefined: false,
  allowIndefinite: true,
  rejectDuplicateMapKeys: true
}

/** A message that cannot be framed, or a frame whose body does not decode. */
export class FrameError extends Error {
  override name = 'FrameError'
}

/** One message as one frame. */
export function encodeFrame(message: Message): Uint8Array {
  const body = encode(message, ENCODE)
  if (body.length > MAX_FRAME_LEN) {
    throw new FrameError(`A ${body.length}-byte frame exceeds the ${MAX_FRAME_LEN}-byte limit.`)
  }
  const frame = new Uint8Array(PREFIX_LEN + body.length)
  new DataView(frame.buffer).setUint32(0, body.length, false)
  frame.set(body, PREFIX_LEN)
  return frame
}

/** A whole frame's body, decoded. */
export function decodeBody(body: Uint8Array): Message {
  let value: unknown
  try {
    value = decode(body, DECODE)
  } catch (error) {
    throw new FrameError(`The ${body.length}-byte frame does not hold one CBOR value: ${(error as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string') {
    throw new FrameError('The frame holds a CBOR value that is not a message.')
  }
  return value as Message
}

/** What the decoder hands back for each whole frame. */
export type Decoded = { message: Message } | { malformed: FrameError }

/**
 * Turns bytes, split anywhere, back into messages, in order.
 *
 * As the crate's decoder does, it checks a length prefix against
 * `MAX_FRAME_LEN` before buffering anything of the body, and buffers only
 * bytes that have arrived. A frame over the limit loses the framing for good,
 * so the decoder stays failed; a body that does not decode inside a valid
 * frame is reported and skipped, since the next frame still starts where the
 * length said.
 */
export class FrameDecoder {
  private chunks: Uint8Array[] = []
  private size = 0
  private failure: FrameError | null = null

  /** Bytes as they arrived. Ignored once the decoder has failed. */
  push(bytes: Uint8Array): void {
    if (this.failure !== null || bytes.length === 0) return
    this.chunks.push(bytes)
    this.size += bytes.length
  }

  /** The next whole frame, or `null` while one is still arriving. Throws once framing is lost. */
  next(): Decoded | null {
    if (this.failure !== null) throw this.failure
    if (this.size < PREFIX_LEN) return null
    const prefix = this.peek(PREFIX_LEN)
    const len = new DataView(prefix.buffer, prefix.byteOffset, PREFIX_LEN).getUint32(0, false)
    if (len > MAX_FRAME_LEN) {
      this.failure = new FrameError(`A frame of ${len} bytes is over the ${MAX_FRAME_LEN}-byte limit.`)
      this.chunks = []
      this.size = 0
      throw this.failure
    }
    if (this.size < PREFIX_LEN + len) return null
    this.take(PREFIX_LEN)
    const body = this.take(len)
    try {
      return { message: decodeBody(body) }
    } catch (error) {
      return { malformed: error as FrameError }
    }
  }

  /** Bytes received and not yet returned as a frame. */
  buffered(): number {
    return this.size
  }

  /** Call when the connection ends: a sentence if it ended inside a frame, else `null`. */
  finish(): string | null {
    if (this.failure !== null) return this.failure.message
    return this.size === 0 ? null : `The connection ended ${this.size} bytes into a frame.`
  }

  /** The first `n` buffered bytes, without consuming them. */
  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!
    if (first.length >= n) return first.subarray(0, n)
    return this.copy(n, false)
  }

  /** The first `n` buffered bytes, consumed. */
  private take(n: number): Uint8Array {
    const first = this.chunks[0]
    if (first !== undefined && first.length >= n) {
      const out = first.subarray(0, n)
      if (first.length === n) this.chunks.shift()
      else this.chunks[0] = first.subarray(n)
      this.size -= n
      return out
    }
    return this.copy(n, true)
  }

  private copy(n: number, consume: boolean): Uint8Array {
    const out = new Uint8Array(n)
    let at = 0
    let index = 0
    while (at < n) {
      const chunk = this.chunks[index]!
      const part = Math.min(chunk.length, n - at)
      out.set(chunk.subarray(0, part), at)
      at += part
      if (consume) {
        if (part === chunk.length) this.chunks.shift()
        else this.chunks[0] = chunk.subarray(part)
      } else {
        index += 1
      }
    }
    if (consume) this.size -= n
    return out
  }
}
