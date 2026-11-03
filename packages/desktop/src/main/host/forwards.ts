import { createServer, type Server, type Socket } from 'node:net'
import type { ForwardedPort } from '../../shared/ipc'
import type { HostConnection, HostStream, HostSubscription } from './client'

/**
 * Ports of sessions on hosts on other computers, forwarded to this PC's
 * loopback, so the Browser tab can show a dev server running there.
 *
 * - Main owns every forward. It listens on `127.0.0.1` only: on the session's
 *   own port number when that is free here, and on another free one when not.
 * - Each connection made to it opens one `sessions:port` stream on main's own
 *   link to that host, which connects only to its own loopback, and only for a
 *   port that session's process tree listens on; anything else it refuses with
 *   a sentence, which closes the connection here.
 * - Bytes go both ways unchanged under the stream's credit: what the host sends
 *   is credited back once this PC's socket has taken it, and reading from the
 *   socket pauses while what it gave waits on the host's credit.
 * - While the link is down, a new connection is closed at once; none is
 *   retried or held.
 * - When the session ends (the host's `session:exit`, or a reconnect that no
 *   longer lists it running), every connection carried for it closes, the
 *   listener closes, and the forward is gone: a new connection is refused.
 *   A host forgotten or a Helm quitting closes all of that host's.
 */

/** As much of main's link to a host as the forwards use. */
export interface ForwardsLink {
  /** The connection now, or null between connections. */
  current(): HostConnection | null
  onConnected(listener: (connection: HostConnection) => void | Promise<void>): void
}

export interface PortForwardsDeps {
  /** Every port forwarded now, after each change. */
  changed: (forwards: ForwardedPort[]) => void
  log: (line: string) => void
  /** Makes a listener; Node's own by default. */
  createServer?: () => Server
}

export interface PortForwards {
  /**
   * Follows host `host`'s main link: its sessions' ends close their forwards.
   * The returned stop closes every forward to that host.
   */
  attach(host: string, link: ForwardsLink): { stop(): void }
  /** Forwards `port` of session `session` on `host`, or answers the forward already open for it. */
  open(host: string, session: number, port: number): Promise<ForwardedPort>
  /** Every port forwarded now. */
  list(): ForwardedPort[]
  /** Closes every forward. */
  stop(): void
}

/** How much of what this PC's socket gave may wait on the host's credit before reading pauses. */
const MOST_QUEUED = 256 * 1024

interface Forward {
  info: ForwardedPort
  server: Server
  /** Each connection carried now, with what ends it: its stream and its socket. */
  sockets: Map<Socket, () => void>
}

interface Attached {
  link: ForwardsLink
  subscription: HostSubscription | null
  stopped: boolean
}

const keyOf = (host: string, session: number, port: number): string => `${host}\n${String(session)}\n${String(port)}`

