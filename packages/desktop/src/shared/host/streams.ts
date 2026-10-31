import type { HostConnection, HostStream } from './client'

/**
 * The terminal byte streams the desktop holds open on the host: one per
 * running session (`session:data`) and one per plain terminal (`pterm:data`).
 *
 * A stream is opened as soon as its session or terminal starts, so its output
 * reaches the window from the first byte. The host starts every stream with a
 * redraw of the terminal's screen as it is, written for an empty terminal, and
 * then streams. That is what a window that has just loaded needs, so when the
 * window starts loading every stream is closed (`suspend`), and once its
 * renderer is listening each is opened again (`resume`): the new page's empty
 * terminals are drawn from the redraw and then stream, and nothing the old page
 * was sent reaches the new one.
 *
 * The host's bytes become the strings the window's channels carry through a
 * streaming UTF-8 decoder per stream, so a character split across two chunks
 * arrives whole. Nothing here reads what they say.
 */

export type TerminalChannel = 'session:data' | 'pterm:data'

export interface TerminalStreamsDeps {
  /** The connection streams are opened on, or null when there is none. */
  connection: () => HostConnection | null
  /** Output for the window, as the string its channel carries. */
  deliver: (channel: TerminalChannel, id: number, data: string) => void
  /** The host closed a stream: its session or terminal has ended. */
  closed?: (channel: TerminalChannel, id: number, reason: string | null) => void
  log: (line: string) => void
}

export interface TerminalStreams {
  /** Starts carrying `id`'s terminal, opening its stream now unless suspended. */
  open(channel: TerminalChannel, id: number): void
  /** Stops carrying `id`'s terminal and closes its stream. */
  close(channel: TerminalChannel, id: number): void
  /** Input for `id`'s terminal, in order. Dropped while there is no stream. */
  write(channel: TerminalChannel, id: number, data: string): void
  /** Closes every stream and holds them closed: the window is loading. */
  suspend(): void
  /** Opens every stream again, each a new one: the window's renderer is listening. */
  resume(): void
  /** Closes every stream and forgets them all. */
  closeAll(): void
}

interface Carried {
  channel: TerminalChannel
  id: number
  stream: HostStream | null
}

const key = (channel: TerminalChannel, id: number): string => `${channel}:${String(id)}`

export function createTerminalStreams(deps: TerminalStreamsDeps): TerminalStreams {
  const carried = new Map<string, Carried>()
  const encoder = new TextEncoder()
  let suspended = false

  const start = (entry: Carried): void => {
    const connection = deps.connection()
    if (connection === null) return
    const decoder = new TextDecoder('utf-8')
    let stream: HostStream | null = null
    stream = connection.openStream(
      entry.channel,
      { id: entry.id },
      {
        data: (bytes) => {
          // A stream that has been replaced or closed says nothing more.
          if (entry.stream !== stream) return
          const text = decoder.decode(bytes, { stream: true })
          if (text !== '') deps.deliver(entry.channel, entry.id, text)
        },
        close: (reason) => {
          if (entry.stream !== stream) return
          entry.stream = null
          // Its terminal has ended: there is nothing to open again on a reload.
          if (carried.get(key(entry.channel, entry.id)) === entry) carried.delete(key(entry.channel, entry.id))
          const rest = decoder.decode()
          if (rest !== '') deps.deliver(entry.channel, entry.id, rest)
          if (reason !== null) deps.log(`host: ${entry.channel} ${String(entry.id)} closed: ${reason}`)
          deps.closed?.(entry.channel, entry.id, reason)
        }
      }
    )
    entry.stream = stream
  }

  const stop = (entry: Carried): void => {
    const stream = entry.stream
    entry.stream = null
    stream?.close()
  }

  return {
    open(channel, id) {
      const existing = carried.get(key(channel, id))
      if (existing !== undefined) return
      const entry: Carried = { channel, id, stream: null }
      carried.set(key(channel, id), entry)
      if (!suspended) start(entry)
    },

    close(channel, id) {
      const entry = carried.get(key(channel, id))
      if (entry === undefined) return
      carried.delete(key(channel, id))
      stop(entry)
    },

    write(channel, id, data) {
      carried.get(key(channel, id))?.stream?.write(encoder.encode(data))
    },

    suspend() {
      suspended = true
      for (const entry of carried.values()) stop(entry)
    },

    resume() {
      suspended = false
      for (const entry of carried.values()) {
        stop(entry)
        start(entry)
      }
    },

    closeAll() {
      for (const entry of carried.values()) stop(entry)
      carried.clear()
    }
  }
}
