import { describe, expect, it } from 'vitest'
import { FrameDecoder, encodeFrame } from '../../../../shared/host/frame'
import { PROTOCOL_VERSION, type Message } from '../../../../shared/host/protocol'
import type { EventChannel, EventPayload, HostLinkOpened } from '../../../../shared/ipc'
import { WINDOW_CAPABILITIES, createPageLink, type PageLinkDeps } from './link'

const UNREACHABLE =
  'No local host answered on its socket; turn off “Run sessions in the local host” in Settings to use Helm’s own sessions.'

/**
 * Main and the host behind it, as the page sees them over `hostLink:*`: each
 * open answers what the test said, and each connection's frames are read by a
 * host that welcomes the hello and answers `history:summary`.
 */
class FakeMain {
  readonly opens: HostLinkOpened[] = []
  readonly hellos: Message[] = []
  readonly closed: number[] = []
  private next = 1
  private readonly listeners = new Map<string, Set<(payload: never) => void>>()
  private readonly decoders = new Map<number, FrameDecoder>()
  answer: () => HostLinkOpened = () => ({ inHost: true, connection: this.next++, appVersion: '2.9.0' })

  readonly bridge: PageLinkDeps['bridge'] = {
    invoke: ((channel: string) => {
      if (channel !== 'hostLink:open') return Promise.reject(new Error(`unexpected ${channel}`))
      const opened = this.answer()
      this.opens.push(opened)
      return Promise.resolve(opened)
    }) as PageLinkDeps['bridge']['invoke'],
    send: ((channel: string, payload: { connection: number; bytes?: Uint8Array }) => {
      if (channel === 'hostLink:close') {
        this.closed.push(payload.connection)
        return
      }
      if (channel !== 'hostLink:send' || payload.bytes === undefined) return
      const decoder = this.decoders.get(payload.connection) ?? new FrameDecoder()
      this.decoders.set(payload.connection, decoder)
      decoder.push(payload.bytes)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if ('malformed' in next) throw next.malformed
        this.received(payload.connection, next.message)
      }
    }) as PageLinkDeps['bridge']['send'],
    on: ((channel: string, listener: (payload: never) => void) => {
      const set = this.listeners.get(channel) ?? new Set()
      set.add(listener)
      this.listeners.set(channel, set)
      return () => set.delete(listener)
    }) as PageLinkDeps['bridge']['on']
  }

  /** Whether the host welcomes the hello; when false, the bridge ends with `why` instead. */
  welcome: { why: string } | true = true

  private received(connection: number, message: Message): void {
    if (message.type === 'hello') {
      this.hellos.push(message)
      if (this.welcome === true) {
        this.reply(connection, {
          type: 'welcome',
          protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
          hostVersion: '1.0.0',
          capabilities: ['terminal'],
          backends: []
        })
      } else {
        this.end(connection, this.welcome.why)
      }
      return
    }
    if (message.type === 'request') this.reply(connection, { type: 'response', id: message.id, payload: 'answered' })
  }

  private reply(connection: number, message: Message): void {
    queueMicrotask(() => this.emit('hostLink:data', { connection, bytes: encodeFrame(message) }))
  }

  emit<K extends EventChannel>(channel: K, payload: EventPayload<K>): void {
    for (const listener of this.listeners.get(channel) ?? []) (listener as (payload: EventPayload<K>) => void)(payload)
  }

  /** The bridge ends, as main says when it exits. */
  end(connection: number, why: string | null): void {
    queueMicrotask(() => this.emit('hostLink:ended', { connection, why }))
  }
}

function world() {
  const main = new FakeMain()
  const link = createPageLink({ bridge: main.bridge, capabilities: WINDOW_CAPABILITIES })
  return { main, link }
}

describe('a Helm page’s own connection to the local host', () => {
  it('learns whether sessions run in the host from the first open, and connects on that same open', async () => {
    const w = world()
    expect(await w.link.inHost()).toBe(true)
    await w.link.connection()
    expect(w.main.opens).toHaveLength(1)
    expect(w.main.hellos).toEqual([
      {
        type: 'hello',
        protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
        client: { name: 'Helm 2.9.0', kind: 'desktop' },
        capabilities: ['terminal', 'files', 'pluginPages']
      }
    ])
  })

  it('never declares the browser: the window’s connection answers no browser tool', () => {
    expect(WINDOW_CAPABILITIES).not.toContain('browser')
  })

  it('says sessions do not run in the host when main says so, and connects to nothing', async () => {
    const w = world()
    w.main.answer = () => ({ inHost: false })
    expect(await w.link.inHost()).toBe(false)
    expect(w.main.hellos).toEqual([])
  })

  it('has every caller join one connect, so a read asked before it settled waits for the host’s answer', async () => {
    const w = world()
    const subscribed: string[] = []
    w.link.onConnected(() => subscribed.push('connected'))
    const [a, b, c] = await Promise.all([w.link.connection(), w.link.connection(), w.link.connection()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(w.main.opens).toHaveLength(1)
    expect(subscribed).toEqual(['connected'])
    expect(await a.request('history:summary', null)).toBe('answered')
  })

  it('rejects with the sentence naming the setting when the host cannot be reached, never answering empty', async () => {
    const w = world()
    w.main.answer = () => ({ inHost: true, unreachable: UNREACHABLE })
    await expect(w.link.connection()).rejects.toThrow(UNREACHABLE)
    // And asks again the next time, as main's link does.
    await expect(w.link.connection()).rejects.toThrow(UNREACHABLE)
    expect(w.main.opens).toHaveLength(2)
  })

  it('rejects with the bridge’s sentence when it ends before the host welcomed the page', async () => {
    const w = world()
    const why = 'The local host did not prove the key Helm expected, so Helm did not connect to it; turn off …'
    w.main.welcome = { why }
    await expect(w.link.connection()).rejects.toThrow(why)
  })

  it('connects again when wanted after the connection ended', async () => {
    const w = world()
    const first = await w.link.connection()
    w.main.end(1, null)
    expect(await first.ended).toBe('The connection to the local host ended.')
    const second = await w.link.connection()
    expect(second).not.toBe(first)
    expect(w.main.opens).toHaveLength(2)
  })

  it('tells main when it closes its connection', async () => {
    const w = world()
    const connection = await w.link.connection()
    connection.close()
    expect(w.main.closed).toEqual([1])
  })
})
