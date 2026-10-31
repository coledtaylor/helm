import type {
  ExecOptions,
  ExecResult,
  HelmBridge,
  HelmContext,
  HelmError,
  HelmErrorCode,
  HelmEvents,
  HelmTheme,
  PluginParams,
  PluginSession,
  SecretState,
  SessionStartRequest,
  SessionStartResult,
  SettingValue,
  StatusItem,
  ToolHandler
} from '@coledtaylor/helm-plugin-sdk'
import { PLUGIN_TOOL_ANSWER_MAX_CHARS as TOOL_ANSWER_MAX_CHARS, type PluginFetchRequest, type PluginFetchResponse } from '../../shared/ipc'
import {
  CONNECT,
  CONTEXT_PREFIX,
  HELLO,
  type ConnectMessage,
  type FrameMessage,
  type HelmMessage,
  type KeyInit
} from './wire'

/**
 * `window.helm`, as every plugin page gets it.
 *
 * Served by Helm under `/__helm/bridge.js` and injected at the top of the
 * page's `<head>`, so it runs before any of the plugin's own code and the
 * plugin never carries a copy of it. Everything it does is ask the Helm page
 * framing it, over the port that page hands it (`wire.ts`); it holds no
 * authority of its own. Calls made before the port arrives wait for it.
 */

/**
 * Keys that are the page's own business - its clipboard, its undo - even with
 * the editing modifier down: Ctrl, or Cmd on macOS.
 */
const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z'])
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

/** Responses that may not have a body, which `new Response` refuses one for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/**
 * How long a tool call waits for its handler. A page registers its handlers as
 * it starts, and a session can call the moment the page has connected, so the
 * first call may arrive while the page's own scripts are still loading.
 */
export const TOOL_HANDLER_WAIT_MS = 5000

