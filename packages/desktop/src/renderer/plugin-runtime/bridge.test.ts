import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HelmBridge, HelmContext, HelmError, HelmTheme } from '@coledtaylor/helm-plugin-sdk'
import type { PluginFetchRequest, PluginFetchResponse } from '../../shared/ipc'
import { installBridge } from './bridge'
import { CONNECT, HELLO, contextName, type FrameMessage } from './wire'

/**
 * `window.helm`, as a plugin page gets it: installed into a real jsdom frame
 * whose parent plays the Helm page framing it. The parent is reached as the
 * frame's own `parent`: jsdom hands a frame a window proxy that is not the
 * object vitest puts on `globalThis.window`.
 *
 * The port Helm hands over is a small fake (jsdom has no MessageChannel):
 * `helmSide` is the relay's end, so what the page sent is `helmSide.received`
 * and what Helm answers is `helmSide.postMessage`.
 */

class FakePort {
  peer: FakePort | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  received: unknown[] = []
  postMessage(data: unknown): void {
    this.peer?.deliver(data)
  }
  deliver(data: unknown): void {
    this.received.push(data)
    this.onmessage?.(new MessageEvent('message', { data }))
  }
  start(): void {}
  close(): void {}
}

function channel(): { helmSide: FakePort; pageSide: FakePort } {
  const helmSide = new FakePort()
  const pageSide = new FakePort()
  helmSide.peer = pageSide
  pageSide.peer = helmSide
  return { helmSide, pageSide }
}

const THEME: HelmTheme = {
  kind: 'dark',
  tokens: { bg: '#101010', fg: '#eeeeee', accent: '#3366ff' } as HelmTheme['tokens'],
  radius: 4,
  density: 'compact'
}

const LIGHT: HelmTheme = { ...THEME, kind: 'light', tokens: { bg: '#ffffff' } as HelmTheme['tokens'], radius: 2, density: 'comfortable' }

const PANEL: HelmContext = { plugin: 'sample', surface: 'panel', name: 'main', params: {} }

