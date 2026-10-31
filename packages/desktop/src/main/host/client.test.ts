import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { HostConnectionEnded, HostRefusedError, HostRequestError, connectHost, type HostConnection } from './client'
import { FrameDecoder, encodeFrame } from './frame'
import { DEFAULT_INITIAL_CREDIT, MAX_DATA_CHUNK, PROTOCOL_VERSION, type Message, type Welcome } from './protocol'

const WELCOME: Welcome = {
  protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
  hostVersion: '0.4.1',
  capabilities: ['terminal'],
  backends: []
}

/**
 * The host's end of an in-memory connection: it reads the desktop's frames and
 * writes its own, and waits for each message as an event, never on time.
 */
class FakeHost {
  readonly toClient = new PassThrough()
  readonly toHost = new PassThrough()
  private readonly decoder = new FrameDecoder()
  private readonly queue: Message[] = []
  private waiters: Array<(message: Message) => void> = []

  constructor() {
    this.toHost.on('data', (chunk: Uint8Array) => {
      this.decoder.push(chunk)
      for (let next = this.decoder.next(); next !== null; next = this.decoder.next()) {
        if ('malformed' in next) throw next.malformed
        const waiter = this.waiters.shift()
        if (waiter) waiter(next.message)
        else this.queue.push(next.message)
      }
    })
  }

  get transport(): { input: PassThrough; output: PassThrough } {
    return { input: this.toClient, output: this.toHost }
  }

  send(message: Message): void {
    this.toClient.write(encodeFrame(message))
  }

