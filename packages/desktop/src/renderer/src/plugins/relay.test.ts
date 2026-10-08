import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelmTheme } from '@coledtaylor/helm-plugin-sdk'
import type { HelmBridge, PluginCallOutcome, PluginCallRequest, PluginDelivery, PluginToolCall } from '../../../shared/ipc'
import { CONNECT, HELLO, type ConnectMessage, type HelmMessage } from '../../plugin-runtime/wire'
import { CRASH_GRACE_MS, LOAD_GRACE_MS, createPluginRelay, type PluginRelay, type SurfaceSpec } from './relay'

/**
 * The Helm half of every plugin frame, against a page the test plays.
 *
 * jsdom has no MessageChannel, and a real one would not let a test end the
 * page's side the way a crashed process does, so the channel is a small fake:
 * port1 is the relay's, port2 is the page's, delivery is synchronous, and
 * closing one side raises `close` on the other - the event Chromium raises when
 * the page's process goes away. Main is a fake bridge whose `plugins:call`
 * answers wait until the test settles them.
 */

class FakePort extends EventTarget {
  peer: FakePort | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false
  /** What arrived on this port, in order. */
  received: unknown[] = []
  /** What was posted from this port, with what it transferred. */
  posted: Array<{ data: unknown; transfer: unknown[] }> = []

  postMessage(data: unknown, transfer: unknown[] = []): void {
    if (this.closed) return
    this.posted.push({ data, transfer })
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

class FakeChannel {
  port1 = new FakePort()
  port2 = new FakePort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

/** Main, as the relay sees it: requests answered by the test, events pushed by the test. */
function fakeMain() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const calls: PluginCallRequest[] = []
  const settlers = new Map<string, (outcome: PluginCallOutcome) => void>()
  const invoke = vi.fn((channel: string, payload?: unknown): Promise<unknown> => {
    if (channel === 'plugins:call') {
      const request = payload as PluginCallRequest
      calls.push(request)
      return new Promise((resolve) => settlers.set(request.callId, resolve))
    }
    // No first theme: the relay's own read is not what these tests are about.
    return Promise.reject(new Error(`${channel} is not answered here`))
  })
  const send = vi.fn()
  const on = vi.fn((channel: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set()
    set.add(listener)
    listeners.set(channel, set)
    return () => set.delete(listener)
  })
  return {
    ipc: { invoke, send, on } as unknown as HelmBridge,
    invoke,
    send,
    calls,
    emit(channel: string, payload: unknown): void {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    },
    settle(callId: string, outcome: PluginCallOutcome): void {
      settlers.get(callId)?.(outcome)
    },
    listening: (channel: string) => listeners.get(channel)?.size ?? 0
  }
}

/** Promise callbacks run; nothing else moves. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/** A `message` event with the fields a browser sets, which jsdom's MessageEvent will not take from a test. */
function windowMessage(init: { data: unknown; origin: string; source: unknown; ports?: unknown[] }): Event {
  const event = new Event('message')
  Object.defineProperties(event, {
    data: { value: init.data },
    origin: { value: init.origin },
    source: { value: init.source },
    ports: { value: init.ports ?? [] }
  })
  return event
}

const spec = (overrides: Partial<SurfaceSpec> = {}): SurfaceSpec => ({
  key: 'panel:sample/main',
  plugin: 'sample',
  revision: 1,
  url: 'helm-plugin://sample/dist/panels/main.html',
  surface: 'panel',
  name: 'main',
  params: {},
  title: 'Sample',
  ...overrides
})

const THEME: HelmTheme = {
  kind: 'dark',
  tokens: { bg: '#000' } as HelmTheme['tokens'],
  radius: 4,
  density: 'compact'
}

let main: ReturnType<typeof fakeMain>
let relay: PluginRelay

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('MessageChannel', FakeChannel)
  main = fakeMain()
  relay = createPluginRelay({ win: window, ipc: main.ipc })
})

afterEach(() => {
  relay.destroy()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  document.body.replaceChildren()
})