interface Page {
  win: Window & { helm: HelmBridge }
  helm: HelmBridge
  /** What the page posted to its parent before it had a port. */
  hellos: unknown[]
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** A frame with the bridge installed, as Helm serves a page: named with its context, booted with a theme. */
function page(context: HelmContext | null = PANEL, boot: string | null = JSON.stringify({ theme: THEME })): Page {
  const frame = document.createElement('iframe')
  document.body.appendChild(frame)
  const win = frame.contentWindow as Window & { helm: HelmBridge }
  if (context !== null) win.name = contextName(context)
  const parentPost = vi.spyOn(win.parent, 'postMessage').mockImplementation(() => undefined)
  const helm = installBridge(win, boot)
  const hellos = parentPost.mock.calls.map((call) => call[0])
  return { win, helm, hellos }
}

/** A `message` event made in the page's own realm, with the fields a browser sets. */
function message(win: Window, init: { data: unknown; source: unknown; ports?: unknown[] }): Event {
  const event = new (win as unknown as typeof globalThis).Event('message')
  Object.defineProperties(event, {
    data: { value: init.data },
    source: { value: init.source },
    ports: { value: init.ports ?? [] },
    origin: { value: 'http://localhost' }
  })
  return event
}

/** Helm answering HELLO: CONNECT, from the parent, with the page's port. */
function connect(win: Window, extra: Partial<{ context: HelmContext; theme: HelmTheme | null; visible: boolean }> = {}): FakePort {
  const { helmSide, pageSide } = channel()
  win.dispatchEvent(
    message(win, {
      data: { type: CONNECT, context: PANEL, theme: null, visible: false, ...extra },
      source: win.parent,
      ports: [pageSide]
    })
  )
  return helmSide
}

const sent = (port: FakePort): FrameMessage[] => port.received as FrameMessage[]

/** The request the page's last `helm.fetch` sent. */
function lastFetch(port: FakePort): PluginFetchRequest {
  const call = sent(port)
    .filter((entry) => entry.t === 'call' && entry.method === 'fetch')
    .at(-1)
  if (call === undefined || call.t !== 'call') throw new Error('no fetch was sent')
  return call.args[0] as PluginFetchRequest
}

/** The last call the page made, answered. */
function answer(port: FakePort, result: { ok: true; value: unknown } | { ok: false; code: string; message: string }): void {
  const last = sent(port).filter((entry) => entry.t === 'call').at(-1)
  if (last === undefined || last.t !== 'call') throw new Error('no call to answer')
  port.postMessage({ t: 'result', id: last.id, ...result })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('installing', () => {
  it('reads its context from the frame name before anything is said, and says HELLO to its parent', () => {
    const { helm, hellos } = page({ plugin: 'sample', surface: 'tab', name: 'item', params: { id: '2' } })
    expect(helm.context).toEqual({ plugin: 'sample', surface: 'tab', name: 'item', params: { id: '2' } })
    expect(hellos).toEqual([{ type: HELLO }])
    expect(helm.apiVersion).toBe(1)
  })

  it('paints the boot theme onto <html> before the page has run', () => {
    const { win, helm } = page()
    const root = win.document.documentElement
    expect(root.style.getPropertyValue('--helm-bg')).toBe('#101010')
    expect(root.style.getPropertyValue('--helm-accent')).toBe('#3366ff')
    expect(root.style.getPropertyValue('--helm-radius')).toBe('4px')
    expect(root.dataset['density']).toBe('compact')
    expect(root.dataset['theme']).toBe('dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(helm.theme).toEqual(THEME)
  })

  it('is on window as helm, frozen, and cannot be replaced', () => {
    const { win, helm } = page()
    expect(win.helm).toBe(helm)
    expect(Object.isFrozen(win.helm)).toBe(true)
    const descriptor = Object.getOwnPropertyDescriptor(win, 'helm')
    expect(descriptor).toMatchObject({ writable: false, configurable: false })
    // Modules are strict, so assigning to it throws rather than failing quietly.
    expect(() => {
      ;(win as unknown as Record<string, unknown>)['helm'] = {}
    }).toThrow(TypeError)
  })
})

describe('the port', () => {
  it('holds calls made before CONNECT, then sends them in order', () => {
    const { win, helm } = page()
    void helm.settings.get()
    void helm.badge.set(3)
    const port = connect(win)
    expect(sent(port)).toEqual([
      { t: 'call', id: 1, method: 'settings.get', args: [] },
      { t: 'call', id: 2, method: 'badge.set', args: [3] }
    ])
  })

  it('is taken only from the parent, only with a port, and only once', () => {
    const { win, helm } = page()
    // Not from the parent.
    const stranger = channel()
    win.dispatchEvent(message(win, { data: { type: CONNECT, context: PANEL, theme: null, visible: false }, source: win, ports: [stranger.pageSide] }))
    // No port.
    win.dispatchEvent(message(win, { data: { type: CONNECT, context: PANEL, theme: null, visible: false }, source: win.parent }))
    void helm.settings.get()
    expect(stranger.helmSide.received).toEqual([])
    const first = connect(win)
    const second = connect(win)
    void helm.status.set(null)
    expect(sent(first).map((entry) => entry.t === 'call' && entry.method)).toEqual(['settings.get', 'status.set'])
    expect(sent(second)).toEqual([])
  })

  it('takes the context, theme and visibility CONNECT gives, and a null theme keeps the boot one', () => {
    const { win, helm } = page()
    const visibility = vi.fn()
    helm.on('visibility', visibility)
    connect(win, { context: { ...PANEL, params: { from: 'connect' } }, theme: null, visible: true })
    expect(helm.context.params).toEqual({ from: 'connect' })
    expect(helm.theme).toEqual(THEME)
    expect(helm.visible).toBe(true)
    expect(visibility).toHaveBeenCalledWith(true)
  })
})

describe('calls', () => {
  it('resolve with what Helm answered', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const settings = helm.settings.get()
    answer(port, { ok: true, value: { limit: 20 } })
    await expect(settings).resolves.toEqual({ limit: 20 })
  })

  it('reject with a HelmError carrying the code', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const ran = helm.exec('nope', ['a'])
    expect(sent(port).at(-1)).toEqual({ t: 'call', id: 1, method: 'exec', args: ['nope', ['a'], {}] })
    answer(port, { ok: false, code: 'not-declared', message: '"nope" is not one of the programs' })
    const error = (await ran.catch((failure: unknown) => failure)) as HelmError
    expect(error.name).toBe('HelmError')
    expect(error.code).toBe('not-declared')
    expect(error.message).toBe('"nope" is not one of the programs')
  })

  it('reject as an AbortError when Helm says the call was aborted', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const opened = helm.tabs.open('item', { id: '2' }, { title: 'Two' })
    expect(sent(port).at(-1)).toEqual({ t: 'call', id: 1, method: 'tabs.open', args: ['item', { id: '2' }, { title: 'Two' }] })
    answer(port, { ok: false, code: 'aborted', message: 'stopped' })
    await expect(opened).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('send a cancel when the page aborts, reject at once, and ignore a late answer', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const controller = new AbortController()
    const fetched = helm.fetch('https://api.example.com/items', { signal: controller.signal })
    await flush()
    const call = sent(port).at(-1)
    expect(call).toMatchObject({ t: 'call', method: 'fetch' })
    controller.abort()
    await expect(fetched).rejects.toMatchObject({ name: 'AbortError' })
    expect(sent(port).at(-1)).toEqual({ t: 'cancel', id: (call as { id: number }).id })
    port.postMessage({ t: 'result', id: (call as { id: number }).id, ok: true, value: {} })
  })

  it('reject before sending anything when the signal is already aborted', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const controller = new AbortController()
    controller.abort()
    await expect(helm.fetch('https://api.example.com/', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(sent(port)).toEqual([])
  })
})

describe('fetch', () => {
  it('sends the request taken apart: URL, method, headers and the body as bytes', async () => {
    const { win, helm } = page()
    const port = connect(win)
    void helm.fetch('https://api.example.com/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer {{sample-token}}' },
      body: JSON.stringify({ title: 'x' })
    })
    await flush()
    const request = lastFetch(port)
    expect(request.url).toBe('https://api.example.com/items')
    expect(request.method).toBe('POST')
    expect(Object.fromEntries(request.headers)).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer {{sample-token}}'
    })
    expect(new TextDecoder().decode(request.body!)).toBe('{"title":"x"}')
    expect(request.redirect).toBe('follow')
  })

  it('sends no body for a GET', async () => {
    const { win, helm } = page()
    const port = connect(win)
    void helm.fetch('https://api.example.com/items')
    await flush()
    const request = lastFetch(port)
    expect(request.method).toBe('GET')
    expect(request.body).toBeNull()
  })

  it('gives back a Response with the status, headers, body, final URL and whether it was redirected', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const fetched = helm.fetch('https://api.example.com/items')
    await flush()
    const response: PluginFetchResponse = {
      status: 201,
      statusText: 'Created',
      headers: [
        ['content-type', 'application/json'],
        ['bad header', 'dropped, not thrown']
      ],
      body: new TextEncoder().encode('{"id":"4"}'),
      url: 'https://api.example.com/items/4',
      redirected: true
    }
    answer(port, { ok: true, value: response })
    const got = await fetched
    expect(got.status).toBe(201)
    expect(got.statusText).toBe('Created')
    expect(got.headers.get('content-type')).toBe('application/json')
    expect(got.url).toBe('https://api.example.com/items/4')
    expect(got.redirected).toBe(true)
    await expect(got.json()).resolves.toEqual({ id: '4' })
  })

  it('gives a 204 no body, as fetch would', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const fetched = helm.fetch('https://api.example.com/items/1/read', { method: 'POST' })
    await flush()
    answer(port, {
      ok: true,
      value: { status: 204, statusText: '', headers: [], body: new Uint8Array(), url: 'https://api.example.com/items/1/read', redirected: false }
    })
    const got = await fetched
    expect(got.status).toBe(204)
    expect(got.body).toBeNull()
  })
})

