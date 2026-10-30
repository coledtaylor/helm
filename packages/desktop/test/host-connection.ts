import type {
  HostConnection,
  HostStream,
  HostSubscription,
  StreamHandlers,
  SubscriptionHandlers
} from '../src/main/host/client'
import type { LocalHost } from '../src/main/host/launcher'
import type { HostLink } from '../src/main/host/link'
import type { EventChannels, RequestChannels, StreamChannels } from '../src/main/host/protocol'

/**
 * A protocol client with no host behind it, for the adapters that sit on one:
 * each request is recorded and answered by what the test said, each
 * subscription's handlers are kept for the test to push to, and each stream
 * records what was written to it and takes what the test sends.
 */

type Answer = (payload: unknown) => unknown

export interface SentRequest {
  channel: string
  payload: unknown
}

export class FakeStream implements HostStream {
  readonly written: Uint8Array[] = []
  closed = false
  constructor(
    readonly id: number,
    readonly channel: string,
    readonly params: unknown,
    readonly handlers: StreamHandlers
  ) {}

  write(bytes: Uint8Array): boolean {
    if (this.closed) return false
    this.written.push(bytes)
    return true
  }

  consumed(): void {}

  close(): void {
    this.closed = true
  }

  /** What was written, as text. */
  text(): string {
    return this.written.map((bytes) => new TextDecoder().decode(bytes)).join('')
  }

  /** Bytes from the host. */
  send(bytes: Uint8Array | string): void {
    this.handlers.data(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes)
  }

  /** The host closes it. */
  end(reason: string | null = null): void {
    this.closed = true
    this.handlers.close?.(reason)
  }
}

export class FakeConnection {
  readonly welcome = {
    protocol: { major: 0, minor: 0 },
    hostVersion: 'test',
    capabilities: ['terminal' as const],
    backends: []
  }
  readonly sent: SentRequest[] = []
  readonly streams: FakeStream[] = []
  readonly subscriptions = new Map<string, SubscriptionHandlers<keyof EventChannels>>()
  private readonly answers = new Map<string, Answer>()
  private nextStream = 1
  private endWith: (sentence: string) => void = () => undefined
  readonly ended = new Promise<string>((resolve) => {
    this.endWith = resolve
  })
  closed = false

  /** How `channel` is answered from now on. A throw is the host's error reply. */
  answer<C extends keyof RequestChannels>(
    channel: C,
    answer: (payload: RequestChannels[C]['request']) => RequestChannels[C]['response']
  ): this {
    this.answers.set(channel, answer as Answer)
    return this
  }

  request<C extends keyof RequestChannels>(
    channel: C,
    payload: RequestChannels[C]['request']
  ): Promise<RequestChannels[C]['response']> {
    this.sent.push({ channel, payload })
    const answer = this.answers.get(channel)
    if (answer === undefined) return Promise.resolve(null as RequestChannels[C]['response'])
    return new Promise((resolve) => resolve(answer(payload) as RequestChannels[C]['response']))
  }

  /** The payloads sent on `channel`, in order. */
  payloads(channel: string): unknown[] {
    return this.sent.filter((request) => request.channel === channel).map((request) => request.payload)
  }

  subscribe<C extends keyof EventChannels>(channel: C, handlers: SubscriptionHandlers<C>): HostSubscription {
    this.subscriptions.set(channel, handlers as unknown as SubscriptionHandlers<keyof EventChannels>)
    return {
      unsubscribe: () => {
        if (this.subscriptions.get(channel) === (handlers as unknown)) this.subscriptions.delete(channel)
      }
    }
  }

  /** An event on `channel`, to whatever subscribed. */
  push<C extends keyof EventChannels>(channel: C, event: EventChannels[C]['event']): void {
    const handlers = this.subscriptions.get(channel) as SubscriptionHandlers<C> | undefined
    handlers?.event(event)
  }

  snapshot<C extends keyof EventChannels>(channel: C, state: EventChannels[C]['snapshot']): void {
    const handlers = this.subscriptions.get(channel) as SubscriptionHandlers<C> | undefined
    handlers?.snapshot?.(state)
  }

  openStream<C extends keyof StreamChannels>(
    channel: C,
    params: StreamChannels[C]['open'],
    handlers: StreamHandlers
  ): HostStream {
    const stream = new FakeStream(this.nextStream++, channel, params, handlers)
    this.streams.push(stream)
    return stream
  }

  /** The streams opened on `channel` for `id`, oldest first. */
  streamsFor(channel: string, id: number): FakeStream[] {
    return this.streams.filter((stream) => stream.channel === channel && (stream.params as { id: number }).id === id)
  }

  close(): void {
    this.closed = true
    this.endWith('The connection to the local host was closed.')
  }

  asConnection(): HostConnection {
    return this as unknown as HostConnection
  }
}

/** A `LocalHost` over `connection`, recording whether it was stopped. */
export function fakeLocalHost(connection: FakeConnection, startedHost = true): LocalHost & { stopped: boolean } {
  const local = {
    connection: connection.asConnection(),
    startedHost,
    stopped: false,
    stop: () => {
      local.stopped = true
      connection.close()
      return Promise.resolve()
    }
  }
  return local
}

/** A link already connected to `connection`, or failing with `failure`, for the adapters. */
export function fakeLink(
  connection: FakeConnection | null,
  failure = 'No host.'
): HostLink & {
  connect(): Promise<void>
} {
  const listeners: Array<(connection: HostConnection) => void | Promise<void>> = []
  let connected = false
  let attempt: Promise<HostConnection> | null = null
  const link = {
    connection(): Promise<HostConnection> {
      if (connection === null) return Promise.reject(new Error(failure))
      attempt ??= (async () => {
        // Current before the listeners run, as the real link's is.
        connected = true
        for (const listener of listeners) await listener(connection.asConnection())
        return connection.asConnection()
      })()
      return attempt
    },
    current: () => (connected && connection !== null ? connection.asConnection() : null),
    settled: () => (attempt === null ? Promise.resolve() : attempt.then(() => undefined)),
    onConnected(listener: (connection: HostConnection) => void | Promise<void>) {
      listeners.push(listener)
    },
    writeSettings: () => undefined,
    stop: () => Promise.resolve(),
    async connect() {
      await link.connection()
    }
  }
  return link
}

/** A link whose connection can be replaced, the way a host that restarted is reached again. */
export function reconnectingLink(first: FakeConnection): HostLink & { reconnect(next: FakeConnection): Promise<void> } {
  const listeners: Array<(connection: HostConnection) => void | Promise<void>> = []
  let current = first
  let attempt: Promise<HostConnection> | null = null
  const connect = async (): Promise<HostConnection> => {
    for (const listener of listeners) await listener(current.asConnection())
    return current.asConnection()
  }
  return {
    connection: () => (attempt ??= connect()),
    current: () => current.asConnection(),
    settled: () => Promise.resolve(),
    onConnected: (listener) => {
      listeners.push(listener)
    },
    writeSettings: () => undefined,
    stop: () => Promise.resolve(),
    async reconnect(next) {
      current = next
      attempt = connect()
      await attempt
    }
  }
}