/** A frame on screen, and the page in it saying HELLO; returns the page's end of its port. */
function connect(element: HTMLIFrameElement, origin = 'helm-plugin://sample'): { port: FakePort; connect: ConnectMessage } {
  const win = element.contentWindow!
  const post = vi.spyOn(win, 'postMessage').mockImplementation(() => undefined)
  window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin, source: win }))
  const last = post.mock.calls.at(-1)
  if (last === undefined) throw new Error('the relay did not answer HELLO')
  const [message, target, transfer] = last as unknown as [ConnectMessage, string, FakePort[]]
  expect(target).toBe(origin)
  post.mockRestore()
  return { port: transfer[0]!, connect: message }
}

function open(overrides: Partial<SurfaceSpec> = {}): HTMLIFrameElement {
  const element = relay.open(spec(overrides))
  document.body.appendChild(element)
  return element
}

/** What a page received on its port, as messages. */
const got = (port: FakePort): HelmMessage[] => port.received as HelmMessage[]

describe('the frame', () => {
  it('is made sandboxed, named with its context, on its URL, and loading', () => {
    const element = open({ params: { id: '2' } })
    expect(element.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    expect(element.getAttribute('allow')).toBe('clipboard-write')
    expect(element.referrerPolicy).toBe('no-referrer')
    expect(element.name).toBe('helm:{"plugin":"sample","surface":"panel","name":"main","params":{"id":"2"}}')
    expect(element.getAttribute('src')).toBe('helm-plugin://sample/dist/panels/main.html')
    expect(element.dataset['pluginFrame']).toBe('panel:sample/main')
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'loading' })
  })

  it('is one frame per key: opening the same surface again hands back the same element', () => {
    const first = open()
    expect(relay.open(spec())).toBe(first)
    expect(relay.specs()).toHaveLength(1)
  })
})

describe('the handshake', () => {
  it('answers a HELLO from its own frame with CONNECT, a port, the context and the visibility', () => {
    const element = open({ params: { id: '2' } })
    relay.setVisible('panel:sample/main', true)
    const { port, connect: message } = connect(element)
    expect(port).toBeInstanceOf(FakePort)
    expect(message).toEqual({
      type: CONNECT,
      context: { plugin: 'sample', surface: 'panel', name: 'main', params: { id: '2' } },
      theme: null,
      visible: true
    })
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'ready' })
  })

  it('carries the latest theme main pushed', () => {
    const element = open()
    main.emit('plugins:theme', THEME)
    expect(connect(element).connect.theme).toEqual(THEME)
  })

  it('ignores a HELLO on another plugin origin, or from a window that is not one of its frames', () => {
    const element = open()
    const post = vi.spyOn(element.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin: 'helm-plugin://other', source: element.contentWindow }))
    window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin: 'https://example.com', source: element.contentWindow }))
    const stranger = document.createElement('iframe')
    document.body.appendChild(stranger)
    const strangerPost = vi.spyOn(stranger.contentWindow!, 'postMessage').mockImplementation(() => undefined)
    window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin: 'helm-plugin://sample', source: stranger.contentWindow }))
    window.dispatchEvent(windowMessage({ data: { type: 'not-hello' }, origin: 'helm-plugin://sample', source: element.contentWindow }))
    expect(post).not.toHaveBeenCalled()
    expect(strangerPost).not.toHaveBeenCalled()
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'loading' })
  })
})

