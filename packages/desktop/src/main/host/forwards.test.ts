import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ForwardedPort } from '../../shared/ipc'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { PATIENCE } from '../../../../../test/patience'
import { createPortForwards, type PortForwards } from './forwards'

/**
 * Main's forwards over a fake connection: each connection made to this PC's
 * loopback opens one `sessions:port` stream, and what the stream carries goes
 * both ways. `forwards.floti.test.ts` drives the same against a real host.
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function forwardsWith(changes: ForwardedPort[][] = []): PortForwards {
  const forwards = createPortForwards({ changed: (list) => changes.push(list), log: () => undefined })
  cleanups.push(() => forwards.stop())
  return forwards
}

/** A port on 127.0.0.1 nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as { port: number }
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

/** Something else on this PC listening on 127.0.0.1 at a port of its own. */
async function occupied(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(() => server.close())
  return { server, port: (server.address() as { port: number }).port }
}

/** A client of the forward on this PC. */
function dial(port: number): Promise<Socket> {
  return new Promise((done, fail) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => done(socket))
    socket.once('error', fail)
    cleanups.push(() => socket.destroy())
  })
}

/** Resolves once `check` holds, polled, failing past the shared patience. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + PATIENCE
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setImmediate(done))
  }
}

describe('ports of remote sessions forwarded to this PC', () => {
  it('S1: listens on 127.0.0.1 at the same port when it is free here, and carries each connection over a stream of its own, both ways', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection)
    const changes: ForwardedPort[][] = []
    const forwards = forwardsWith(changes)
    forwards.attach('build-box', link)
    await link.connect()
    const port = await freePort()

    const forward = await forwards.open('build-box', 7, port)
    expect(forward).toEqual({ host: 'build-box', session: 7, port, local: port })
    expect(changes.at(-1)).toEqual([forward])
    // Asked again, it is the same forward.
    expect(await forwards.open('build-box', 7, port)).toEqual(forward)

    const socket = await dial(forward.local)
    expect(socket.remoteAddress).toBe('127.0.0.1')
    await until(() => connection.streams.length === 1, 'the stream')
    const stream = connection.streams[0]!
    expect(stream.channel).toBe('sessions:port')
    expect(stream.params).toEqual({ id: 7, port })

    socket.write('GET / HTTP/1.1\r\n\r\n')
    await until(() => stream.text() === 'GET / HTTP/1.1\r\n\r\n', 'the request to reach the host')
    let received = ''
    socket.on('data', (chunk: Buffer) => (received += chunk.toString()))
    stream.send('HTTP/1.1 200 OK\r\n\r\nhello')
    await until(() => received === 'HTTP/1.1 200 OK\r\n\r\nhello', 'the answer to come back')
    // Credited back once this PC's socket took it.
    await until(() => stream.consumedBytes === 'HTTP/1.1 200 OK\r\n\r\nhello'.length, 'the credit')

    // A second connection is a second stream.
    await dial(forward.local)
    await until(() => connection.streams.length === 2, 'the second stream')
  })

  it('S1: listens on another free port when the session\'s port is taken on this PC', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection)
    const forwards = forwardsWith()
    forwards.attach('build-box', link)
    await link.connect()
    const taken = await occupied()

    const forward = await forwards.open('build-box', 3, taken.port)
    expect(forward.port).toBe(taken.port)
    expect(forward.local).not.toBe(taken.port)
    await dial(forward.local)
    await until(() => connection.streams.length === 1, 'the stream')
    expect(connection.streams[0]!.params).toEqual({ id: 3, port: taken.port })
  })

  it('S3: when the session ends, every connection carried for it closes, the port is no longer forwarded and a new connection is refused', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection)
    const changes: ForwardedPort[][] = []
    const forwards = forwardsWith(changes)
    forwards.attach('build-box', link)
    await link.connect()
    const kept = await forwards.open('build-box', 8, await freePort())
    const forward = await forwards.open('build-box', 7, await freePort())
    const socket = await dial(forward.local)
    const closed = new Promise<void>((done) => socket.once('close', () => done()))
    await until(() => connection.streams.length === 1, 'the stream')

    connection.push('session:exit', { id: 7 } as never)

    await closed
    expect(connection.streams[0]!.closed).toBe(true)
    expect(forwards.list()).toEqual([kept])
    expect(changes.at(-1)).toEqual([kept])
    await expect(dial(forward.local)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('S3: a session that ended while the link was down closes its forward when the link is back', async () => {
    const connection = new FakeConnection().answer('session:list', () => [
      { id: 8, status: 'running' } as never,
      { id: 7, status: 'exited' } as never
    ])
    const listeners: Array<(connection: never) => unknown> = []
    let current: FakeConnection | null = new FakeConnection()
    const link = {
      current: () => current?.asConnection() ?? null,
      onConnected: (listener: (connection: never) => unknown) => void listeners.push(listener)
    }
    const forwards = forwardsWith()
    forwards.attach('build-box', link)
    const ended = await forwards.open('build-box', 7, await freePort())
    const running = await forwards.open('build-box', 8, await freePort())
    expect(forwards.list()).toEqual([ended, running])

    current = connection
    for (const listener of listeners) await listener(connection.asConnection() as never)

    expect(forwards.list()).toEqual([running])
  })

  it('a connection made while the link is down is closed at once, and nothing is held for it', async () => {
    let current: FakeConnection | null = new FakeConnection()
    const link = { current: () => current?.asConnection() ?? null, onConnected: () => undefined }
    const forwards = forwardsWith()
    forwards.attach('build-box', link)
    const forward = await forwards.open('build-box', 7, await freePort())
    const before = current!
    current = null

    const socket = await dial(forward.local)
    await new Promise<void>((done) => socket.once('close', () => done()))
    expect(before.streams).toEqual([])
    // And a new forward is not opened while it is down.
    await expect(forwards.open('build-box', 9, 1)).rejects.toThrow('not connected')
  })

  it('a host let go of closes every forward to it', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection)
    const forwards = forwardsWith()
    const attached = forwards.attach('build-box', link)
    await link.connect()
    const forward = await forwards.open('build-box', 7, await freePort())

    attached.stop()

    expect(forwards.list()).toEqual([])
    await expect(dial(forward.local)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    await expect(forwards.open('build-box', 7, forward.port)).rejects.toThrow('no such host')
  })
})
