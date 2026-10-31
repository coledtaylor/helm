import type {
  HostConnection,
  HostStream,
  HostSubscription,
  StreamHandlers,
  SubscriptionHandlers
} from '../src/shared/host/client'
import type { EventChannels, RequestChannels, StreamChannels } from '../src/shared/host/protocol'

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

/**
 * A page's link that connects to `first`, then to each connection the test
 * hands it, as a page reconnects after its connection ended.
 */
export function reconnectingReach(first: FakeConnection): {
  connection(): Promise<HostConnection>
  onConnected(listener: (connection: HostConnection) => void): void
  reconnect(next: FakeConnection): Promise<void>
} {
  const listeners: Array<(connection: HostConnection) => void> = []
  let current = first
  let attempt: Promise<HostConnection> | null = null
  const reach = {
    connection(): Promise<HostConnection> {
      attempt ??= Promise.resolve().then(() => {
        for (const listener of listeners) listener(current.asConnection())
        return current.asConnection()
      })
      return attempt
    },
    onConnected(listener: (connection: HostConnection) => void) {
      listeners.push(listener)
    },
    async reconnect(next: FakeConnection) {
      current.close()
      current = next
      attempt = null
      await reach.connection()
    }
  }
  return reach
}

/**
 * A page's link already connected to `connection`, or failing with `failure`,
 * for the window's host adapters. Nothing in it reaches Node, so the window's
 * tests use it too.
 */
export function fakeReach(
  connection: FakeConnection | null,
  failure = 'No host.'
): {
  connection(): Promise<HostConnection>
  onConnected(listener: (connection: HostConnection) => void): void
  connect(): Promise<void>
} {
  const listeners: Array<(connection: HostConnection) => void> = []
  let attempt: Promise<HostConnection> | null = null
  const reach = {
    connection(): Promise<HostConnection> {
      if (connection === null) return Promise.reject(new Error(failure))
      attempt ??= Promise.resolve().then(() => {
        for (const listener of listeners) listener(connection.asConnection())
        return connection.asConnection()
      })
      return attempt
    },
    onConnected(listener: (connection: HostConnection) => void) {
      listeners.push(listener)
    },
    async connect() {
      await reach.connection()
    }
  }
  return reach
}
