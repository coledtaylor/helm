import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FrameDecoder, decodeBody, encodeFrame, type Decoded } from './frame'
import { MAX_FRAME_LEN, PROTOCOL_VERSION, type Message } from './protocol'

/** Frames floti_protocol::encode_frame wrote; the crate's test fails when this file is stale. */
const FIXTURES = join(__dirname, '../../../../../crates/floti-protocol/generated/floti-protocol.frames.json')

function fixtures(): Record<string, Uint8Array> {
  const hex = JSON.parse(readFileSync(FIXTURES, 'utf8')) as Record<string, string>
  return Object.fromEntries(
    Object.entries(hex).map(([name, value]) => [name, Uint8Array.from(Buffer.from(value, 'hex'))])
  )
}

function messages(decoder: FrameDecoder): Message[] {
  const out: Message[] = []
  for (let next: Decoded | null = decoder.next(); next !== null; next = decoder.next()) {
    if ('malformed' in next) throw next.malformed
    out.push(next.message)
  }
  return out
}

function only(frame: Uint8Array): Message {
  const decoder = new FrameDecoder()
  decoder.push(frame)
  const [message, ...rest] = messages(decoder)
  expect(rest).toEqual([])
  expect(decoder.finish()).toBeNull()
  return message!
}

describe('frames', () => {
  it('decodes the crate’s frames of a hello, a response, an event and stream data, and encodes each to the same bytes', () => {
    const frames = fixtures()
    expect(Object.keys(frames).sort()).toEqual(['event', 'hello', 'response', 'streamData'])
    for (const [name, frame] of Object.entries(frames)) {
      expect(Buffer.from(encodeFrame(only(frame))).toString('hex'), name).toBe(Buffer.from(frame).toString('hex'))
    }
  })

  it('reads what the crate wrote: integers, floats, text, null, nesting and bytes', () => {
    const frames = fixtures()
    expect(only(frames['hello']!)).toEqual({
      type: 'hello',
      protocol: { major: 1, minor: 0 },
      client: { name: 'Helm 2.4.0', kind: 'desktop' },
      capabilities: ['terminal']
    })
    const response = only(frames['response']!)
    expect(response).toMatchObject({ type: 'response', id: 70_000 })
    expect((response as { payload: unknown }).payload).toEqual({
      id: 12,
      name: 'café → ✓ 日本',
      cwd: 'C:\\work\\my repos\\alpha',
      exitCode: -1,
      startedAt: 1.5,
      ratio: 0.1,
      wide: 65_504.5,
      pid: 4_294_967_296,
      large: 300,
      negative: -70_000,
      live: true,
      ended: false,
      endedAt: null,
      tags: ['a', 24, null],
      nested: { empty: {} }
    })
    expect(only(frames['event']!)).toEqual({
      type: 'event',
      subscription: 3,
      seq: 255,
      payload: [{ id: 1, state: 'busy', since: 1_767_225_600_000.25 }]
    })
    const data = only(frames['streamData']!) as Extract<Message, { type: 'streamData' }>
    expect(data.stream).toBe(24)
    expect(data.data).toBeInstanceOf(Uint8Array)
    const expected = Buffer.concat([
      Buffer.from('\x1b[38;2;255;100;0mcolour\x1b[0m ', 'latin1'),
      Buffer.from([0xe2, 0x9c, 0x00, 0xff, 0xfe, 0x80]),
      Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256))
    ])
    expect(Buffer.from(data.data).equals(expected)).toBe(true)
  })

  it('writes the desktop’s own hello byte for byte as the crate does', () => {
    const hello: Message = {
      type: 'hello',
      protocol: {
        major: PROTOCOL_VERSION.major,
        minor: PROTOCOL_VERSION.minor
      },
      client: { name: 'Helm 2.4.0', kind: 'desktop' },
      capabilities: ['terminal']
    }
    expect(Buffer.from(encodeFrame(hello)).toString('hex')).toBe(Buffer.from(fixtures()['hello']!).toString('hex'))
  })

  it('hands back messages in order however the bytes are split', () => {
    const frames = fixtures()
    const all = Buffer.concat([frames['hello']!, frames['streamData']!, frames['event']!, frames['response']!])
    const whole = new FrameDecoder()
    whole.push(all)
    const expected = messages(whole)
    expect(expected.map((message) => message.type)).toEqual(['hello', 'streamData', 'event', 'response'])

    for (const step of [1, 2, 3, 5, 7, 64, 333]) {
      const decoder = new FrameDecoder()
      const out: Message[] = []
      for (let at = 0; at < all.length; at += step) {
        decoder.push(all.subarray(at, at + step))
        out.push(...messages(decoder))
      }
      expect(out, `split every ${step} bytes`).toEqual(expected)
      expect(decoder.finish()).toBeNull()
    }
  })

  it('refuses a length over the limit before buffering any of its body, and stays failed', () => {
    const decoder = new FrameDecoder()
    const prefix = new Uint8Array(4)
    new DataView(prefix.buffer).setUint32(0, MAX_FRAME_LEN + 1, false)
    decoder.push(prefix)
    expect(() => decoder.next()).toThrow(
      `A frame of ${MAX_FRAME_LEN + 1} bytes is over the ${MAX_FRAME_LEN}-byte limit.`
    )
    expect(decoder.buffered()).toBe(0)
    decoder.push(fixtures()['hello']!)
    expect(decoder.buffered()).toBe(0)
    expect(() => decoder.next()).toThrow('over the')
    expect(decoder.finish()).toContain('over the')
  })

  it('reports a body that does not decode and goes on with the next frame', () => {
    const decoder = new FrameDecoder()
    decoder.push(Uint8Array.from([0, 0, 0, 2, 0x82, 0x01]))
    decoder.push(fixtures()['hello']!)
    const first = decoder.next()
    expect(first !== null && 'malformed' in first).toBe(true)
    const second = decoder.next()
    expect(second !== null && 'message' in second && second.message.type).toBe('hello')
  })

  it('says when the connection ended inside a frame', () => {
    const decoder = new FrameDecoder()
    decoder.push(fixtures()['event']!.subarray(0, 10))
    expect(decoder.next()).toBeNull()
    expect(decoder.finish()).toBe('The connection ended 10 bytes into a frame.')
  })

  it('refuses to encode a frame over the limit', () => {
    const data = new Uint8Array(MAX_FRAME_LEN)
    expect(() => encodeFrame({ type: 'streamData', stream: 1, data })).toThrow('exceeds the')
  })

  it('refuses a CBOR value that is not a message', () => {
    expect(() => decodeBody(Uint8Array.from([0x01]))).toThrow('not a message')
  })
})