describe('calls', () => {
  it("go to main under the relay's plugin and surface, and the answer comes back under the page's id", async () => {
    const element = open()
    const { port } = connect(element)
    port.postMessage({ t: 'call', id: 7, method: 'settings.get', args: [], plugin: 'evil', surface: 'background' })
    expect(main.calls).toHaveLength(1)
    const request = main.calls[0]!
    expect(request).toMatchObject({ plugin: 'sample', surface: 'panel', method: 'settings.get', args: [] })
    main.settle(request.callId, { ok: true, value: { limit: 20 } })
    await flush()
    expect(got(port)).toEqual([{ t: 'result', id: 7, ok: true, value: { limit: 20 } }])
  })

  it('carry a refusal through with its code', async () => {
    const { port } = connect(open())
    port.postMessage({ t: 'call', id: 1, method: 'exec', args: ['nope'] })
    main.settle(main.calls[0]!.callId, { ok: false, code: 'not-declared', message: 'not one of the programs' })
    await flush()
    expect(got(port)).toEqual([{ t: 'result', id: 1, ok: false, code: 'not-declared', message: 'not one of the programs' }])
  })

  it('that open a dialog go to main only while the user has just acted, and are refused otherwise', async () => {
    const { port } = connect(open())
    const request = { cwd: 'C:\\work', prompt: 'work on HELM-2' }
    port.postMessage({ t: 'call', id: 1, method: 'sessions.start', args: [request] })
    expect(main.calls).toHaveLength(0)
    await flush()
    expect(got(port)).toEqual([
      {
        t: 'result',
        id: 1,
        ok: false,
        code: 'not-allowed',
        message: 'helm.sessions.start needs a click or key press the user just made in the page'
      }
    ])

    // jsdom has no user activation; a click in the page is what gives it.
    Object.defineProperty(window.navigator, 'userActivation', { configurable: true, value: { isActive: true, hasBeenActive: true } })
    try {
      port.postMessage({ t: 'call', id: 2, method: 'sessions.start', args: [request] })
    } finally {
      Reflect.deleteProperty(window.navigator, 'userActivation')
    }
    expect(main.calls).toHaveLength(1)
    expect(main.calls[0]).toMatchObject({ plugin: 'sample', method: 'sessions.start', args: [request] })
  })

  it('come back as unavailable when the invoke itself fails', async () => {
    const { port } = connect(open())
    main.invoke.mockImplementationOnce(() => Promise.reject(new Error('main went away')))
    port.postMessage({ t: 'call', id: 1, method: 'settings.get', args: [] })
    await flush()
    expect(got(port)).toEqual([{ t: 'result', id: 1, ok: false, code: 'unavailable', message: 'main went away' }])
  })

  it('hand a fetch body over rather than copy it', async () => {
    const { port } = connect(open())
    port.postMessage({ t: 'call', id: 1, method: 'fetch', args: [{}] })
    const body = new Uint8Array([1, 2, 3])
    main.settle(main.calls[0]!.callId, { ok: true, value: { status: 200, body } })
    await flush()
    // The relay's end posted it, transferring the body's buffer.
    expect(port.peer!.posted.at(-1)!.transfer).toEqual([body.buffer])
  })

  it('are cancelled in main under the same call id', () => {
    const { port } = connect(open())
    port.postMessage({ t: 'call', id: 3, method: 'fetch', args: [{}] })
    const callId = main.calls[0]!.callId
    port.postMessage({ t: 'cancel', id: 3 })
    expect(main.send).toHaveBeenCalledWith('plugins:cancel', { callId })
    // Cancelled is finished: its answer is not passed on.
    main.settle(callId, { ok: true, value: 'late' })
    return flush().then(() => expect(got(port)).toEqual([]))
  })

  it('drop what is malformed, and a second call under an id still running', () => {
    const { port } = connect(open())
    port.postMessage({ t: 'call', id: 0, method: 'x', args: [] })
    port.postMessage({ t: 'call', id: 1.5, method: 'x', args: [] })
    port.postMessage({ t: 'call', id: 1, method: 'x'.repeat(65), args: [] })
    port.postMessage({ t: 'call', id: 1, method: 'x', args: 'no' })
    port.postMessage({ t: 'nonsense' })
    port.postMessage(null)
    expect(main.calls).toHaveLength(0)
    port.postMessage({ t: 'call', id: 1, method: 'x', args: [] })
    port.postMessage({ t: 'call', id: 1, method: 'x', args: [] })
    expect(main.calls).toHaveLength(1)
  })

  it('answered after the page reloaded are dropped, and the old calls were cancelled', async () => {
    const element = open()
    const first = connect(element).port
    first.postMessage({ t: 'call', id: 1, method: 'settings.get', args: [] })
    const callId = main.calls[0]!.callId
    // The page navigated: a new HELLO, a new port.
    const second = connect(element).port
    expect(main.send).toHaveBeenCalledWith('plugins:cancel', { callId })
    expect(first.closed || first.peer!.closed).toBe(true)
    main.settle(callId, { ok: true, value: 'stale' })
    await flush()
    expect(got(first)).toEqual([])
    expect(got(second)).toEqual([])
  })
})