describe('events', () => {
  it('reach every listener for them, and an unsubscribed one no longer', () => {
    const { win, helm } = page()
    const port = connect(win)
    const first = vi.fn()
    const second = vi.fn()
    const off = helm.on('command', first)
    helm.on('command', second)
    port.postMessage({ t: 'event', name: 'command', data: { id: 'refresh' } })
    off()
    port.postMessage({ t: 'event', name: 'command', data: { id: 'again' } })
    expect(first.mock.calls).toEqual([[{ id: 'refresh' }]])
    expect(second.mock.calls).toEqual([[{ id: 'refresh' }], [{ id: 'again' }]])
  })

  it('keep going past a listener that throws, and the throw is reported rather than swallowed', async () => {
    const { win, helm } = page()
    const port = connect(win)
    const reported: unknown[] = []
    win.addEventListener('error', (event) => {
      event.preventDefault()
      reported.push((event as ErrorEvent).error)
    })
    const after = vi.fn()
    helm.on('action', () => {
      throw new Error('plugin bug')
    })
    helm.on('action', after)
    port.postMessage({ t: 'event', name: 'action', data: { id: 'add' } })
    expect(after).toHaveBeenCalledWith({ id: 'add' })
    await vi.waitFor(() => expect(reported).toHaveLength(1))
    expect((reported[0] as Error).message).toBe('plugin bug')
  })

  it.each([
    ['settings', { mode: 'all' }],
    ['secrets', { token: 'ready' }],
    ['command', { id: 'refresh' }],
    ['action', { id: 'add' }],
    ['sessions', [{ id: 'a1b2', name: 'HELM-3', state: 'running' }]]
  ] as const)('pass Helm’s %s event to the page as it came', (name, data) => {
    const { win, helm } = page()
    const port = connect(win)
    const heard = vi.fn()
    helm.on(name, heard)
    port.postMessage({ t: 'event', name, data })
    expect(heard).toHaveBeenCalledWith(data)
  })

  it('apply a new theme to the page before telling it', () => {
    const { win, helm } = page()
    const port = connect(win)
    const seen: string[] = []
    helm.on('theme', (theme) => seen.push(`${theme.kind}:${win.document.documentElement.dataset['theme'] ?? ''}`))
    port.postMessage({ t: 'event', name: 'theme', data: LIGHT })
    expect(seen).toEqual(['light:light'])
    const root = win.document.documentElement
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.getPropertyValue('--helm-bg')).toBe('#ffffff')
    expect(root.style.getPropertyValue('--helm-radius')).toBe('2px')
    expect(helm.theme).toEqual(LIGHT)
  })

  it('say visibility only when it changes', () => {
    const { win, helm } = page()
    const port = connect(win)
    const visibility = vi.fn()
    helm.on('visibility', visibility)
    port.postMessage({ t: 'event', name: 'visibility', data: false })
    port.postMessage({ t: 'event', name: 'visibility', data: true })
    port.postMessage({ t: 'event', name: 'visibility', data: true })
    expect(visibility.mock.calls).toEqual([[true]])
    expect(helm.visible).toBe(true)
  })
})

