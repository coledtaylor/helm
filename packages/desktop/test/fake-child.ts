import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { FrameDecoder, encodeFrame } from '../src/main/host/frame'
import type { HostChild, SpawnOptions } from '../src/main/host/launcher'
import { PROTOCOL_VERSION } from '../src/main/host/protocol'

/**
 * A child process with in-memory pipes, whose program the test plays: for the
 * launchers that spawn `floti`, the local host's and a remote host's.
 */
export class FakeChild extends EventEmitter implements HostChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  unrefed = false

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly options: SpawnOptions
  ) {
    super()
  }

  exit(code: number): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, null)
  }

  kill(): boolean {
    if (!this.running) return false
    this.killed = true
    this.signalCode = 'SIGTERM'
    this.stdout.end()
    this.stderr.end()
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  unref(): void {
    this.unrefed = true
  }

  /** Whether the program is still running: neither exited nor killed. */
  get running(): boolean {
    return this.exitCode === null && this.signalCode === null
  }

  /** Resolves once Helm has closed this program's standard input. */
  inputClosed(): Promise<void> {
    return new Promise((resolve) => {
      if (this.stdin.writableFinished || this.stdin.readableEnded) resolve()
      else this.stdin.once('end', () => resolve()).resume()
    })
  }
}

export type Program = (child: FakeChild) => void

/** A bridge connected to a host: it welcomes the hello and exits successfully when its input closes. */
export const connects: Program = (child) => {
  const decoder = new FrameDecoder()
  child.stdin.on('data', (chunk: Uint8Array) => {
    decoder.push(chunk)
    for (let next = decoder.next(); next !== null; next = decoder.next()) {
      if ('message' in next && next.message.type === 'hello') {
        child.stdout.write(
          encodeFrame({
            type: 'welcome',
            protocol: {
              major: PROTOCOL_VERSION.major,
              minor: PROTOCOL_VERSION.minor
            },
            hostVersion: '0.4.1',
            capabilities: ['terminal'],
            backends: []
          })
        )
      }
    }
  })
  child.stdin.once('end', () => child.exit(0))
}

/**
 * A bridge to a host that answers a restart frame with `state`, records the
 * frame's type in `asked`, then closes the connection as the host does.
 */
export function answersRestart(
  state: { hostVersion: string; sessions: number; keeperLink: number | null },
  asked: string[] = []
): Program {
  return (child) => {
    const decoder = new FrameDecoder()
    child.stdin.on('data', (chunk: Uint8Array) => {
      decoder.push(chunk)
      for (let next = decoder.next(); next !== null; next = decoder.next()) {
        if (!('message' in next)) continue
        const { type } = next.message
        if (type !== 'restartAsk' && type !== 'restart') continue
        asked.push(type)
        child.stdout.write(
          encodeFrame({
            type: 'restartState',
            hostVersion: state.hostVersion,
            protocol: { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor },
            sessions: state.sessions,
            keeperLink: state.keeperLink
          })
        )
        child.exit(6)
      }
    })
  }
}