/** A listener on 127.0.0.1 at `port`, or null when that port is taken here. */
function listenAt(server: Server, port: number): Promise<boolean> {
  return new Promise((done, fail) => {
    const failed = (error: NodeJS.ErrnoException): void => {
      server.off('listening', listening)
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') done(false)
      else fail(error)
    }
    const listening = (): void => {
      server.off('error', failed)
      done(true)
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

export function createPortForwards(deps: PortForwardsDeps): PortForwards {
  const make = deps.createServer ?? (() => createServer({ allowHalfOpen: false, pauseOnConnect: true }))
  const forwards = new Map<string, Forward>()
  /** Forwards being opened, so two asks for one port share one listener. */
  const opening = new Map<string, Promise<ForwardedPort>>()
  const hosts = new Map<string, Attached>()

  const tell = (): void => deps.changed([...forwards.values()].map((forward) => ({ ...forward.info })))

  const close = (forward: Forward): void => {
    const key = keyOf(forward.info.host, forward.info.session, forward.info.port)
    if (forwards.get(key) !== forward) return
    forwards.delete(key)
    forward.server.close()
    for (const end of [...forward.sockets.values()]) end()
    forward.sockets.clear()
    tell()
  }

  const closeWhere = (keep: (info: ForwardedPort) => boolean): void => {
    for (const forward of [...forwards.values()]) if (!keep(forward.info)) close(forward)
  }

  /** Carries one connection made to the forward over a stream of its own. */
  const carry = (forward: Forward, socket: Socket): void => {
    const attached = hosts.get(forward.info.host)
    const connection = attached?.stopped === false ? attached.link.current() : null
    if (connection === null) {
      // The link is down: refused now, never held for it.
      socket.destroy()
      return
    }
    let ending = false
    let stream: HostStream | null = null
    const finish = (): void => {
      forward.sockets.delete(socket)
      stream?.close()
      stream = null
    }
    forward.sockets.set(socket, () => {
      finish()
      socket.destroy()
    })
    stream = connection.openStream(
      'sessions:port',
      { id: forward.info.session, port: forward.info.port },
      {
        manualCredit: true,
        data: (bytes) => {
          const given = stream
          socket.write(bytes, () => given?.consumed(bytes.length))
        },
        close: (reason) => {
          stream = null
          forward.sockets.delete(socket)
          if (reason !== null) deps.log(`forwards: port ${String(forward.info.port)} closed a connection (${reason})`)
          socket.end()
        },
        drained: () => {
          if (ending) finish()
          else socket.resume()
        }
      }
    )
    socket.on('data', (chunk: Buffer) => {
      if (stream === null) return
      stream.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length))
      if (stream.queued() > MOST_QUEUED) socket.pause()
    })
    socket.on('end', () => {
      ending = true
      if (stream === null || stream.queued() === 0) finish()
    })
    socket.on('error', () => undefined)
    socket.on('close', finish)
    socket.resume()
  }

  const listen = async (host: string, session: number, port: number): Promise<ForwardedPort> => {
    const server = make()
    // The same number when it is free here, another free one when not.
    if (!(await listenAt(server, port)) && !(await listenAt(server, 0))) {
      throw new Error('This PC has no free port on its loopback address to forward to.')
    }
    const address = server.address()
    const local = typeof address === 'object' && address !== null ? address.port : port
    const forward: Forward = { info: { host, session, port, local }, server, sockets: new Map() }
    server.on('connection', (socket) => carry(forward, socket))
    server.on('error', (error) => deps.log(`forwards: the listener on port ${String(local)} failed (${error.message})`))
    const attached = hosts.get(host)
    if (attached === undefined || attached.stopped) {
      server.close()
      throw new Error('That host was removed from this PC.')
    }
    forwards.set(keyOf(host, session, port), forward)
    tell()
    return { ...forward.info }
  }

  return {
    attach(host, link) {
      const attached: Attached = { link, subscription: null, stopped: false }
      hosts.set(host, attached)
      link.onConnected(async (connection) => {
        if (attached.stopped) return
        attached.subscription?.unsubscribe()
        attached.subscription = connection.subscribe('session:exit', {
          event: (record) => closeWhere((info) => info.host !== host || info.session !== record.id),
          error: () => undefined
        })
        // A session that ended while the link was down ends its forwards now.
        try {
          const rows = await connection.request('session:list', null)
          if (attached.stopped) return
          const running = new Set(rows.filter((row) => row.status === 'running').map((row) => row.id))
          closeWhere((info) => info.host !== host || running.has(info.session))
        } catch (error) {
          deps.log(`forwards: the host's sessions were not listed (${(error as Error).message})`)
        }
      })
      return {
        stop() {
          attached.stopped = true
          attached.subscription?.unsubscribe()
          attached.subscription = null
          if (hosts.get(host) === attached) hosts.delete(host)
          closeWhere((info) => info.host !== host)
        }
      }
    },

    open(host, session, port) {
      const key = keyOf(host, session, port)
      const open = forwards.get(key)
      if (open !== undefined) return Promise.resolve({ ...open.info })
      const pending = opening.get(key)
      if (pending !== undefined) return pending
      const attached = hosts.get(host)
      if (attached === undefined || attached.stopped) return Promise.reject(new Error('This PC has no such host.'))
      if (attached.link.current() === null) {
        return Promise.reject(new Error('That host is not connected; its port is forwarded once it is.'))
      }
      const made = listen(host, session, port).finally(() => opening.delete(key))
      opening.set(key, made)
      return made
    },

    list: () => [...forwards.values()].map((forward) => ({ ...forward.info })),

    stop() {
      for (const attached of hosts.values()) {
        attached.stopped = true
        attached.subscription?.unsubscribe()
      }
      hosts.clear()
      closeWhere(() => false)
    }
  }
}
