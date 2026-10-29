import { describe, expect, it } from 'vitest'
import { FakeConnection } from '../../../test/host-connection'
import { createTerminalStreams, type TerminalChannel } from './streams'

function world(connection: FakeConnection | null = new FakeConnection()) {
  const delivered: Array<{ channel: TerminalChannel; id: number; data: string }> = []
  const closed: Array<{ channel: TerminalChannel; id: number; reason: string | null }> = []
  const streams = createTerminalStreams({
    connection: () => connection?.asConnection() ?? null,
    deliver: (channel, id, data) => delivered.push({ channel, id, data }),
    closed: (channel, id, reason) => closed.push({ channel, id, reason }),
    log: () => undefined
  })
  const text = (id: number): string =>
    delivered
      .filter((chunk) => chunk.id === id)
      .map((chunk) => chunk.data)
      .join('')
  return { connection: connection ?? new FakeConnection(), streams, delivered, closed, text }
}

describe('terminal streams to the local host', () => {
  it('decodes a character split across chunks once, whole', () => {
    const w = world()
    w.streams.open('session:data', 1)
    const [stream] = w.connection.streamsFor('session:data', 1)
    const bytes = new TextEncoder().encode('a€😀b')
    // Split inside the euro sign and inside the emoji.
    for (const part of [bytes.slice(0, 2), bytes.slice(2, 3), bytes.slice(3, 6), bytes.slice(6)]) stream?.send(part)

    expect(w.text(1)).toBe('a€😀b')
    expect(w.delivered.every((chunk) => !chunk.data.includes('�'))).toBe(true)
  })

  it('carries input to the host as bytes, in order', () => {
    const w = world()
    w.streams.open('pterm:data', 4)
    for (const key of ['l', 's', ' ', 'é', '\r']) w.streams.write('pterm:data', 4, key)

    expect(w.connection.streamsFor('pterm:data', 4)[0]?.text()).toBe('ls é\r')
  })

  it('opens every stream again when the window reloads, and the old one says nothing more', () => {
    const w = world()
    w.streams.open('session:data', 1)
    w.streams.open('pterm:data', 2)
    const [oldSession] = w.connection.streamsFor('session:data', 1)
    oldSession?.send('before\r\n')

    w.streams.suspend()
    expect(oldSession?.closed).toBe(true)
    // Bytes already in flight on the old stream reach nobody.
    oldSession?.send('late\r\n')
    w.streams.write('session:data', 1, 'dropped')

    w.streams.resume()
    const [, newSession] = w.connection.streamsFor('session:data', 1)
    const [, newTerminal] = w.connection.streamsFor('pterm:data', 2)
    expect(newSession).toBeDefined()
    expect(newTerminal).toBeDefined()
    newSession?.send('\x1b[H\x1b[2Jredrawn')

    expect(w.text(1)).toBe('before\r\n\x1b[H\x1b[2Jredrawn')
    expect(oldSession?.written).toEqual([])
  })

  it('opens nothing again for a terminal the host has ended', () => {
    const w = world()
    w.streams.open('session:data', 1)
    w.connection.streamsFor('session:data', 1)[0]?.end('Session 1 has exited.')

    expect(w.closed).toEqual([{ channel: 'session:data', id: 1, reason: 'Session 1 has exited.' }])
    w.streams.suspend()
    w.streams.resume()
    expect(w.connection.streamsFor('session:data', 1)).toHaveLength(1)
  })

  it('opens a stream only once for one terminal, and closes it when asked', () => {
    const w = world()
    w.streams.open('session:data', 1)
    w.streams.open('session:data', 1)
    w.streams.close('session:data', 1)

    expect(w.connection.streamsFor('session:data', 1)).toHaveLength(1)
    expect(w.connection.streamsFor('session:data', 1)[0]?.closed).toBe(true)
  })
})
