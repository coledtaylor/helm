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
  SecretState,
  SettingValue,
  StatusItem
} from '@helm/plugin-sdk'
import type { PluginFetchRequest, PluginFetchResponse } from '../../shared/ipc'
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

/** Keys that are the page's own business - its clipboard, its undo - even with Ctrl down. */
const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z'])
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS'])

/** Responses that may not have a body, which `new Response` refuses one for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

export function installBridge(win: Window, bootText: string | null): HelmBridge {
  const doc = win.document
  let theme = readBoot(bootText) ?? fallbackTheme()
  let context = readContext(win)
  let visible = false
  applyTheme(doc, theme)

  let port: MessagePort | null = null
  const queue: FrameMessage[] = []
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  const listeners = new Map<string, Set<(data: never) => void>>()

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

  const receive = (message: HelmMessage): void => {
    if (message.t === 'result') {
      const waiting = pending.get(message.id)
      if (waiting === undefined) return
      pending.delete(message.id)
      if (message.ok) waiting.resolve(message.value)
      else waiting.reject(message.code === 'aborted' ? abortError(message.message) : helmError(message.code, message.message))
      return
    }
    switch (message.name) {
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
        emit(message.name, message.data as never)
        return
      default:
        return
    }
  }

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
      if (event.ctrlKey && !event.altKey && EDITING_KEYS.has(event.key.toLowerCase())) return
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

    tabs: {
      open(tab: string, params?: PluginParams, options?: { title?: string }): Promise<void> {
        return call<void>('tabs.open', [tab, params ?? {}, options ?? {}])
      }
    },

    surface: {
      setTitle(title: string | null): void {
        post({ t: 'title', title: typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 120) : null })
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

function helmError(code: HelmErrorCode, message: string): HelmError {
  const error = new Error(message) as HelmError
  error.name = 'HelmError'
  error.code = code
  return error
}

function abortError(message = 'The operation was aborted.'): DOMException {
  return new DOMException(message, 'AbortError')
}

function readBoot(text: string | null): HelmTheme | null {
  if (text === null) return null
  try {
    const boot = JSON.parse(text) as { theme?: HelmTheme }
    return boot.theme ?? null
  } catch {
    return null
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