describe('events', () => {
  it('wait for a page with no port yet, and arrive after CONNECT in order', () => {
    const element = open()
    relay.emit('panel:sample/main', 'command', { id: 'refresh' })
    main.emit('plugins:deliver', { plugin: 'sample', event: 'settings', data: { limit: 5 }, to: 'all' } satisfies PluginDelivery)
    const { port } = connect(element)
    expect(got(port)).toEqual([
      { t: 'event', name: 'command', data: { id: 'refresh' } },
      { t: 'event', name: 'settings', data: { limit: 5 } }
    ])
  })

  it('reach only the plugin they are for, and a background delivery only its background page', () => {
    const panel = connect(open()).port
    const background = connect(
      open({ key: 'background:sample', surface: 'background', name: 'background', url: 'helm-plugin://sample/bg.html' })
    ).port
    const other = connect(open({ key: 'panel:other/main', plugin: 'other', url: 'helm-plugin://other/p.html' }), 'helm-plugin://other').port
    main.emit('plugins:deliver', { plugin: 'sample', event: 'command', data: { id: 'refresh' }, to: 'background' })
    main.emit('plugins:deliver', { plugin: 'sample', event: 'secrets', data: { token: 'ready' }, to: 'all' })
    expect(got(panel)).toEqual([{ t: 'event', name: 'secrets', data: { token: 'ready' } }])
    expect(got(background)).toEqual([
      { t: 'event', name: 'command', data: { id: 'refresh' } },
      { t: 'event', name: 'secrets', data: { token: 'ready' } }
    ])
    expect(got(other)).toEqual([])
  })

  it('send a theme change to every connected page', () => {
    const panel = connect(open()).port
    main.emit('plugins:theme', THEME)
    expect(got(panel)).toEqual([{ t: 'event', name: 'theme', data: THEME }])
  })

  it('say when the surface comes on screen and goes off it, once per change', () => {
    const { port } = connect(open())
    relay.setVisible('panel:sample/main', true)
    relay.setVisible('panel:sample/main', true)
    relay.setVisible('panel:sample/main', false)
    expect(got(port)).toEqual([
      { t: 'event', name: 'visibility', data: true },
      { t: 'event', name: 'visibility', data: false }
    ])
  })
})

describe('titles and keys', () => {
  it('reach the hooks, trimmed and capped, and malformed ones are dropped', () => {
    const title = vi.fn()
    const key = vi.fn()
    relay.setHooks({ title, key })
    const element = open()
    const { port } = connect(element)
    port.postMessage({ t: 'title', title: '  Second item  ' })
    port.postMessage({ t: 'title', title: 'x'.repeat(200) })
    port.postMessage({ t: 'title', title: null })
    port.postMessage({ t: 'title', title: '   ' })
    port.postMessage({ t: 'title', title: 42 })
    expect(title.mock.calls.map((call) => call[1])).toEqual(['Second item', 'x'.repeat(120), null])
    expect(title.mock.calls[0]![0]).toMatchObject({ key: 'panel:sample/main' })

    port.postMessage({ t: 'key', key: { key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: 'yes', altKey: false } })
    port.postMessage({ t: 'key', key: { key: 'n'.repeat(40), code: 'KeyN' } })
    port.postMessage({ t: 'key', key: 'n' })
    expect(key).toHaveBeenCalledTimes(1)
    expect(key.mock.calls[0]![1]).toBe(element)
    // Only true is true: a page cannot pass a string for a modifier.
    expect(key.mock.calls[0]![2]).toEqual({
      key: 'n',
      code: 'KeyN',
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      repeat: false
    })
  })
})