describe('keys', () => {
  /** A keydown in the page, with the page's own handlers given a chance first. */
  async function press(win: Window, init: KeyboardEventInit): Promise<void> {
    const KeyboardEventInPage = (win as unknown as typeof globalThis).KeyboardEvent
    win.document.body.dispatchEvent(new KeyboardEventInPage('keydown', { bubbles: true, cancelable: true, ...init }))
    // The bridge looks again after the page's handlers, on the page's own timer.
    await new Promise((resolve) => win.setTimeout(resolve, 5))
  }

  const keys = (port: FakePort): unknown[] => sent(port).filter((entry) => entry.t === 'key')

  it('forwards a Helm shortcut the page did not take', async () => {
    const { win } = page()
    const port = connect(win)
    await press(win, { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true })
    expect(keys(port)).toEqual([
      {
        t: 'key',
        key: { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, repeat: false }
      }
    ])
  })

  it("keeps the page's own: editing keys, AltGr, a bare modifier, no modifier at all, and anything it prevented", async () => {
    const { win } = page()
    const port = connect(win)
    for (const key of ['c', 'V', 'x', 'z', 'a', 'y']) await press(win, { key, ctrlKey: true })
    await press(win, { key: '@', ctrlKey: true, altKey: true })
    await press(win, { key: 'q', modifierAltGraph: true, ctrlKey: true } as KeyboardEventInit)
    await press(win, { key: 'Control', ctrlKey: true })
    await press(win, { key: 'n' })
    win.document.addEventListener('keydown', (event) => event.preventDefault(), { once: true })
    await press(win, { key: 'n', ctrlKey: true })
    expect(keys(port)).toEqual([])
  })

  it('are not watched at all on a background page', async () => {
    const { win } = page({ plugin: 'sample', surface: 'background', name: 'background', params: {} })
    const port = connect(win)
    await press(win, { key: 'n', ctrlKey: true })
    expect(keys(port)).toEqual([])
  })
})

