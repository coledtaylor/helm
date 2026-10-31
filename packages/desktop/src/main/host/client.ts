import type { Readable, Writable } from 'node:stream'
import { FrameDecoder, encodeFrame, type FrameError } from './frame'
import {
  DEFAULT_INITIAL_CREDIT,
  MAX_DATA_CHUNK,
  PROTOCOL_VERSION,
  type Capability,
  type ErrorCode,
  type EventChannels,
  type Message,
  type RequestChannels,
  type StreamChannels,
  type Welcome
} from './protocol'

/**
 * The desktop's side of a connection to the host: the protocol over a pair of
 * byte streams, which in Helm are `floti bridge`'s standard output (the host's
 * frames) and standard input (the desktop's).
 *
 * It speaks the crate's three kinds of traffic and nothing else. Requests get
 * a response or an error reply. Subscriptions get a snapshot when the channel
 * carries state, then numbered events; a gap in the numbers resubscribes for
 * a fresh snapshot, as `message.rs` says a client does. Byte streams, which
 * the desktop opens, carry a terminal's output from the host and its input to
 * it on the one stream, under the credit `flow.rs` describes: each direction
 * starts with `DEFAULT_INITIAL_CREDIT`, the desktop never sends past what the
 * host granted, and it returns credit as the bytes it was sent are consumed.
 *
 * Stream bytes are handed on as they came. Nothing here reads them: Helm
 * renders nothing for a live session.
 */

export type RequestChannel = keyof RequestChannels
export type EventChannel = keyof EventChannels
export type StreamChannel = keyof StreamChannels

/** The two byte streams a connection runs over. */
export interface HostTransport {
  /** The host's frames, arriving. */
  input: Readable
  /** The desktop's frames, leaving. Ended when the connection is closed. */
  output: Writable
}

export interface ConnectOptions {
  transport: HostTransport
  /** Helm's own version, for the `hello`'s client name. */
  appVersion: string
  /** A line for Helm's log. Never given a payload, a frame or stream bytes. */
  log?: (line: string) => void
}

/** The host refused the `hello`: a sentence naming both versions and which side to update. */
export class HostRefusedError extends Error {
  override name = 'HostRefusedError'
}

/** A request or subscription the host answered with an error reply. */
export class HostRequestError extends Error {
  override name = 'HostRequestError'
  constructor(
    readonly channel: string,
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
  }
}

/** The connection ended, or was closed, before what was asked of it finished. */
export class HostConnectionEnded extends Error {
  override name = 'HostConnectionEnded'
}

export interface SubscriptionHandlers<C extends EventChannel> {
  /** The channel's whole state, first on a channel that carries it, and again after a resubscribe. */
  snapshot?: (state: EventChannels[C]['snapshot']) => void
  event: (event: EventChannels[C]['event']) => void
  /** The host refused the subscription, or the connection ended. Nothing arrives after it. */
  error?: (error: Error) => void
}

export interface HostSubscription {
  unsubscribe(): void
}

export interface StreamHandlers {
  /** Bytes from the host, in order and unread. */
  data: (bytes: Uint8Array) => void
  /**
   * The host closed the stream (with its reason when it did not end normally),
   * or the connection ended. Not called for a close this side asked for.
   */
  close?: (reason: string | null) => void
  /**
   * When true, the host's credit comes back only as the caller says the bytes
   * were consumed (`consumed`), so a slow consumer slows the host's sending.
   * Otherwise it comes back once `data` returns.
   */
  manualCredit?: boolean
}

export interface HostStream {
  readonly id: number
  /** Queues bytes for the host, sent as its credit allows. False once the stream is closed. */
  write(bytes: Uint8Array): boolean
  /** Says `bytes` of what `data` was handed have been consumed, returning that credit. */
  consumed(bytes: number): void
  /** Closes the stream from this side. */
  close(): void
}

export interface HostConnection {
  readonly welcome: Welcome
  request<C extends RequestChannel>(
    channel: C,
    payload: RequestChannels[C]['request']
  ): Promise<RequestChannels[C]['response']>
  subscribe<C extends EventChannel>(channel: C, handlers: SubscriptionHandlers<C>): HostSubscription
  openStream<C extends StreamChannel>(
    channel: C,
    params: StreamChannels[C]['open'],
    handlers: StreamHandlers
  ): HostStream
  /** Ends the connection: the output is ended and everything still waiting fails. */
  close(): void
  /** Settles once the connection has ended, with the sentence that says why. */
  readonly ended: Promise<string>
}