export function installBridge(win: Window, bootText: string | null): HelmBridge {
  const doc = win.document
  const boot = readBoot(bootText)
  let theme = boot.theme ?? fallbackTheme()
  let context = readContext(win)
  let visible = false
  // Off macOS until CONNECT says otherwise.
  let mac = false
  applyTheme(doc, theme)

  let port: MessagePort | null = null
  const queue: FrameMessage[] = []
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const listeners = new Map<string, Set<(data: never) => void>>()
  /** Tool handlers by name, and the calls waiting for one to be registered. */
  const handlers = new Map<string, ToolHandler>()
  const awaitingHandler = new Map<string, Set<() => void>>()
  /** Tool calls being answered, so a cancel can abort the one it names. */
  const answering = new Map<string, AbortController>()

  const post = (message: FrameMessage): void => {
    if (port === null) queue.push(message)
    else port.postMessage(message)
  }

  const call = <T>(method: string, args: unknown[], signal?: AbortSignal | null): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++
      if (signal?.aborted === true) {
        reject(abortError())
        return
      }
      const onAbort = (): void => {
        if (!pending.has(id)) return
        pending.delete(id)
        post({ t: 'cancel', id })
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        }
      })
      post({ t: 'call', id, method, args })
    })

  const emit = <K extends keyof HelmEvents>(name: K, data: HelmEvents[K]): void => {
    for (const listener of listeners.get(name) ?? []) {
      try {
        ;(listener as (value: HelmEvents[K]) => void)(data)
      } catch (error) {
        // One listener's bug is the plugin's, and must not stop the others.
        win.setTimeout(() => {
          throw error
        })
      }
    }
  }

  /** The handler for `name`, once one is registered; null when none is within the wait or the call is aborted. */
  const handlerFor = (name: string, signal: AbortSignal): Promise<ToolHandler | null> => {
    const now = handlers.get(name)
    if (now !== undefined) return Promise.resolve(now)
    return new Promise((resolve) => {
      const waiters = awaitingHandler.get(name) ?? new Set<() => void>()
      const done = (): void => {
        win.clearTimeout(timer)
        signal.removeEventListener('abort', done)
        waiters.delete(done)
        if (waiters.size === 0) awaitingHandler.delete(name)
        resolve(signal.aborted ? null : (handlers.get(name) ?? null))
      }
      const timer = win.setTimeout(done, TOOL_HANDLER_WAIT_MS)
      signal.addEventListener('abort', done, { once: true })
      waiters.add(done)
      awaitingHandler.set(name, waiters)
    })
  }

  const answerTool = async (message: Extract<HelmMessage, { t: 'tool' }>): Promise<void> => {
    const controller = new AbortController()
    answering.set(message.id, controller)
    let answer: FrameMessage
    try {
      const handler = await handlerFor(message.name, controller.signal)
      if (controller.signal.aborted) return
      if (handler === null) {
        throw new Error(
          `The plugin's background page has no handler for ${message.name}. It registers one with helm.tools.handle('${message.name}', ...) as it starts.`
        )
      }
      const value: unknown = await handler(message.args, { session: message.session, signal: controller.signal })
      answer = { t: 'tool-result', id: message.id, ok: true, text: toolText(value) }
    } catch (error) {
      answer = { t: 'tool-result', id: message.id, ok: false, message: messageOf(error) }
    } finally {
      answering.delete(message.id)
    }
    // Nobody is waiting for it: the call was cancelled while the handler ran.
    if (!controller.signal.aborted) post(answer)
  }

  const receive = (message: HelmMessage): void => {
    if (message.t === 'result') {
      const waiting = pending.get(message.id)
      if (waiting === undefined) return
      pending.delete(message.id)
      if (message.ok) waiting.resolve(message.value)
      else waiting.reject(message.code === 'aborted' ? abortError(message.message) : helmError(message.code, message.message))
      return
    }
    if (message.t === 'tool') {
      void answerTool(message)
      return
    }
    if (message.t === 'tool-cancel') {
      answering.get(message.id)?.abort()
      return
    }
    switch (message.name) {
      case 'channel':
        deliverChannel?.(message.data)
        return
      case 'theme':
        theme = message.data as HelmTheme
        applyTheme(doc, theme)
        emit('theme', theme)
        return
      case 'visibility':
        if (visible === message.data) return
        visible = message.data as boolean
        emit('visibility', visible)
        return
      case 'settings':
      case 'secrets':
      case 'command':
      case 'action':
      case 'sessions':
        emit(message.name, message.data as never)
        return
      default:
        return
    }
  }

  /*
   * A page drawn from the local host's files has its `BroadcastChannel`s
   * relayed through the host, so a message reaches the plugin's pages on
   * every client and its background page. Every other page keeps the
   * browser's own.
   */
  const deliverChannel =
    boot.channels === 'host'
      ? installChannelRelay(win, (name, message, token) => {
          // Nothing to answer: a post that could not be sent is lost, as one
          // to a page that has gone is.
          call<null>(CHANNEL_POST, [name, message, token]).catch(() => undefined)
        })
      : null

  win.addEventListener('message', (event: MessageEvent) => {
    // Only the frame's own parent hands out the port, and only once: a second
    // CONNECT is a page Helm reloaded underneath, which starts a new bridge.
    if (port !== null || event.source !== win.parent || event.ports.length === 0) return
    const data = event.data as Partial<ConnectMessage> | null
    if (data?.type !== CONNECT) return
    const given = event.ports[0]!
    port = given
    given.onmessage = (portEvent: MessageEvent) => receive(portEvent.data as HelmMessage)
    given.start()
    if (data.context !== undefined) context = data.context
    mac = data.mac === true
    if (data.theme !== undefined && data.theme !== null) {
      theme = data.theme
      applyTheme(doc, theme)
    }
    const wasVisible = visible
    visible = data.visible === true
    for (const message of queue.splice(0)) given.postMessage(message)
    if (visible !== wasVisible) emit('visibility', visible)
  })

  // A Helm shortcut pressed while the page has focus would otherwise never
  // reach Helm: keys go to the focused frame's own process. Forwarded after the
  // page's own handlers have run, and only if none of them took it.
  if (context.surface !== 'background') {
    win.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.altKey || event.metaKey) || MODIFIER_KEYS.has(event.key)) return
      // AltGr arrives as Ctrl+Alt and is how many keyboards type @, { and \.
      if (event.getModifierState('AltGraph') || (event.ctrlKey && event.altKey && event.key.length === 1)) return
      const editing = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey
      if (editing && !event.altKey && EDITING_KEYS.has(event.key.toLowerCase())) return
      // On macOS Option types characters (Option+E is an accent), and text is the page's.
      if (mac && event.altKey && !event.ctrlKey && !event.metaKey && event.key.length === 1) return
      win.setTimeout(() => {
        if (event.defaultPrevented) return
        const key: KeyInit = {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat
        }
        post({ t: 'key', key })
      })
    })
  }

  const bridge: HelmBridge = {
    apiVersion: 1,
    get context() {
      return context
    },
    get theme() {
      return theme
    },
    get visible() {
      return visible
    },

    async fetch(input, init) {
      const request = new Request(input, init)
      const body =
        request.method === 'GET' || request.method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer())
      const sent: PluginFetchRequest = {
        url: request.url,
        method: request.method,
        headers: [...request.headers.entries()],
        body: body !== null && body.byteLength === 0 && init?.body == null ? null : body,
        redirect: request.redirect
      }
      const answer = await call<PluginFetchResponse>('fetch', [sent], init?.signal ?? request.signal)
      return toResponse(answer)
    },

    exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult> {
      return call<ExecResult>('exec', [command, args === undefined ? [] : [...args], options ?? {}])
    },

    open(url: string): Promise<void> {
      // Said here, where the mistake is made: Helm refuses it too.
      if (navigator.userActivation?.isActive !== true) {
        return Promise.reject(
          helmError('not-allowed', 'helm.open needs a click or key press the user just made in the page: call it from the handler')
        )
      }
      return call<void>('open', [url])
    },

    tabs: {
      open(tab: string, params?: PluginParams, options?: { title?: string; preview?: boolean }): Promise<void> {
        return call<void>('tabs.open', [tab, params ?? {}, options ?? {}])
      }
    },

    surface: {
      setTitle(title: string | null): void {
        post({ t: 'title', title: typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 120) : null })
      },
      keep(): void {
        post({ t: 'keep' })
      }
    },

    status: {
      set: (item: StatusItem | null) => call<void>('status.set', [item])
    },

    badge: {
      set: (count: number | null) => call<void>('badge.set', [count])
    },

    settings: {
      get: () => call<Record<string, SettingValue>>('settings.get', [])
    },

    secrets: {
      state: (key: string) => call<SecretState>('secrets.state', [key]),
      request: (key: string) => call<SecretState>('secrets.request', [key])
    },

    sessions: {
      start(request: SessionStartRequest): Promise<SessionStartResult> {
        // Said here, where the mistake is made: a call from anything but the
        // user's own click or key press in this page is refused by Helm too.
        if (navigator.userActivation?.isActive !== true) {
          return Promise.reject(
            helmError('not-allowed', 'helm.sessions.start needs a click or key press the user just made in the page: call it from the handler')
          )
        }
        return call<SessionStartResult>('sessions.start', [request])
      },
      list: () => call<PluginSession[]>('sessions.list', [])
    },

    tools: {
      handle(name: string, handler: ToolHandler): () => void {
        // Said where the mistake is made, rather than as a call that never
        // arrives: only the background page is running whenever a session
        // might call, so only it is ever handed one.
        if (context.surface !== 'background') {
          throw helmError('invalid', 'helm.tools.handle works in the background page only')
        }
        if (typeof name !== 'string' || name === '') throw helmError('invalid', 'helm.tools.handle needs the name of a tool')
        if (typeof handler !== 'function') throw helmError('invalid', 'helm.tools.handle needs a function to answer the tool')
        handlers.set(name, handler)
        for (const wake of [...(awaitingHandler.get(name) ?? [])]) wake()
        return () => {
          if (handlers.get(name) === handler) handlers.delete(name)
        }
      }
    },

    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener as (data: never) => void)
      listeners.set(event, set)
      return () => {
        set.delete(listener as (data: never) => void)
      }
    }
  }

  Object.defineProperty(win, 'helm', { value: Object.freeze(bridge), enumerable: true, configurable: false, writable: false })
  if (win.parent !== win) win.parent.postMessage({ type: HELLO }, '*')
  return bridge
}