describe('the surface title', () => {
  it("is trimmed and capped, and empty or not text means the manifest's title", () => {
    const { win, helm } = page()
    const port = connect(win)
    helm.surface.setTitle('  Second item  ')
    helm.surface.setTitle('x'.repeat(200))
    helm.surface.setTitle('   ')
    helm.surface.setTitle(null)
    expect(sent(port).filter((entry) => entry.t === 'title')).toEqual([
      { t: 'title', title: 'Second item' },
      { t: 'title', title: 'x'.repeat(120) },
      { t: 'title', title: null },
      { t: 'title', title: null }
    ])
  })
})

describe('tools', () => {
  const BACKGROUND: HelmContext = { plugin: 'sample', surface: 'background', name: 'background', params: {} }
  const SESSION = { id: 'a1b2c3', name: 'alpha', cwd: 'C:/work/alpha' }

  /** A background page, connected. */
  const background = (): { win: Page['win']; helm: HelmBridge; port: FakePort } => {
    const { win, helm } = page(BACKGROUND)
    return { win, helm, port: connect(win, { context: BACKGROUND }) }
  }
  const call = (port: FakePort, id: string, name: string, args: Record<string, unknown> = {}): void =>
    port.postMessage({ t: 'tool', id, name, args, session: SESSION })
  const results = (port: FakePort): FrameMessage[] =>
    sent(port)
      .filter((entry) => entry.t === 'tool-result')
      .sort((a, b) => ((a as { id: string }).id < (b as { id: string }).id ? -1 : 1))

  it('answer with what the handler returned: text as it is, nothing as Done., anything else as JSON', async () => {
    const { helm, port } = background()
    const seen: unknown[] = []
    helm.tools.handle('echo', (args, { session, signal }) => {
      seen.push({ args, session, aborted: signal.aborted })
      return 'hello'
    })
    helm.tools.handle('nothing', () => undefined)
    helm.tools.handle('json', () => Promise.resolve({ items: [1, 2] }))
    call(port, 't1', 'echo', { a: 1 })
    call(port, 't2', 'nothing')
    call(port, 't3', 'json')
    await flush()
    expect(seen).toEqual([{ args: { a: 1 }, session: SESSION, aborted: false }])
    expect(results(port)).toEqual([
      { t: 'tool-result', id: 't1', ok: true, text: 'hello' },
      { t: 'tool-result', id: 't2', ok: true, text: 'Done.' },
      { t: 'tool-result', id: 't3', ok: true, text: JSON.stringify({ items: [1, 2] }, null, 2) }
    ])
  })

  it('fail with the reason when the handler threw, or answered with what a session cannot read', async () => {
    const { helm, port } = background()
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    helm.tools.handle('boom', () => {
      throw new Error('The board is locked.')
    })
    helm.tools.handle('fn', () => () => 1)
    helm.tools.handle('big', () => 'x'.repeat(1_000_001))
    helm.tools.handle('cycle', () => cycle)
    for (const [id, name] of [['t1', 'boom'], ['t2', 'fn'], ['t3', 'big'], ['t4', 'cycle']] as const) call(port, id, name)
    await flush()
    const said = results(port).map((entry) => (entry as { ok: boolean; message?: string }).message)
    expect(results(port).every((entry) => (entry as { ok: boolean }).ok === false)).toBe(true)
    expect(said[0]).toBe('The board is locked.')
    expect(said[1]).toBe('The tool answered with a function, which is not text or JSON.')
    expect(said[2]).toBe("The tool's answer is 1000001 characters, and a tool may answer with 1000000 at most.")
    expect(said[3]).toMatch(/^The tool's answer could not be written as JSON: /)
  })

  it('hold a call that arrives before its handler, and answer it once the handler is registered', async () => {
    const { helm, port } = background()
    call(port, 't1', 'late')
    await flush()
    expect(results(port)).toEqual([])
    helm.tools.handle('late', () => 'here now')
    await flush()
    expect(results(port)).toEqual([{ t: 'tool-result', id: 't1', ok: true, text: 'here now' }])
  })

  it('fail a call no handler is registered for within the wait, saying how to register one', async () => {
    const { win, port } = background()
    const timers: Array<() => void> = []
    vi.spyOn(win, 'setTimeout').mockImplementation(((callback: () => void) => {
      timers.push(callback)
      return timers.length
    }) as unknown as typeof win.setTimeout)
    call(port, 't1', 'missing')
    await flush()
    expect(results(port)).toEqual([])
    for (const fire of timers) fire()
    await flush()
    expect(results(port)).toEqual([
      {
        t: 'tool-result',
        id: 't1',
        ok: false,
        message:
          "The plugin's background page has no handler for missing. It registers one with helm.tools.handle('missing', ...) as it starts."
      }
    ])
  })

  it("abort the handler's signal when Helm cancels the call, and send no answer for it", async () => {
    const { helm, port } = background()
    let signal: AbortSignal | null = null
    let finish: (value: string) => void = () => undefined
    helm.tools.handle('slow', (_args, { signal: given }) => {
      signal = given
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    })
    call(port, 't1', 'slow')
    await flush()
    expect(signal!.aborted).toBe(false)
    port.postMessage({ t: 'tool-cancel', id: 't1' })
    expect(signal!.aborted).toBe(true)
    finish('too late')
    await flush()
    expect(results(port)).toEqual([])
  })

  it('take the newest handler for a name, and removing an older one leaves it', async () => {
    const { helm, port } = background()
    const removeFirst = helm.tools.handle('pick', () => 'first')
    helm.tools.handle('pick', () => 'second')
    removeFirst()
    call(port, 't1', 'pick')
    await flush()
    expect(results(port)).toEqual([{ t: 'tool-result', id: 't1', ok: true, text: 'second' }])
  })

  it('are handled in the background page only, by a name and a function', () => {
    const panel = page().helm
    expect(() => panel.tools.handle('pick', () => 'x')).toThrow(
      expect.objectContaining({ code: 'invalid', message: 'helm.tools.handle works in the background page only' }) as Error
    )
    const { helm } = background()
    expect(() => helm.tools.handle('', () => 'x')).toThrow('helm.tools.handle needs the name of a tool')
    expect(() => helm.tools.handle('pick', 'x' as never)).toThrow('helm.tools.handle needs a function to answer the tool')
  })
})