/**
 * What the desktop says it can do; the host ignores names it does not know.
 * `browser`: its browser pane answers the browser tools' calls (`browser-tools.ts`).
 * `pluginPages`: it draws plugins' pages, from files the host serves (`plugins.ts`).
 */
const CAPABILITIES: Capability[] = ['terminal', 'files', 'browser', 'pluginPages']

/**
 * Credit is returned once this much has been consumed rather than per chunk,
 * so a busy terminal does not answer every frame with one. Below a quarter of
 * the initial credit unreturned, the host always has credit left to send.
 */
const CREDIT_RETURN_AT = DEFAULT_INITIAL_CREDIT / 4

/** Says hello on `transport` and resolves once the host welcomed it. */
export function connectHost(options: ConnectOptions): Promise<HostConnection> {
  return new Connection(options).open()
}

type Pending = {
  channel: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface Subscription {
  channel: string
  handlers: SubscriptionHandlers<EventChannel>
  /** The sequence number the next event must carry; null until the first one. */
  expected: number | null
  /** Whether a snapshot has arrived, which says the channel carries state. */
  stateful: boolean
  /** The number it is subscribed under now; a resubscribe takes a new one. Null once it has ended. */
  id: number | null
}

interface OpenStream {
  handlers: StreamHandlers
  /** What the host may still send. */
  receive: number
  /** Consumed and not yet returned. */
  unreturned: number
  /** What this side may still send. */
  send: number
  held: Uint8Array[]
}

class Connection implements HostConnection {
  private readonly decoder = new FrameDecoder()
  private readonly pending = new Map<number, Pending>()
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly streams = new Map<number, OpenStream>()
  private nextRequest = 1
  private nextSubscription = 1
  private nextStream = 1
  private welcomed: Welcome | null = null
  private greeting: {
    resolve: (welcome: Welcome) => void
    reject: (error: Error) => void
  } | null = null
  private endedWith: string | null = null
  private settleEnded: (why: string) => void = () => {}
  readonly ended: Promise<string>

  constructor(private readonly options: ConnectOptions) {
    this.ended = new Promise((resolve) => {
      this.settleEnded = resolve
    })
  }

  get welcome(): Welcome {
    if (this.welcomed === null) throw new Error('The host has not welcomed this connection yet.')
    return this.welcomed
  }

  open(): Promise<HostConnection> {
    const { input, output } = this.options.transport
    input.on('data', (chunk: Uint8Array) => this.received(chunk))
    input.once('end', () => this.end(this.decoder.finish() ?? 'The connection to the local host ended.'))
    input.once('close', () => this.end('The connection to the local host ended.'))
    input.once('error', (error) => this.end(`The connection to the local host failed: ${error.message}`))
    output.once('error', (error) => this.end(`The connection to the local host failed: ${error.message}`))
    output.once('close', () => this.end('The connection to the local host ended.'))

    const welcomed = new Promise<Welcome>((resolve, reject) => {
      this.greeting = { resolve, reject }
    })
    this.send({
      type: 'hello',
      protocol: {
        major: PROTOCOL_VERSION.major,
        minor: PROTOCOL_VERSION.minor
      },
      client: { name: `Helm ${this.options.appVersion}`, kind: 'desktop' },
      capabilities: [...CAPABILITIES]
    })
    return welcomed.then((welcome) => {
      this.welcomed = welcome
      return this
    })
  }

  request<C extends RequestChannel>(
    channel: C,
    payload: RequestChannels[C]['request']
  ): Promise<RequestChannels[C]['response']> {
    if (this.endedWith !== null) return Promise.reject(new HostConnectionEnded(this.endedWith))
    const id = this.nextRequest++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        channel,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.send({ type: 'request', id, channel, payload })
    })
  }

  subscribe<C extends EventChannel>(channel: C, handlers: SubscriptionHandlers<C>): HostSubscription {
    const subscription: Subscription = {
      channel,
      handlers: handlers as unknown as SubscriptionHandlers<EventChannel>,
      expected: null,
      stateful: false,
      id: null
    }
    if (this.endedWith !== null) {
      const why = this.endedWith
      queueMicrotask(() => handlers.error?.(new HostConnectionEnded(why)))
    } else {
      this.startSubscription(subscription)
    }
    return {
      unsubscribe: () => {
        const id = subscription.id
        if (id === null || this.subscriptions.get(id) !== subscription) return
        this.subscriptions.delete(id)
        subscription.id = null
        this.send({ type: 'unsubscribe', subscription: id })
      }
    }
  }

  openStream<C extends StreamChannel>(
    channel: C,
    params: StreamChannels[C]['open'],
    handlers: StreamHandlers
  ): HostStream {
    const id = this.nextStream++
    const open: OpenStream = {
      handlers,
      receive: DEFAULT_INITIAL_CREDIT,
      unreturned: 0,
      send: DEFAULT_INITIAL_CREDIT,
      held: []
    }
    if (this.endedWith !== null) {
      const why = this.endedWith
      queueMicrotask(() => handlers.close?.(why))
    } else {
      this.streams.set(id, open)
      this.send({ type: 'streamOpen', stream: id, channel, params })
    }
    return {
      id,
      write: (bytes) => {
        if (this.streams.get(id) !== open) return false
        if (bytes.length > 0) open.held.push(bytes)
        this.flushStream(id, open)
        return true
      },
      consumed: (bytes) => this.consumed(id, open, bytes),
      close: () => {
        if (this.streams.get(id) !== open) return
        this.streams.delete(id)
        this.send({ type: 'streamClose', stream: id, reason: null })
      }
    }
  }

  close(): void {
    if (this.endedWith !== null) return
    this.end('The connection to the local host was closed.')
  }

  private startSubscription(subscription: Subscription): void {
    const id = this.nextSubscription++
    subscription.id = id
    this.subscriptions.set(id, subscription)
    this.send({
      type: 'subscribe',
      subscription: id,
      channel: subscription.channel
    })
  }

  private received(chunk: Uint8Array): void {
    if (this.endedWith !== null) return
    this.decoder.push(chunk)
    for (;;) {
      let next
      try {
        next = this.decoder.next()
      } catch (error) {
        this.end(`The local host sent a frame Helm cannot read: ${(error as FrameError).message}`)
        return
      }
      if (next === null) return
      if ('malformed' in next) {
        this.options.log?.(`host: skipped a frame that does not decode (${next.malformed.message})`)
        continue
      }
      this.dispatch(next.message)
      if (this.endedWith !== null) return
    }
  }

  private dispatch(message: Message): void {
    if (this.greeting !== null) {
      const greeting = this.greeting
      this.greeting = null
      if (message.type === 'welcome') {
        greeting.resolve(message)
      } else if (message.type === 'refused') {
        greeting.reject(new HostRefusedError(message.message))
        this.end(message.message)
      } else {
        const why = `The local host answered Helm's hello with ${message.type} rather than a welcome.`
        greeting.reject(new HostConnectionEnded(why))
        this.end(why)
      }
      return
    }
    switch (message.type) {
      case 'response': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        pending.resolve(message.payload)
        return
      }
      case 'error': {
        const pending = this.pending.get(message.id)
        if (pending === undefined) return
        this.pending.delete(message.id)
        pending.reject(new HostRequestError(message.channel, message.code, message.message))
        return
      }
      case 'snapshot': {
        const subscription = this.subscriptions.get(message.subscription)
        if (subscription === undefined) return
        subscription.stateful = true
        subscription.expected = message.seq + 1
        subscription.handlers.snapshot?.(message.state as never)
        return
      }
      case 'event': {
        const subscription = this.subscriptions.get(message.subscription)
        if (subscription === undefined) return
        if (subscription.expected !== null && message.seq !== subscription.expected && subscription.stateful) {
          this.resubscribe(message.subscription, subscription)
          return
        }
        subscription.expected = message.seq + 1
        subscription.handlers.event(message.payload as never)
        return
      }
      case 'subscriptionError': {
        const subscription = this.subscriptions.get(message.subscription)
        if (subscription === undefined) return
        this.subscriptions.delete(message.subscription)
        subscription.handlers.error?.(new HostRequestError(message.channel, message.code, message.message))
        return
      }
      case 'streamData':
        return this.streamData(message.stream, message.data)
      case 'streamCredit': {
        const open = this.streams.get(message.stream)
        if (open === undefined) return
        open.send += message.bytes
        this.flushStream(message.stream, open)
        return
      }
      case 'streamClose': {
        const open = this.streams.get(message.stream)
        if (open === undefined) return
        this.streams.delete(message.stream)
        open.handlers.close?.(message.reason)
        return
      }
      case 'streamOpen':
        // The desktop opens every stream; one the host opens is refused.
        this.send({
          type: 'streamClose',
          stream: message.stream,
          reason: 'This client opens its own streams and accepts none from the host.'
        })
        return
      default:
        // hello, welcome, refused, request, subscribe and unsubscribe are
        // never the host's to send after the handshake.
        this.options.log?.(`host: ignored a ${message.type} message`)
    }
  }

  private resubscribe(stale: number, subscription: Subscription): void {
    this.subscriptions.delete(stale)
    this.send({ type: 'unsubscribe', subscription: stale })
    subscription.expected = null
    subscription.stateful = false
    this.startSubscription(subscription)
  }

  private streamData(id: number, data: Uint8Array): void {
    const open = this.streams.get(id)
    if (open === undefined) return
    if (data.length > open.receive) {
      // The host broke the protocol; this stream goes, the connection stays.
      const reason = `The local host sent ${data.length} bytes on stream ${id} with ${open.receive} bytes of credit.`
      this.streams.delete(id)
      this.send({ type: 'streamClose', stream: id, reason })
      open.handlers.close?.(reason)
      return
    }
    open.receive -= data.length
    open.handlers.data(data)
    if (open.handlers.manualCredit !== true) this.consumed(id, open, data.length)
  }

  private consumed(id: number, open: OpenStream, bytes: number): void {
    if (this.streams.get(id) !== open || bytes <= 0) return
    open.unreturned += bytes
    if (open.unreturned < CREDIT_RETURN_AT) return
    const returned = open.unreturned
    open.unreturned = 0
    open.receive += returned
    this.send({ type: 'streamCredit', stream: id, bytes: returned })
  }

  /** Sends what the host's credit allows, in chunks of at most `MAX_DATA_CHUNK`. */
  private flushStream(id: number, open: OpenStream): void {
    while (open.send > 0 && open.held.length > 0) {
      const room = Math.min(open.send, MAX_DATA_CHUNK)
      const parts: Uint8Array[] = []
      let size = 0
      while (size < room && open.held.length > 0) {
        const head = open.held[0]!
        const part = Math.min(head.length, room - size)
        parts.push(head.subarray(0, part))
        size += part
        if (part === head.length) open.held.shift()
        else open.held[0] = head.subarray(part)
      }
      const data = parts.length === 1 ? parts[0]! : concat(parts, size)
      open.send -= size
      this.send({ type: 'streamData', stream: id, data })
    }
  }

  private send(message: Message): void {
    if (this.endedWith !== null) return
    const { output } = this.options.transport
    if (output.writableEnded || output.destroyed) return
    output.write(encodeFrame(message))
  }

  /** Ends the connection once, failing everything still waiting with `why`. */
  private end(why: string): void {
    if (this.endedWith !== null) return
    this.endedWith = why
    const { output } = this.options.transport
    if (!output.writableEnded && !output.destroyed) output.end()

    const greeting = this.greeting
    this.greeting = null
    greeting?.reject(new HostConnectionEnded(why))

    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const call of pending) {
      call.reject(new HostConnectionEnded(`${withoutStop(why)} before the host answered ${call.channel}.`))
    }
    const subscriptions = [...this.subscriptions.values()]
    this.subscriptions.clear()
    for (const subscription of subscriptions) subscription.handlers.error?.(new HostConnectionEnded(why))
    const streams = [...this.streams.values()]
    this.streams.clear()
    for (const open of streams) open.handlers.close?.(why)
    this.settleEnded(why)
  }
}

function withoutStop(sentence: string): string {
  return sentence.endsWith('.') ? sentence.slice(0, -1) : sentence
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