/** A `Response` the page can use like any other, `url` and `redirected` included. */
function toResponse(answer: PluginFetchResponse): Response {
  const headers = new Headers()
  for (const [name, value] of answer.headers) {
    try {
      headers.append(name, value)
    } catch {
      // A header the platform will not hold in a Response; the page would not have seen it from fetch either.
    }
  }
  const response = new Response(NULL_BODY.has(answer.status) ? null : (answer.body as Uint8Array<ArrayBuffer>), {
    status: answer.status,
    statusText: answer.statusText,
    headers
  })
  Object.defineProperty(response, 'url', { value: answer.url })
  Object.defineProperty(response, 'redirected', { value: answer.redirected })
  return response
}

/**
 * A handler's answer as the text a session reads: a string as it is, nothing
 * as `Done.` - a model given an empty answer cannot tell it from a failure -
 * and anything else as JSON.
 */
function toolText(value: unknown): string {
  let text: string | undefined
  if (typeof value === 'string') text = value
  else if (value === undefined) text = 'Done.'
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch (error) {
      throw new Error(`The tool's answer could not be written as JSON: ${messageOf(error)}`, { cause: error })
    }
    if (text === undefined) throw new Error(`The tool answered with a ${typeof value}, which is not text or JSON.`)
  }
  if (text.length > TOOL_ANSWER_MAX_CHARS) {
    throw new Error(
      `The tool's answer is ${String(text.length)} characters, and a tool may answer with ${String(TOOL_ANSWER_MAX_CHARS)} at most.`
    )
  }
  return text
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function helmError(code: HelmErrorCode, message: string): HelmError {
  const error = new Error(message) as HelmError
  error.name = 'HelmError'
  error.code = code
  return error
}

