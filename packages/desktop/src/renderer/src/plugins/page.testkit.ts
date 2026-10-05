import { vi } from 'vitest'
import { HELLO, type ConnectMessage, type HelmMessage } from '../../plugin-runtime/wire'

/**
 * A plugin page, played by a test, for anything that drives the relay through
 * a real frame element: `pluginFrames.ts` and the components on top of it.
 *
 * jsdom has no MessageChannel, and a real one would not let a test end the
 * page's side the way a crashed process does, so the channel is a small fake:
 * port1 is the relay's, port2 is the page's, delivery is synchronous, and
 * closing one side raises `close` on the other - the event Chromium raises when
 * the page's process goes away. `vi.stubGlobal('MessageChannel', FakeChannel)`
 * puts it in place.
 */

export class FakePort extends EventTarget {
  peer: FakePort | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  /** What arrived on this port, in order. */
  received: unknown[] = []

  postMessage(data: unknown): void {
    if (this.closed) return
    this.peer?.deliver(data)
  }

  deliver(data: unknown): void {
    if (this.closed) return
    this.received.push(data)
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  start(): void {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.peer?.dispatchEvent(new Event('close'))
  }
}

export class FakeChannel {
  port1 = new FakePort()
  port2 = new FakePort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

/** A `message` event with the fields a browser sets, which jsdom's MessageEvent will not take from a test. */
function windowMessage(init: { data: unknown; origin: string; source: unknown }): Event {
  const event = new Event('message')
  Object.defineProperties(event, {
    data: { value: init.data },
    origin: { value: init.origin },
    source: { value: init.source },
    ports: { value: [] }
  })
  return event
}

/**
 * The page in `element` says HELLO, as the bridge does from the top of its
 * `<head>`. Returns the page's end of the port the relay answered with, and
 * the CONNECT message that carried it.
 */
export function sayHello(element: HTMLIFrameElement, origin: string): { port: FakePort; connect: ConnectMessage } {
  const win = element.contentWindow
  if (win === null) throw new Error('the frame has no window: is it in the document?')
  const post = vi.spyOn(win, 'postMessage').mockImplementation(() => undefined)
  window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin, source: win }))
  const last = post.mock.calls.at(-1) as unknown as [ConnectMessage, string, FakePort[]] | undefined
  post.mockRestore()
  if (last === undefined) throw new Error('the relay did not answer HELLO')
  const port = last[2][0]
  if (port === undefined) throw new Error('the relay answered HELLO without a port')
  return { port, connect: last[0] }
}

/** What a page received on its port, as messages. */
export const received = (port: FakePort): HelmMessage[] => port.received as HelmMessage[]