describe('failure', () => {
  it('is a page that loaded without saying HELLO within the grace', () => {
    const element = open()
    element.dispatchEvent(new Event('load'))
    vi.advanceTimersByTime(LOAD_GRACE_MS - 1)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'loading' })
    vi.advanceTimersByTime(1)
    expect(relay.state('panel:sample/main')).toMatchObject({ kind: 'failed', reason: 'load' })
  })

  it('is not a page whose HELLO came after its load event, inside the grace', () => {
    const element = open()
    element.dispatchEvent(new Event('load'))
    vi.advanceTimersByTime(LOAD_GRACE_MS / 2)
    connect(element)
    vi.advanceTimersByTime(LOAD_GRACE_MS)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'ready' })
  })

  it("is a port that closed with no new HELLO within the grace: the page's process ended", () => {
    const { port } = connect(open())
    port.postMessage({ t: 'call', id: 1, method: 'fetch', args: [{}] })
    const callId = main.calls[0]!.callId
    port.close()
    // What it was waiting on is cancelled at once.
    expect(main.send).toHaveBeenCalledWith('plugins:cancel', { callId })
    vi.advanceTimersByTime(CRASH_GRACE_MS - 1)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'ready' })
    vi.advanceTimersByTime(1)
    expect(relay.state('panel:sample/main')).toMatchObject({ kind: 'failed', reason: 'crash' })
  })

  it('is not a navigation: the page closed its port and said HELLO again in time', () => {
    const element = open()
    connect(element).port.close()
    vi.advanceTimersByTime(CRASH_GRACE_MS / 2)
    connect(element)
    vi.advanceTimersByTime(CRASH_GRACE_MS)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'ready' })
  })

  it('tells subscribers each time a state changes', () => {
    const listener = vi.fn()
    const off = relay.subscribe(listener)
    const element = open()
    connect(element)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    relay.reload('panel:sample/main')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe("the frame's life", () => {
  it('restarts on reload: the connection ends, its calls are cancelled, and it is loading again', () => {
    const element = open()
    const { port } = connect(element)
    port.postMessage({ t: 'call', id: 1, method: 'fetch', args: [{}] })
    const callId = main.calls[0]!.callId
    relay.reload('panel:sample/main')
    expect(main.send).toHaveBeenCalledWith('plugins:cancel', { callId })
    expect(port.peer!.closed).toBe(true)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'loading' })
    expect(element.getAttribute('src')).toBe('helm-plugin://sample/dist/panels/main.html')
  })

  it('restarts when opened for a newer revision, and not for a new title alone', () => {
    const element = open()
    const { port } = connect(element)
    relay.open(spec({ title: 'Renamed' }))
    expect(element.title).toBe('Renamed')
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'ready' })
    relay.open(spec({ revision: 2 }))
    expect(port.peer!.closed).toBe(true)
    expect(relay.state('panel:sample/main')).toEqual({ kind: 'loading' })
  })

  it('ends on dispose: calls cancelled, the element gone, the key forgotten', () => {
    const element = open()
    const { port } = connect(element)
    port.postMessage({ t: 'call', id: 1, method: 'fetch', args: [{}] })
    const callId = main.calls[0]!.callId
    relay.dispose('panel:sample/main')
    expect(main.send).toHaveBeenCalledWith('plugins:cancel', { callId })
    expect(element.isConnected).toBe(false)
    expect(relay.state('panel:sample/main')).toBeNull()
    // A crash timer cannot bring a disposed frame back.
    vi.advanceTimersByTime(CRASH_GRACE_MS * 2)
    expect(relay.state('panel:sample/main')).toBeNull()
  })

  it('disposes every frame a predicate picks', () => {
    open()
    open({ key: 'panel:other/main', plugin: 'other' })
    relay.disposeWhere((surface) => surface.plugin === 'other')
    expect(relay.specs().map((surface) => surface.key)).toEqual(['panel:sample/main'])
  })

  it('lets go of everything when destroyed', () => {
    const element = open()
    relay.destroy()
    expect(element.isConnected).toBe(false)
    expect(main.listening('plugins:theme')).toBe(0)
    expect(main.listening('plugins:deliver')).toBe(0)
    // A HELLO after that reaches nothing.
    const post = vi.spyOn(window, 'postMessage')
    window.dispatchEvent(windowMessage({ data: { type: HELLO }, origin: 'helm-plugin://sample', source: element.contentWindow }))
    expect(post).not.toHaveBeenCalled()
  })
})