function abortError(message = 'The operation was aborted.'): DOMException {
  return new DOMException(message, 'AbortError')
}

/** What the page's script tag carries: its first theme, and whether its channels are relayed through the local host. */
interface Boot {
  theme: HelmTheme | null
  channels: 'host' | null
}

function readBoot(text: string | null): Boot {
  if (text === null) return { theme: null, channels: null }
  try {
    const boot = JSON.parse(text) as { theme?: HelmTheme; channels?: unknown }
    return { theme: boot.theme ?? null, channels: boot.channels === 'host' ? 'host' : null }
  } catch {
    return { theme: null, channels: null }
  }
}

/** The bridge's own method a channel post goes through; not part of `window.helm`. */
export const CHANNEL_POST = 'channel.post'

/**
 * `BroadcastChannel`, relayed: a post goes to the local host, which hands it to
 * every page of the plugin on every client, this one included, and the
 * channel object that posted it is skipped by its token. A message is limited
 * to what the protocol carries - null, booleans, numbers, strings, bytes,
 * arrays and plain objects - and anything else throws a `DataCloneError`, as
 * structured clone does, with nothing sent.
 *
 * Returns what hands a delivered message to the page's open channels.
 */
function installChannelRelay(win: Window, send: (name: string, message: unknown, token: string) => void): (data: unknown) => void {
  const realm = win as unknown as typeof globalThis
  const open = new Map<string, Set<RelayedChannel>>()
  const deliver = Symbol('deliver')

  class RelayedChannel extends realm.EventTarget {
    readonly #name: string
    readonly #token = realm.crypto.randomUUID()
    #closed = false
    #onmessage: ((event: MessageEvent) => unknown) | null = null
    #onmessageerror: ((event: MessageEvent) => unknown) | null = null

    constructor(...args: unknown[]) {
      super()
      if (args.length === 0) throw new realm.TypeError('BroadcastChannel needs a name')
      this.#name = String(args[0])
      const set = open.get(this.#name) ?? new Set<RelayedChannel>()
      set.add(this)
      open.set(this.#name, set)
      this.addEventListener('message', (event) => this.#onmessage?.call(this, event as MessageEvent))
      this.addEventListener('messageerror', (event) => this.#onmessageerror?.call(this, event as MessageEvent))
    }

    get name(): string {
      return this.#name
    }

    get onmessage(): ((event: MessageEvent) => unknown) | null {
      return this.#onmessage
    }
    set onmessage(handler: unknown) {
      this.#onmessage = typeof handler === 'function' ? (handler as (event: MessageEvent) => unknown) : null
    }

    get onmessageerror(): ((event: MessageEvent) => unknown) | null {
      return this.#onmessageerror
    }
    set onmessageerror(handler: unknown) {
      this.#onmessageerror = typeof handler === 'function' ? (handler as (event: MessageEvent) => unknown) : null
    }

    postMessage(...args: unknown[]): void {
      if (args.length === 0) throw new realm.TypeError('postMessage needs a message')
      if (this.#closed) throw new realm.DOMException('The BroadcastChannel is closed', 'InvalidStateError')
      send(this.#name, toWire(realm, args[0], new Set()), this.#token)
    }

    close(): void {
      if (this.#closed) return
      this.#closed = true
      const set = open.get(this.#name)
      set?.delete(this)
      if (set?.size === 0) open.delete(this.#name)
    }

    [deliver](message: unknown, token: string): void {
      if (this.#closed || token === this.#token) return
      let data: unknown
      try {
        // A copy of its own for each channel, as structured clone gives every listener.
        data = toWire(realm, message, new Set())
      } catch {
        this.dispatchEvent(new realm.MessageEvent('messageerror'))
        return
      }
      this.dispatchEvent(new realm.MessageEvent('message', { data }))
    }
  }

  Object.defineProperty(realm, 'BroadcastChannel', { value: RelayedChannel, configurable: true, writable: true, enumerable: false })

  return (data) => {
    if (data === null || typeof data !== 'object') return
    const { name, message, token } = data as Record<string, unknown>
    if (typeof name !== 'string' || typeof token !== 'string') return
    for (const channel of [...(open.get(name) ?? [])]) channel[deliver](message, token)
  }
}

/**
 * `value` as the protocol carries it: null, booleans, numbers, strings, bytes,
 * arrays and plain objects. undefined is sent as null, and an object's
 * undefined members are left out; anything else is a `DataCloneError`.
 */
function toWire(realm: typeof globalThis, value: unknown, path: Set<object>): unknown {
  const cannot = (what: string): DOMException =>
    new realm.DOMException(`${what} cannot be sent: a message is limited to what the protocol carries`, 'DataCloneError')
  switch (typeof value) {
    case 'undefined':
      return null
    case 'boolean':
    case 'number':
    case 'string':
      return value
    case 'bigint':
      throw cannot('A BigInt')
    case 'symbol':
      throw cannot('A symbol')
    case 'function':
      throw cannot('A function')
  }
  if (value === null) return null
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array((value as ArrayBuffer).slice(0))
  const object = value as object
  if (path.has(object)) throw cannot('A cyclic object')
  path.add(object)
  try {
    if (Array.isArray(object)) return object.map((item: unknown) => toWire(realm, item, path))
    const prototype: unknown = Object.getPrototypeOf(object)
    // A plain object from this page's realm or any other: its prototype is an Object.prototype, or none.
    const plain = prototype === null || Object.getPrototypeOf(prototype) === null
    if (!plain) {
      const named = (object as { constructor?: { name?: unknown } }).constructor?.name
      throw cannot(`A ${typeof named === 'string' && named !== '' ? named : 'non-plain'} object`)
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(object)) {
      const item = (object as Record<string, unknown>)[key]
      if (item !== undefined) out[key] = toWire(realm, item, path)
    }
    return out
  } finally {
    path.delete(object)
  }
}

function readContext(win: Window): HelmContext {
  const name = win.name
  if (name.startsWith(CONTEXT_PREFIX)) {
    try {
      return JSON.parse(name.slice(CONTEXT_PREFIX.length)) as HelmContext
    } catch {
      // Overwritten by the page; Helm's CONNECT says it again.
    }
  }
  return { plugin: win.location.hostname, surface: 'tab', name: '', params: {} }
}

/** Only for a page loaded without its boot attribute, which Helm never serves. */
function fallbackTheme(): HelmTheme {
  return {
    kind: 'dark',
    tokens: {} as HelmTheme['tokens'],
    radius: 3,
    density: 'comfortable'
  }
}

/** The theme onto the page: tokens as `--helm-*`, shape, and the kind for `dark:` styles and form controls. */
export function applyTheme(doc: Document, theme: HelmTheme): void {
  const root = doc.documentElement
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(`--helm-${token}`, value)
  root.style.setProperty('--helm-radius', `${String(theme.radius)}px`)
  root.style.colorScheme = theme.kind
  root.dataset['density'] = theme.density
  root.dataset['theme'] = theme.kind
  root.classList.toggle('dark', theme.kind === 'dark')
}
