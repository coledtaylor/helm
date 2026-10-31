import type { SessionResources } from '@helm/core'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLink, reconnectingLink } from '../../../test/host-connection'
import type { HostLink } from './link'
import type * as P from './protocol'
import { createHostResources } from './resources'

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

/** A session the host looked at: its program and one child, the child listening on 5173. */
const LOOKED: P.SessionResources = {
  id: 1,
  rootPid: 4100,
  processes: [
    { pid: 4100, parentPid: 1, name: 'claude', commandLine: 'claude --session-id x', depth: 0, ports: [] },
    { pid: 4200, parentPid: 4100, name: 'node', commandLine: null, depth: 1, ports: [5173] }
  ],
  rootSeen: true,
  ports: [{ port: 5173, pid: 4200, process: 'node', addresses: ['127.0.0.1'] }],
  opaque: 1,
  atMs: 1_790_848_800_000
}

/** One the host could not enumerate processes or read sockets for. */
const COULD_NOT_LOOK: P.SessionResources = {
  id: 2,
  rootPid: 5100,
  processes: null,
  rootSeen: false,
  ports: null,
  opaque: 0,
  atMs: 1_790_848_800_000
}

/** One the host looked at and found holding nothing. */
const NOTHING_THERE: P.SessionResources = {
  id: 3,
  rootPid: 6100,
  processes: [{ pid: 6100, parentPid: 1, name: 'claude', commandLine: 'claude', depth: 0, ports: [] }],
  rootSeen: true,
  ports: [],
  opaque: 0,
  atMs: 1_790_848_800_000
}

function world(link: HostLink) {
  const emitted: SessionResources[][] = []
  const logged: string[] = []
  const resources = createHostResources({
    link,
    emit: (channel, payload) => {
      if (channel === 'sessions:resources') emitted.push(payload as SessionResources[])
    },
    log: (line) => logged.push(line)
  })
  return { resources, emitted, logged }
}

/** Lets every promise already settled run its callbacks. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const watches = (connection: FakeConnection): unknown[] => connection.payloads('sessions:watch')

describe('processes and ports through the local host', () => {
  it('hands the window the host’s sets with could-not-look and nothing-there kept apart', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)
    await link.connect()

    connection.snapshot('sessions:resources', [LOOKED, COULD_NOT_LOOK, NOTHING_THERE])
    const read = await w.resources.snapshots()
    expect(read).toEqual([LOOKED, COULD_NOT_LOOK, NOTHING_THERE])
    expect(read[1]?.processes).toBeNull()
    expect(read[1]?.ports).toBeNull()
    expect(read[2]?.processes?.filter((p) => p.depth > 0)).toEqual([])
    expect(read[2]?.ports).toEqual([])
    expect(read[0]?.processes?.[1]?.commandLine).toBeNull()

    // A pass that could no longer read the sockets says so; it is not "nothing listening".
    connection.push('sessions:resources', [{ ...LOOKED, ports: null }])
    expect(w.emitted).toEqual([[LOOKED, COULD_NOT_LOOK, NOTHING_THERE], [{ ...LOOKED, ports: null }]])
    expect((await w.resources.snapshots())[0]?.ports).toBeNull()
  })

  it('answers a read asked while the first connect is in flight with the host’s set, never an empty one first', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)
    expect(link.current()).toBeNull()

    let answered: SessionResources[] | null = null
    const read = w.resources.snapshots().then((sets) => (answered = sets))
    await drain()
    // Connected and subscribed, but the host has not sent its set: nothing is answered yet.
    expect([...connection.subscriptions.keys()]).toEqual(['sessions:resources'])
    expect(answered).toBeNull()

    connection.snapshot('sessions:resources', [LOOKED])
    await read
    expect(answered).toEqual([LOOKED])
  })

  it('rejects a read with the link’s sentence when the host cannot be reached, and asks the host for nothing', async () => {
    const w = world(fakeLink(null, UNREACHABLE))
    await expect(w.resources.snapshots()).rejects.toThrow(UNREACHABLE)
    // The pane on screen: nothing throws, and the log says why nothing arrives.
    w.resources.watch(true)
    await drain()
    expect(w.logged).toEqual([`host: processes and ports cannot be read (${UNREACHABLE})`])
    expect(w.emitted).toEqual([])
  })

  it('tells the window the empty set when the connection ends, so every hosted row paints Unknown', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)
    await link.connect()
    connection.snapshot('sessions:resources', [LOOKED, NOTHING_THERE])

    connection.close()
    await drain()
    expect(w.emitted.at(-1)).toEqual([])
  })

  it('rejects a read whose connection ends before the host sent its set', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)
    const read = w.resources.snapshots()
    await drain()
    connection.close()
    await expect(read).rejects.toThrow('The connection to the local host was closed.')
  })

  it('tells the host once per change in whether anybody here is looking, and the first of two to stop does not stop the other', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)

    // Before the first connect: the watch joins it and is sent once.
    w.resources.watch(true)
    await drain()
    expect(watches(connection)).toEqual([{ watching: true }])

    // A second watcher, then the first stops: the host keeps passing.
    w.resources.watch(true)
    w.resources.watch(false)
    await drain()
    expect(watches(connection)).toEqual([{ watching: true }])

    // The last stops: the host stops reading the machine.
    w.resources.watch(false)
    await drain()
    expect(watches(connection)).toEqual([{ watching: true }, { watching: false }])

    // An open and close while one is being sent sends only where it ended up.
    w.resources.watch(true)
    w.resources.watch(false)
    w.resources.watch(true)
    await drain()
    expect(watches(connection)).toEqual([{ watching: true }, { watching: false }, { watching: true }])

    // A refresh asks the host for nothing: it passes again by itself.
    await w.resources.refresh()
    expect(connection.sent.map((r) => r.channel)).toEqual(['sessions:watch', 'sessions:watch', 'sessions:watch'])
    expect(w.resources.lastPass()).toBeNull()
  })

  it('says nothing to a host that was never told anybody was looking', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    world(link)
    await link.connect()
    await drain()
    expect(watches(connection)).toEqual([])
  })

  it('keeps the sets arriving after Helm reaches the host again while the pane is open', async () => {
    const first = new FakeConnection()
    const link = reconnectingLink(first)
    const w = world(link)
    w.resources.watch(true)
    await drain()
    expect(watches(first)).toEqual([{ watching: true }])
    first.snapshot('sessions:resources', [LOOKED])

    first.close()
    await drain()
    expect(w.emitted.at(-1)).toEqual([])

    const next = new FakeConnection()
    await link.reconnect(next)
    await drain()
    // The new connection is told the pane is open, without it being reopened.
    expect(watches(next)).toEqual([{ watching: true }])
    next.snapshot('sessions:resources', [NOTHING_THERE])
    next.push('sessions:resources', [LOOKED])
    expect(w.emitted.slice(-2)).toEqual([[NOTHING_THERE], [LOOKED]])
    expect(await w.resources.snapshots()).toEqual([LOOKED])
  })

  it('stops listening to the host when stopped', async () => {
    const connection = new FakeConnection()
    const link = fakeLink(connection, UNREACHABLE)
    const w = world(link)
    await link.connect()
    w.resources.stop()
    expect([...connection.subscriptions.keys()]).toEqual([])
    w.resources.watch(true)
    await drain()
    expect(watches(connection)).toEqual([])
  })
})
