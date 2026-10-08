import type { HelmContext, HelmTheme, PluginParams, SurfaceKind } from '@coledtaylor/helm-plugin-sdk'
import { pluginThemeOf } from '@helm/core/types'
import {
  PLUGIN_SCHEME,
  type HelmBridge as Ipc,
  type PluginCallOutcome,
  type PluginDelivery,
  type PluginFetchResponse,
  type PluginToolCall,
  type PluginToolOutcome
} from '../../../shared/ipc'
import {
  CONNECT,
  HELLO,
  contextName,
  type ConnectMessage,
  type HelmMessage,
  type KeyInit
} from '../../plugin-runtime/wire'

/**
 * The Helm side of every plugin frame: the half of `wire.ts` that answers.
 *
 * Both Helm pages that frame plugins run one - the window, for panels and
 * tabs, and the hidden background host, for background pages - and neither
 * page's own code talks to a plugin any other way. A relay makes the frame,
 * answers its `HELLO` with a port of its own, carries its bridge calls to main
 * and the answers back, and hands it Helm's events: the theme, its visibility,
 * and what main delivers for its plugin.
 *
 * What it trusts is decided here, once. A frame is known by its element, not
 * by anything it says: the `HELLO` must come from the window of an iframe this
 * relay made, on that iframe's plugin's origin, and every call it then makes is
 * sent to main under the plugin and surface the relay gave it. A page cannot
 * name another plugin, or another surface, because it is never asked.
 *
 * It also decides when a frame has failed, because a plugin page that died
 * says nothing: a load with no `HELLO` (the page is missing, or is not a page
 * Helm served), and a port that closed with no new `HELLO` behind it (the
 * page's process ended). Either is a state the surface draws, with Reload.
 */

/** A frame that loaded without saying `HELLO` within this long never will. */
export const LOAD_GRACE_MS = 1500
/** A navigation closes the port too; a page that is coming back says so within this long. */
export const CRASH_GRACE_MS = 2000
/** Events kept for a frame with no port yet: enough for a burst, not a backlog. */
const QUEUE_MAX = 64
const METHOD_MAX = 64
const TITLE_MAX = 120
/**
 * Calls that put Helm's own dialog in front of the user, so only the user can
 * cause one: each is let through only while this page has transient
 * activation. A click or key press in a plugin's frame activates the page
 * framing it too (Chromium's user activation v2), so this is a check the page
 * cannot answer for itself - its own bridge checks its own frame as well.
 */
const NEEDS_ACTIVATION: ReadonlySet<string> = new Set(['sessions.start'])

export interface SurfaceSpec {
  /** One frame per key, for as long as its surface is open. */
  key: string
  plugin: string
  /** The plugin's revision this page belongs to. A newer one reloads it. */
  revision: number
  url: string
  surface: SurfaceKind
  /** The panel's or tab's key in the manifest; `background` for the background page. */
  name: string
  params: PluginParams
  /** The frame's accessible name. */
  title: string
}

export type FrameState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: 'load' | 'crash'; message: string }

export interface RelayHooks {
  /** A Helm shortcut pressed inside the page, which the page did not take. */
  key?: (spec: SurfaceSpec, element: HTMLIFrameElement, key: KeyInit) => void
  /** The page named its surface, or gave the name back (null). */
  title?: (spec: SurfaceSpec, title: string | null) => void
}

export interface PluginRelay {
  /** The frame for `spec.key`, made the first time. A spec from a newer revision reloads it. */
  open(spec: SurfaceSpec): HTMLIFrameElement
  state(key: string): FrameState | null
  reload(key: string): void
  /** The surface is gone: the page ends here. */
  dispose(key: string): void
  disposeWhere(predicate: (spec: SurfaceSpec) => boolean): void
  specs(): SurfaceSpec[]
  setVisible(key: string, visible: boolean): void
  /** An event for one frame, held until it is connected. */
  emit(key: string, name: 'command' | 'action', data: unknown): void
  setHooks(hooks: RelayHooks): void
  /** Called whenever a frame's state changes. */
  subscribe(listener: () => void): () => void
  /** Removes every frame and listener: a test's teardown, or the host page going away. */
  destroy(): void
}

