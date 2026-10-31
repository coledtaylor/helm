import type { Readable, Writable } from 'node:stream'
import { connectHost as connectOver, type ByteTransport, type HostConnection } from '../../shared/host/client'
import type { Capability } from './protocol'

/**
 * Main's own connection to the host, over `floti bridge`'s standard output
 * (the host's frames) and standard input (main's). The protocol itself is
 * `shared/host/client.ts`, which a Helm page's connection shares.
 */

export * from '../../shared/host/client'

/** The two byte streams main's connection runs over. */
export interface HostTransport {
  /** The host's frames, arriving. */
  input: Readable
  /** The desktop's frames, leaving. Ended when the connection is closed. */
  output: Writable
}

export interface MainConnectOptions {
  transport: HostTransport
  /** Helm's own version, for the `hello`'s client name. */
  appVersion: string
  /** A line for Helm's log. Never given a payload, a frame or stream bytes. */
  log?: (line: string) => void
}

/**
 * What main's connection says it can do. `browser`: its browser pane answers
 * the browser tools' calls (`browser-tools.ts`). `pluginPages`: it draws
 * plugins' pages from files the host serves (`plugins.ts`). `terminal` and
 * `files`: the window's sessions, terminals and files it still relays.
 */
export const MAIN_CAPABILITIES: readonly Capability[] = ['terminal', 'files', 'browser', 'pluginPages']

/** A byte transport over a pair of Node streams. */
export function streamTransport(input: Readable, output: Writable): ByteTransport {
  const open = (): boolean => !output.writableEnded && !output.destroyed
  return {
    start(receiver) {
      const failed = (error: Error): void => receiver.end(`The connection to the local host failed: ${error.message}`)
      input.on('data', (chunk: Uint8Array) => receiver.data(chunk))
      input.once('end', () => receiver.end(null))
      input.once('close', () => receiver.end(null))
      input.once('error', failed)
      output.once('error', failed)
      output.once('close', () => receiver.end(null))
    },
    write(bytes) {
      if (open()) output.write(bytes)
    },
    end() {
      if (open()) output.end()
    }
  }
}

/** Says hello on `transport` as main and resolves once the host welcomed it. */
export function connectHost(options: MainConnectOptions): Promise<HostConnection> {
  return connectOver({
    transport: streamTransport(options.transport.input, options.transport.output),
    appVersion: options.appVersion,
    capabilities: MAIN_CAPABILITIES,
    ...(options.log !== undefined ? { log: options.log } : {})
  })
}