  /** The desktop's next message. */
  next(): Promise<Message> {
    const queued = this.queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** The desktop's next message, which must be of `type`. */
  async expect<T extends Message['type']>(type: T): Promise<Extract<Message, { type: T }>> {
    const message = await this.next()
    expect(message.type).toBe(type)
    return message as Extract<Message, { type: T }>
  }

  /** Every message the desktop has sent and the host has not read yet. */
  pending(): Message[] {
    return this.queue.splice(0)
  }
}

/** Resolves once the desktop's output has ended. */
function outputEnded(host: FakeHost): Promise<void> {
  return new Promise((resolve) => {
    if (host.toHost.writableEnded) resolve()
    else host.toHost.once('finish', () => resolve())
  })
}

async function connected(host = new FakeHost()): Promise<{ host: FakeHost; connection: HostConnection }> {
  const connecting = connectHost({
    transport: host.transport,
    appVersion: '2.4.0'
  })
  await host.expect('hello')
  host.send({ type: 'welcome', ...WELCOME })
  return { host, connection: await connecting }
}

/** A barrier: a request the fake host answers, so everything sent before it has been read. */
async function roundTrip(host: FakeHost, connection: HostConnection): Promise<Message[]> {
  const answered = connection.request('session:list', null)
  const before: Message[] = []
  for (;;) {
    const message = await host.next()
    if (message.type === 'request' && message.channel === 'session:list') {
      host.send({ type: 'response', id: message.id, payload: [] })
      break
    }
    before.push(message)
  }
  await answered
  return before
}

describe('the host client', { timeout: PATIENCE }, () => {
  it('says hello as the desktop with the terminal, files, browser and plugin pages capabilities and the protocol version, and resolves on the welcome', async () => {
    const host = new FakeHost()
    const connecting = connectHost({
      transport: host.transport,
      appVersion: '2.4.0'
    })
    expect(await host.next()).toEqual({
      type: 'hello',
      protocol: { major: 1, minor: 0 },
      client: { name: 'Helm 2.4.0', kind: 'desktop' },
      capabilities: ['terminal', 'files', 'browser', 'pluginPages']
    })
    host.send({ type: 'welcome', ...WELCOME })
    const connection = await connecting
    expect(connection.welcome).toMatchObject({
      hostVersion: '0.4.1',
      capabilities: ['terminal']
    })
  })

  it('rejects with the host’s sentence when the hello is refused, and ends the connection', async () => {
    const host = new FakeHost()
    const connecting = connectHost({
      transport: host.transport,
      appVersion: '2.4.0'
    })
    await host.expect('hello')
    const sentence = 'This host speaks protocol 2.0 and Helm speaks 1.0: update Helm.'
    host.send({
      type: 'refused',
      host: { major: 2, minor: 0 },
      client: { major: 1, minor: 0 },
      update: 'client',
      message: sentence
    })
    await expect(connecting).rejects.toThrow(new HostRefusedError(sentence))
    await outputEnded(host)
  })

  it('rejects with a sentence when the connection ends before the welcome', async () => {
    const host = new FakeHost()
    const connecting = connectHost({
      transport: host.transport,
      appVersion: '2.4.0'
    })
    await host.expect('hello')
    host.toClient.end()
    await expect(connecting).rejects.toThrow(HostConnectionEnded)
    await expect(connecting).rejects.toThrow('The connection to the local host ended.')
  })

  it('answers each request with its own response, in whatever order the host answers', async () => {
    const { host, connection } = await connected()
    const list = connection.request('session:list', null)
    const rename = connection.request('session:rename', {
      id: 4,
      label: 'api'
    })
    const first = await host.expect('request')
    const second = await host.expect('request')
    expect(first).toMatchObject({ channel: 'session:list', payload: null })
    expect(second).toMatchObject({
      channel: 'session:rename',
      payload: { id: 4, label: 'api' }
    })
    expect(first.id).not.toBe(second.id)

    host.send({
      type: 'response',
      id: second.id,
      payload: { id: 4, label: 'api' }
    })
    host.send({ type: 'response', id: first.id, payload: [{ id: 4 }] })
    await expect(rename).resolves.toEqual({ id: 4, label: 'api' })
    await expect(list).resolves.toEqual([{ id: 4 }])
  })

  it('rejects a request the host answers with an error reply, naming its code and the host’s sentence, and keeps the connection', async () => {
    const { host, connection } = await connected()
    const closing = connection.request('session:close', { id: 9 } as never)
    const request = await host.expect('request')
    host.send({
      type: 'error',
      id: request.id,
      channel: 'session:close',
      code: 'failed',
      message: 'There is no session 9.'
    })
    const error = await closing.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HostRequestError)
    expect(error).toMatchObject({
      channel: 'session:close',
      code: 'failed',
      message: 'There is no session 9.'
    })
    await roundTrip(host, connection)
  })

  it('hands a subscription its snapshot first, then its events, and resubscribes for a fresh snapshot after a gap', async () => {
    const { host, connection } = await connected()
    const seen: unknown[] = []
    connection.subscribe('session:activity', {
      snapshot: (state) => seen.push(['snapshot', state]),
      event: (event) => seen.push(['event', event])
    })
    const subscribe = await host.expect('subscribe')
    expect(subscribe.channel).toBe('session:activity')
    host.send({
      type: 'snapshot',
      subscription: subscribe.subscription,
      seq: 4,
      state: []
    })
    host.send({
      type: 'event',
      subscription: subscribe.subscription,
      seq: 5,
      payload: ['five']
    })
    host.send({
      type: 'event',
      subscription: subscribe.subscription,
      seq: 6,
      payload: ['six']
    })
    // Seven never came.
    host.send({
      type: 'event',
      subscription: subscribe.subscription,
      seq: 8,
      payload: ['eight']
    })

    expect(await host.expect('unsubscribe')).toEqual({
      type: 'unsubscribe',
      subscription: subscribe.subscription
    })
    const again = await host.expect('subscribe')
    expect(again.channel).toBe('session:activity')
    expect(again.subscription).not.toBe(subscribe.subscription)
    // What the old number still had in flight is not delivered.
    host.send({
      type: 'event',
      subscription: subscribe.subscription,
      seq: 9,
      payload: ['stale']
    })
    host.send({
      type: 'snapshot',
      subscription: again.subscription,
      seq: 8,
      state: ['eight']
    })
    host.send({
      type: 'event',
      subscription: again.subscription,
      seq: 9,
      payload: ['nine']
    })
    await roundTrip(host, connection)

    expect(seen).toEqual([
      ['snapshot', []],
      ['event', ['five']],
      ['event', ['six']],
      ['snapshot', ['eight']],
      ['event', ['nine']]
    ])
  })

  it('stops a subscription the caller ends, and reports one the host refuses', async () => {
    const { host, connection } = await connected()
    const events: unknown[] = []
    const errors: Error[] = []
    const exits = connection.subscribe('session:exit', {
      event: (event) => events.push(event)
    })
    const refused = connection.subscribe('files:changed', {
      event: (event) => events.push(event),
      error: (error) => errors.push(error)
    })
    const exitSub = await host.expect('subscribe')
    const filesSub = await host.expect('subscribe')
    host.send({
      type: 'event',
      subscription: exitSub.subscription,
      seq: 1,
      payload: { id: 1 }
    })
    host.send({
      type: 'subscriptionError',
      subscription: filesSub.subscription,
      channel: 'files:changed',
      code: 'missingCapability',
      message: 'files:changed needs the files capability.'
    })
    await roundTrip(host, connection)
    exits.unsubscribe()
    expect(await host.expect('unsubscribe')).toEqual({
      type: 'unsubscribe',
      subscription: exitSub.subscription
    })
    host.send({
      type: 'event',
      subscription: exitSub.subscription,
      seq: 2,
      payload: { id: 2 }
    })
    refused.unsubscribe()
    expect(await roundTrip(host, connection)).toEqual([])

    expect(events).toEqual([{ id: 1 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(HostRequestError)
    expect(errors[0]).toMatchObject({
      code: 'missingCapability',
      message: 'files:changed needs the files capability.'
    })
  })

  it('opens a terminal stream and hands on the host’s bytes unchanged and in order', async () => {
    const { host, connection } = await connected()
    const received: Uint8Array[] = []
    const stream = connection.openStream('session:data', { id: 3 }, { data: (bytes) => received.push(bytes) })
    const open = await host.expect('streamOpen')
    expect(open).toEqual({
      type: 'streamOpen',
      stream: stream.id,
      channel: 'session:data',
      params: { id: 3 }
    })

    const chunks = [
      Uint8Array.from([0x1b, 0x5b, 0x48, 0xe2]),
      Uint8Array.from([0x9c, 0x93, 0x00, 0xff]),
      Uint8Array.from([0x0d, 0x0a])
    ]
    for (const data of chunks) host.send({ type: 'streamData', stream: stream.id, data })
    await roundTrip(host, connection)
    expect(Buffer.concat(received).equals(Buffer.concat(chunks))).toBe(true)
  })

  it('returns the host’s credit as bytes are consumed, never letting it run out', async () => {
    const { host, connection } = await connected()
    const stream = connection.openStream('session:data', { id: 3 }, { data: () => {} })
    await host.expect('streamOpen')
    let credit = DEFAULT_INITIAL_CREDIT
    let returned = 0
    const chunk = new Uint8Array(16 * 1024)
    for (let i = 0; i < 64; i += 1) {
      expect(credit).toBeGreaterThanOrEqual(chunk.length)
      host.send({ type: 'streamData', stream: stream.id, data: chunk })
      credit -= chunk.length
      for (const message of await roundTrip(host, connection)) {
        expect(message.type).toBe('streamCredit')
        if (message.type !== 'streamCredit') continue
        expect(message.stream).toBe(stream.id)
        credit += message.bytes
        returned += message.bytes
      }
    }
    // A megabyte went through 256 KiB of credit.
    expect(returned).toBeGreaterThanOrEqual(64 * chunk.length - DEFAULT_INITIAL_CREDIT)
  })

  it('returns credit only for what the caller says it consumed when it holds the credit itself', async () => {
    const { host, connection } = await connected()
    const stream = connection.openStream('pterm:data', { id: 1 }, { data: () => {}, manualCredit: true })
    await host.expect('streamOpen')
    host.send({
      type: 'streamData',
      stream: stream.id,
      data: new Uint8Array(DEFAULT_INITIAL_CREDIT)
    })
    expect(await roundTrip(host, connection)).toEqual([])
    stream.consumed(DEFAULT_INITIAL_CREDIT)
    expect(await roundTrip(host, connection)).toEqual([
      {
        type: 'streamCredit',
        stream: stream.id,
        bytes: DEFAULT_INITIAL_CREDIT
      }
    ])
  })

  it('closes a stream the host sends past its credit, with a sentence, and keeps the connection', async () => {
    const { host, connection } = await connected()
    const closed: Array<string | null> = []
    const stream = connection.openStream(
      'pterm:data',
      { id: 1 },
      { data: () => {}, manualCredit: true, close: (why) => closed.push(why) }
    )
    await host.expect('streamOpen')
    host.send({
      type: 'streamData',
      stream: stream.id,
      data: new Uint8Array(DEFAULT_INITIAL_CREDIT + 1)
    })
    const close = await host.expect('streamClose')
    const reason = `The local host sent ${DEFAULT_INITIAL_CREDIT + 1} bytes on stream ${stream.id} with ${DEFAULT_INITIAL_CREDIT} bytes of credit.`
    expect(close).toEqual({ type: 'streamClose', stream: stream.id, reason })
    expect(closed).toEqual([reason])
    expect(stream.write(Uint8Array.from([1]))).toBe(false)
    await roundTrip(host, connection)
  })

  it('sends typed bytes in order, in chunks, and never past the credit the host granted', async () => {
    const { host, connection } = await connected()
    const stream = connection.openStream('session:data', { id: 3 }, { data: () => {} })
    await host.expect('streamOpen')
    const typed = Buffer.from(Array.from({ length: DEFAULT_INITIAL_CREDIT + 100_000 }, (_, i) => i % 251))
    stream.write(typed.subarray(0, 10))
    stream.write(typed.subarray(10))

    const sent: Uint8Array[] = []
    let total = 0
    for (const message of await roundTrip(host, connection)) {
      expect(message.type).toBe('streamData')
      if (message.type !== 'streamData') continue
      expect(message.data.length).toBeLessThanOrEqual(MAX_DATA_CHUNK)
      sent.push(message.data)
      total += message.data.length
    }
    expect(total).toBe(DEFAULT_INITIAL_CREDIT)

    host.send({ type: 'streamCredit', stream: stream.id, bytes: 40_000 })
    for (const message of await roundTrip(host, connection)) {
      if (message.type === 'streamData') sent.push(message.data)
    }
    expect(Buffer.concat(sent).length).toBe(DEFAULT_INITIAL_CREDIT + 40_000)

    host.send({
      type: 'streamCredit',
      stream: stream.id,
      bytes: DEFAULT_INITIAL_CREDIT
    })
    for (const message of await roundTrip(host, connection)) {
      if (message.type === 'streamData') sent.push(message.data)
    }
    expect(Buffer.concat(sent).equals(typed)).toBe(true)
  })

  it('closes a stream from either side: the host’s close reaches the caller, the caller’s reaches the host', async () => {
    const { host, connection } = await connected()
    const closed: Array<string | null> = []
    const ours = connection.openStream('session:data', { id: 1 }, { data: () => {}, close: (why) => closed.push(why) })
    const theirs = connection.openStream(
      'session:data',
      { id: 2 },
      { data: () => {}, close: (why) => closed.push(why) }
    )
    await host.expect('streamOpen')
    await host.expect('streamOpen')
    ours.close()
    expect(await host.expect('streamClose')).toEqual({
      type: 'streamClose',
      stream: ours.id,
      reason: null
    })
    host.send({ type: 'streamClose', stream: theirs.id, reason: null })
    await roundTrip(host, connection)
    expect(closed).toEqual([null])
    expect(theirs.write(Uint8Array.from([1]))).toBe(false)
  })

  it('refuses a stream the host opens', async () => {
    const { host, connection } = await connected()
    host.send({
      type: 'streamOpen',
      stream: 900,
      channel: 'session:data',
      params: { id: 1 }
    })
    expect(await roundTrip(host, connection)).toEqual([
      {
        type: 'streamClose',
        stream: 900,
        reason: 'This client opens its own streams and accepts none from the host.'
      }
    ])
  })

  it('fails every pending call, subscription and stream with a sentence when the connection ends', async () => {
    const { host, connection } = await connected()
    const list = connection.request('session:list', null)
    const errors: Error[] = []
    const closes: Array<string | null> = []
    connection.subscribe('session:exit', {
      event: () => {},
      error: (error) => errors.push(error)
    })
    connection.openStream('session:data', { id: 1 }, { data: () => {}, close: (why) => closes.push(why) })
    await host.expect('request')
    host.toClient.end()

    await expect(list).rejects.toThrow(
      new HostConnectionEnded('The connection to the local host ended before the host answered session:list.')
    )
    await expect(connection.ended).resolves.toBe('The connection to the local host ended.')
    expect(errors.map((error) => error.message)).toEqual(['The connection to the local host ended.'])
    expect(closes).toEqual(['The connection to the local host ended.'])
    await expect(connection.request('session:list', null)).rejects.toThrow('The connection to the local host ended.')
    await outputEnded(host)
  })

  it('says it ended inside a frame when the host’s output stops partway through one', async () => {
    const { host, connection } = await connected()
    host.toClient.end(encodeFrame({ type: 'response', id: 1, payload: null }).subarray(0, 5))
    await expect(connection.ended).resolves.toBe('The connection ended 5 bytes into a frame.')
  })

  it('ends the connection when the host sends a frame over the limit', async () => {
    const { host, connection } = await connected()
    host.toClient.write(Uint8Array.from([0xff, 0xff, 0xff, 0xff]))
    await expect(connection.ended).resolves.toMatch(
      /^The local host sent a frame Helm cannot read: A frame of \d+ bytes is over the/
    )
  })

  it('closing ends the output, so the bridge closes the connection', async () => {
    const { host, connection } = await connected()
    const list = connection.request('session:list', null)
    await host.expect('request')
    connection.close()
    await outputEnded(host)
    await expect(list).rejects.toThrow(
      'The connection to the local host was closed before the host answered session:list.'
    )
    await expect(connection.ended).resolves.toBe('The connection to the local host was closed.')
  })
})