describe('tool calls', () => {
  const BACKGROUND: Partial<SurfaceSpec> = {
    key: 'background:sample',
    surface: 'background',
    name: 'background',
    url: 'helm-plugin://sample/dist/background/index.html'
  }
  const SESSION = { id: 'a1b2c3', name: 'alpha', cwd: 'C:/work/alpha' }
  const tool = (id: string, plugin = 'sample'): PluginToolCall => ({ id, plugin, name: 'list_items', args: { all: true }, session: SESSION })
  const answers = (): unknown[] => main.send.mock.calls.filter(([channel]) => channel === 'plugins:toolResult').map(([, payload]) => payload)

  it("reach the plugin's background page, and its answer goes back to main under the call's id", () => {
    const { port } = connect(open(BACKGROUND))
    const panel = connect(open({ key: 'panel:sample/main' }), 'helm-plugin://sample').port
    main.emit('plugins:tool', tool('c1'))
    expect(got(port)).toEqual([{ t: 'tool', id: 'c1', name: 'list_items', args: { all: true }, session: SESSION }])
    expect(got(panel)).toEqual([])
    port.postMessage({ t: 'tool-result', id: 'c1', ok: true, text: 'two items' })
    port.postMessage({ t: 'tool-result', id: 'c1', ok: true, text: 'again' })
    expect(answers()).toEqual([{ id: 'c1', ok: true, text: 'two items' }])
  })

  it('carry a failure through, and take no answer for a call the page was not handed', () => {
    const { port } = connect(open(BACKGROUND))
    const panel = connect(open({ key: 'panel:sample/main' }), 'helm-plugin://sample').port
    main.emit('plugins:tool', tool('c1'))
    panel.postMessage({ t: 'tool-result', id: 'c1', ok: true, text: 'from the panel' })
    port.postMessage({ t: 'tool-result', id: 'c2', ok: true, text: 'never asked' })
    port.postMessage({ t: 'tool-result', id: 'c1', ok: false, message: 'The board is locked.' })
    expect(answers()).toEqual([{ id: 'c1', ok: false, message: 'The board is locked.' }])
  })

  it('are answered at once when the plugin has no background page connected', () => {
    open(BACKGROUND)
    main.emit('plugins:tool', tool('c1'))
    main.emit('plugins:tool', tool('c2', 'other'))
    expect(answers()).toEqual([
      { id: 'c1', ok: false, message: "The plugin's background page is not running." },
      { id: 'c2', ok: false, message: "The plugin's background page is not running." }
    ])
  })

  it('are cancelled at the page when main says so', () => {
    const { port } = connect(open(BACKGROUND))
    main.emit('plugins:tool', tool('c1'))
    main.emit('plugins:toolCancel', { id: 'c1' })
    main.emit('plugins:toolCancel', { id: 'c9' })
    expect(got(port).at(-1)).toEqual({ t: 'tool-cancel', id: 'c1' })
    // An answer for a cancelled call goes nowhere.
    port.postMessage({ t: 'tool-result', id: 'c1', ok: true, text: 'late' })
    expect(answers()).toEqual([])
  })

  it('fail for the session when the page stops before answering: a crash, a reload, or the frame going', () => {
    const crashed = connect(open(BACKGROUND)).port
    main.emit('plugins:tool', tool('c1'))
    crashed.close()
    connect(relay.open(spec(BACKGROUND)))
    main.emit('plugins:tool', tool('c2'))
    relay.reload('background:sample')
    connect(relay.open(spec(BACKGROUND)))
    main.emit('plugins:tool', tool('c3'))
    relay.dispose('background:sample')
    const stopped = { ok: false, message: "The plugin's background page stopped before it answered." }
    expect(answers()).toEqual([
      { id: 'c1', ...stopped },
      { id: 'c2', ...stopped },
      { id: 'c3', ...stopped }
    ])
  })

  it('stop being listened for when the relay is destroyed', () => {
    relay.destroy()
    expect(main.listening('plugins:tool')).toBe(0)
    expect(main.listening('plugins:toolCancel')).toBe(0)
  })
})