interface Frame {
  spec: SurfaceSpec
  element: HTMLIFrameElement
  state: FrameState
  /** Names this frame in call ids; never reused within a page. */
  serial: number
  port: MessagePort | null
  /** Bumped at each `HELLO`, so an answer for a page that has since reloaded is dropped. */
  connection: number
  hellos: number
  hellosAtLoad: number
  /** In-flight calls of the current connection: the page's id to the call id main knows. */
  calls: Map<number, string>
  /** Tool calls handed to the page and not answered yet. Each is answered for, whatever becomes of the page. */
  tools: Set<string>
  queue: HelmMessage[]
  visible: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export function createPluginRelay(options: { win: Window; ipc: Ipc; hooks?: RelayHooks }): PluginRelay {
  const { win, ipc } = options
  let hooks: RelayHooks = options.hooks ?? {}
  const frames = new Map<string, Frame>()
  const listeners = new Set<() => void>()
  let serials = 0
  let theme: HelmTheme | null = null
  let destroyed = false

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const setState = (frame: Frame, state: FrameState): void => {
    frame.state = state
    notify()
  }

  const clearTimer = (frame: Frame): void => {
    if (frame.timer !== null) clearTimeout(frame.timer)
    frame.timer = null
  }

  const toolResult = (outcome: PluginToolOutcome): void => {
    ipc.send('plugins:toolResult', outcome)
  }

  /** Every tool call the page was handed and will now never answer, failed for the session waiting on it. */
  const failTools = (frame: Frame): void => {
    for (const id of frame.tools) {
      toolResult({ id, ok: false, message: "The plugin's background page stopped before it answered." })
    }
    frame.tools.clear()
  }

  /** Ends the current connection: its calls are cancelled in main and its port closed. */
  const disconnect = (frame: Frame): void => {
    for (const callId of frame.calls.values()) ipc.send('plugins:cancel', { callId })
    frame.calls.clear()
    failTools(frame)
    if (frame.port !== null) {
      frame.port.onmessage = null
      frame.port.close()
      frame.port = null
    }
  }

  const post = (frame: Frame, message: HelmMessage, transfer: Transferable[] = []): void => {
    if (frame.port !== null) {
      frame.port.postMessage(message, transfer)
      return
    }
    if (message.t !== 'event') return
    frame.queue.push(message)
    if (frame.queue.length > QUEUE_MAX) frame.queue.splice(0, frame.queue.length - QUEUE_MAX)
  }

  const contextOf = (spec: SurfaceSpec): HelmContext => ({
    plugin: spec.plugin,
    surface: spec.surface,
    name: spec.name,
    params: spec.params
  })

  // ---------------------------------------------------------------------------
  // The handshake
  // ---------------------------------------------------------------------------

  const onWindowMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown } | null
    if (data === null || typeof data !== 'object' || data.type !== HELLO) return
    const prefix = `${PLUGIN_SCHEME}://`
    if (!event.origin.startsWith(prefix)) return
    const id = event.origin.slice(prefix.length)
    let frame: Frame | undefined
    for (const candidate of frames.values()) {
      if (candidate.spec.plugin === id && candidate.element.contentWindow === event.source) frame = candidate
    }
    if (frame === undefined || event.source === null) return
    connect(frame, event.source as Window, event.origin)
  }

  const connect = (frame: Frame, source: Window, origin: string): void => {
    disconnect(frame)
    clearTimer(frame)
    frame.hellos += 1
    const connection = ++frame.connection
    const channel = new MessageChannel()
    const port = channel.port1
    frame.port = port
    port.onmessage = (event: MessageEvent) => receive(frame, connection, event.data)
    // The page's end of the port went away: it navigated, or its process
    // ended. A navigation says HELLO again; silence is a crash.
    port.addEventListener('close', () => {
      if (frame.port !== port || frames.get(frame.spec.key) !== frame || frame.connection !== connection) return
      frame.port = null
      for (const callId of frame.calls.values()) ipc.send('plugins:cancel', { callId })
      frame.calls.clear()
      failTools(frame)
      clearTimer(frame)
      frame.timer = setTimeout(() => {
        frame.timer = null
        if (frame.connection !== connection || frames.get(frame.spec.key) !== frame) return
        setState(frame, { kind: 'failed', reason: 'crash', message: 'The page ended unexpectedly.' })
      }, CRASH_GRACE_MS)
    })
    const message: ConnectMessage = {
      type: CONNECT,
      context: contextOf(frame.spec),
      theme,
      visible: frame.visible
    }
    source.postMessage(message, origin, [channel.port2])
    for (const queued of frame.queue.splice(0)) port.postMessage(queued)
    if (frame.state.kind !== 'ready') setState(frame, { kind: 'ready' })
  }

  const onLoad = (frame: Frame): void => {
    if (frames.get(frame.spec.key) !== frame) return
    // A page Helm served said HELLO from the top of its <head>, which is
    // before this event in any page that has a bridge at all. The grace is
    // for the two arriving in either order.
    const check = (): void => {
      if (frame.hellos > frame.hellosAtLoad) {
        frame.hellosAtLoad = frame.hellos
        return
      }
      setState(frame, {
        kind: 'failed',
        reason: 'load',
        message: 'The page did not load. It may be missing from the plugin folder, or still being built.'
      })
    }
    if (frame.hellos > frame.hellosAtLoad) {
      check()
      return
    }
    clearTimer(frame)
    frame.timer = setTimeout(() => {
      frame.timer = null
      if (frames.get(frame.spec.key) === frame) check()
    }, LOAD_GRACE_MS)
  }

  // ---------------------------------------------------------------------------
  // What a page sends
  // ---------------------------------------------------------------------------

  const receive = (frame: Frame, connection: number, raw: unknown): void => {
    if (frame.connection !== connection || raw === null || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    switch (message['t']) {
      case 'call': {
        const id = message['id']
        const method = message['method']
        const args = message['args']
        if (!isCallId(id) || typeof method !== 'string' || method.length > METHOD_MAX || !Array.isArray(args)) return
        call(frame, connection, id, method, args)
        return
      }
      case 'cancel': {
        const id = message['id']
        if (!isCallId(id)) return
        const callId = frame.calls.get(id)
        if (callId === undefined) return
        frame.calls.delete(id)
        ipc.send('plugins:cancel', { callId })
        return
      }
      case 'key': {
        const key = readKey(message['key'])
        if (key !== null) hooks.key?.(frame.spec, frame.element, key)
        return
      }
      case 'title': {
        const title = message['title']
        if (title === null) hooks.title?.(frame.spec, null)
        else if (typeof title === 'string' && title.trim() !== '') hooks.title?.(frame.spec, title.trim().slice(0, TITLE_MAX))
        return
      }
      case 'tool-result': {
        // Only an answer to a call this frame was handed: a page cannot answer
        // for another page's tools, or answer twice.
        const id = message['id']
        if (typeof id !== 'string' || !frame.tools.delete(id)) return
        const text = message['text']
        const said = message['message']
        if (message['ok'] === true && typeof text === 'string') toolResult({ id, ok: true, text })
        else toolResult({ id, ok: false, message: typeof said === 'string' && said !== '' ? said : 'The tool failed.' })
        return
      }
      default:
        return
    }
  }

  const call = (frame: Frame, connection: number, id: number, method: string, args: unknown[]): void => {
    // Already running under this id: a page reusing one gets nothing for it.
    if (frame.calls.has(id)) return
    if (NEEDS_ACTIVATION.has(method) && win.navigator.userActivation?.isActive !== true) {
      post(frame, {
        t: 'result',
        id,
        ok: false,
        code: 'not-allowed',
        message: `helm.${method} needs a click or key press the user just made in the page`
      })
      return
    }
    const callId = `${String(frame.serial)}.${String(connection)}.${String(id)}`
    frame.calls.set(id, callId)
    const settle = (outcome: PluginCallOutcome): void => {
      if (frame.calls.get(id) !== callId) return
      frame.calls.delete(id)
      if (frame.connection !== connection || frame.port === null) return
      if (outcome.ok) {
        post(frame, { t: 'result', id, ok: true, value: outcome.value }, transferOf(method, outcome.value))
      } else {
        post(frame, { t: 'result', id, ok: false, code: outcome.code, message: outcome.message })
      }
    }
    ipc
      .invoke('plugins:call', {
        plugin: frame.spec.plugin,
        surface: frame.spec.surface,
        method,
        args,
        callId
      })
      .then(settle, (error: unknown) =>
        settle({ ok: false, code: 'unavailable', message: error instanceof Error ? error.message : String(error) })
      )
  }

  // ---------------------------------------------------------------------------
  // What Helm sends
  // ---------------------------------------------------------------------------

  const event = (frame: Frame, name: string, data: unknown): void => {
    post(frame, { t: 'event', name, data })
  }

  const offTheme = ipc.on('plugins:theme', (next) => {
    theme = next
    for (const frame of frames.values()) if (frame.port !== null) event(frame, 'theme', next)
  })

  const offDeliver = ipc.on('plugins:deliver', (delivery: PluginDelivery) => {
    for (const frame of frames.values()) {
      if (frame.spec.plugin !== delivery.plugin) continue
      if (delivery.to === 'background' && frame.spec.surface !== 'background') continue
      event(frame, delivery.event, delivery.data)
    }
  })

  // A session's tool call, for the plugin's background page. Main sends these
  // to the background host only, and every one is answered: by the page, or
  // here when there is no page connected to answer it.
  const offTool = ipc.on('plugins:tool', (call: PluginToolCall) => {
    let frame: Frame | undefined
    for (const candidate of frames.values()) {
      if (candidate.spec.plugin === call.plugin && candidate.spec.surface === 'background') frame = candidate
    }
    if (frame === undefined || frame.port === null) {
      toolResult({ id: call.id, ok: false, message: "The plugin's background page is not running." })
      return
    }
    frame.tools.add(call.id)
    post(frame, { t: 'tool', id: call.id, name: call.name, args: call.args, session: call.session })
  })

  const offToolCancel = ipc.on('plugins:toolCancel', ({ id }) => {
    for (const frame of frames.values()) {
      if (frame.tools.delete(id)) post(frame, { t: 'tool-cancel', id })
    }
  })

  // The first theme, for frames that connect before anything changes it. An
  // event that beat this read is newer, and stays.
  void Promise.all([ipc.invoke('theme:current'), ipc.invoke('settings:read')]).then(
    ([state, settings]) => {
      theme ??= pluginThemeOf(state.applied, settings)
    },
    () => undefined
  )

  win.addEventListener('message', onWindowMessage)

  // ---------------------------------------------------------------------------

  const make = (spec: SurfaceSpec): Frame => {
    const element = win.document.createElement('iframe')
    // Its own origin keeps it out of Helm's page; the sandbox takes away what
    // an origin alone would still allow: navigating Helm, popups, modal
    // dialogs, downloads. `allow-same-origin` keeps that origin - and its
    // storage - rather than an opaque one, which is safe because it is not
    // Helm's.
    element.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')
    element.setAttribute('allow', 'clipboard-write')
    element.referrerPolicy = 'no-referrer'
    element.name = contextName({ plugin: spec.plugin, surface: spec.surface, name: spec.name, params: spec.params })
    element.title = spec.title
    element.dataset['pluginFrame'] = spec.key
    element.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent'
    const frame: Frame = {
      spec,
      element,
      state: { kind: 'loading' },
      serial: ++serials,
      port: null,
      connection: 0,
      hellos: 0,
      hellosAtLoad: 0,
      calls: new Map(),
      tools: new Set(),
      queue: [],
      visible: false,
      timer: null
    }
    element.addEventListener('load', () => onLoad(frame))
    element.src = spec.url
    return frame
  }

  const restart = (frame: Frame): void => {
    disconnect(frame)
    clearTimer(frame)
    frame.hellosAtLoad = frame.hellos
    frame.element.name = contextName(contextOf(frame.spec))
    setState(frame, { kind: 'loading' })
    // Assigning `src` navigates even when it is the same URL: this is a reload,
    // and one that works on a frame whose process has gone.
    frame.element.src = frame.spec.url
  }

  const drop = (frame: Frame): void => {
    frames.delete(frame.spec.key)
    clearTimer(frame)
    disconnect(frame)
    frame.queue = []
    frame.element.remove()
  }

  return {
    open(spec) {
      const existing = frames.get(spec.key)
      if (existing === undefined) {
        const frame = make(spec)
        frames.set(spec.key, frame)
        notify()
        return frame.element
      }
      const previous = existing.spec
      existing.spec = spec
      if (previous.title !== spec.title) existing.element.title = spec.title
      if (previous.revision !== spec.revision || previous.url !== spec.url || previous.plugin !== spec.plugin) {
        restart(existing)
      }
      return existing.element
    },

    state: (key) => frames.get(key)?.state ?? null,

    reload(key) {
      const frame = frames.get(key)
      if (frame !== undefined) restart(frame)
    },

    dispose(key) {
      const frame = frames.get(key)
      if (frame === undefined) return
      drop(frame)
      notify()
    },

    disposeWhere(predicate) {
      let any = false
      for (const frame of [...frames.values()]) {
        if (!predicate(frame.spec)) continue
        drop(frame)
        any = true
      }
      if (any) notify()
    },

    specs: () => [...frames.values()].map((frame) => frame.spec),

    setVisible(key, visible) {
      const frame = frames.get(key)
      if (frame === undefined || frame.visible === visible) return
      frame.visible = visible
      if (frame.port !== null) event(frame, 'visibility', visible)
    },

    emit(key, name, data) {
      const frame = frames.get(key)
      if (frame !== undefined) event(frame, name, data)
    },

    setHooks(next) {
      hooks = next
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      win.removeEventListener('message', onWindowMessage)
      offTheme()
      offDeliver()
      offTool()
      offToolCancel()
      for (const frame of [...frames.values()]) drop(frame)
      listeners.clear()
    }
  }
}

function isCallId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** A fetch's body is handed over rather than copied: it can be 32 MB. */
function transferOf(method: string, value: unknown): Transferable[] {
  if (method !== 'fetch' || value === null || typeof value !== 'object') return []
  const body = (value as Partial<PluginFetchResponse>).body
  return body instanceof Uint8Array && body.buffer instanceof ArrayBuffer ? [body.buffer] : []
}

function readKey(value: unknown): KeyInit | null {
  if (value === null || typeof value !== 'object') return null
  const key = value as Record<string, unknown>
  if (typeof key['key'] !== 'string' || key['key'].length > 32 || typeof key['code'] !== 'string' || key['code'].length > 32) {
    return null
  }
  return {
    key: key['key'],
    code: key['code'],
    ctrlKey: key['ctrlKey'] === true,
    shiftKey: key['shiftKey'] === true,
    altKey: key['altKey'] === true,
    metaKey: key['metaKey'] === true,
    repeat: key['repeat'] === true
  }
}
