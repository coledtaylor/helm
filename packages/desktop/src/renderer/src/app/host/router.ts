import type {
  EventChannel,
  EventPayload,
  HelmBridge,
  RequestChannel,
  RequestPayload,
  RequestResult,
  SendChannel,
  SendPayload
} from '../../../../shared/ipc'

/**
 * Where each of the window's calls goes.
 *
 * With "Run sessions in the local host" off, every call is the preload's
 * bridge, exactly as before. With it on, a channel `boundary.rs` lists as
 * client-only stays on the preload's bridge (the browser pane, clipboard,
 * window, theme, dialogs), and every channel a host adapter takes goes to the
 * host over this page's own connection, in the protocol's types. A
 * host-internal channel (a plugin's background page and what runs it) stays on
 * the preload's bridge too. Any other channel is refused: main has no handler
 * for it with the setting on, and a host feature is never asked of main.
 *
 * Whether the setting is on is main's answer to this page's first
 * `hostLink:open`; the first call to a channel that is not client-only or
 * host-internal waits for it. Those two go to the preload's bridge at once.
 */

export type RequestRoute<K extends RequestChannel> = (payload: RequestPayload<K>) => Promise<RequestResult<K>>
export type SendRoute<K extends SendChannel> = (payload: SendPayload<K>) => void
export type EventRoute<K extends EventChannel> = (listener: (payload: EventPayload<K>) => void) => () => void

/** The channels one area of the window reaches the host for, in ipc.ts's shapes. */
export interface HostAdapter {
  requests?: { [K in RequestChannel]?: RequestRoute<K> }
  sends?: { [K in SendChannel]?: SendRoute<K> }
  events?: { [K in EventChannel]?: EventRoute<K> }
}

export interface RouterDeps {
  /** The preload's bridge. */
  own: HelmBridge
  /** Whether sessions run in the local host this run. */
  inHost: () => Promise<boolean>
  adapters: readonly HostAdapter[]
  /** Whether `boundary.rs` lists a channel as client-only. */
  clientOnly: (channel: string) => boolean
  /** Whether `boundary.rs` lists a channel as host-internal: between a background page and what runs it. */
  hostInternal: (channel: string) => boolean
  /** Told of a send or a listener refused with the setting on, which has nowhere to fail. */
  log?: (line: string) => void
}

/** The sentence a call refused with the setting on rejects with. */
export const refusedSentence = (channel: string): string =>
  `${channel} is not one of this page's channels while sessions run in the local host.`

/** Every channel the adapters take, by kind. */
interface Routes {
  requests: Map<string, (payload: unknown) => Promise<unknown>>
  sends: Map<string, (payload: unknown) => void>
  events: Map<string, (listener: (payload: unknown) => void) => () => void>
}

function merge(adapters: readonly HostAdapter[], clientOnly: (channel: string) => boolean): Routes {
  const routes: Routes = { requests: new Map(), sends: new Map(), events: new Map() }
  const add = <T>(into: Map<string, T>, from: Record<string, T | undefined> | undefined): void => {
    for (const [channel, route] of Object.entries(from ?? {})) {
      if (route === undefined) continue
      if (clientOnly(channel)) throw new Error(`${channel} is client-only; no host adapter may take it.`)
      if (into.has(channel)) throw new Error(`Two host adapters take ${channel}.`)
      into.set(channel, route)
    }
  }
  for (const adapter of adapters) {
    add(routes.requests, adapter.requests as Record<string, (payload: unknown) => Promise<unknown>> | undefined)
    add(routes.sends, adapter.sends as Record<string, (payload: unknown) => void> | undefined)
    add(
      routes.events,
      adapter.events as Record<string, (listener: (payload: unknown) => void) => () => void> | undefined
    )
  }
  return routes
}

/** Whether a channel reaches the host with the setting on: it is not client-only and an adapter takes it. */
export function routedChannels(adapters: readonly HostAdapter[], clientOnly: (channel: string) => boolean): Set<string> {
  const routes = merge(adapters, clientOnly)
  return new Set([...routes.requests.keys(), ...routes.sends.keys(), ...routes.events.keys()])
}

export function createRouter({ own, inHost, adapters, clientOnly, hostInternal, log }: RouterDeps): HelmBridge {
  const routes = merge(adapters, clientOnly)
  /** A channel that goes to the preload's bridge whether the setting is on or off. */
  const ownAlways = (channel: string): boolean => clientOnly(channel) || hostInternal(channel)
  const refuse = (channel: string, what: string): void =>
    (log ?? console.warn)(`${what} ${refusedSentence(channel)}`)
  /** Null until main has answered whether sessions run in the host. */
  let known: boolean | null = null
  let asking: Promise<boolean> | null = null
  const placement = (): Promise<boolean> => {
    asking ??= inHost().then(
      (on) => (known = on),
      () => (known = false)
    )
    return asking
  }
  const ownInvoke = own.invoke as (channel: string, payload?: unknown) => Promise<unknown>
  const ownSend = own.send as (channel: string, payload?: unknown) => void
  const ownOn = own.on as (channel: string, listener: (payload: unknown) => void) => () => void

  /** Sends held while the placement is asked, so their order is kept. */
  let held: Promise<unknown> = Promise.resolve()

  const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
    if (ownAlways(channel)) return ownInvoke(channel, payload)
    const route = routes.requests.get(channel)
    const go = (on: boolean): Promise<unknown> => {
      if (!on) return ownInvoke(channel, payload)
      return route === undefined ? Promise.reject(new Error(refusedSentence(channel))) : route(payload)
    }
    if (known !== null) return go(known)
    return placement().then(go)
  }

  const send = (channel: string, payload?: unknown): void => {
    if (ownAlways(channel)) return ownSend(channel, payload)
    const route = routes.sends.get(channel)
    const deliver = (): void => {
      if (known !== true) return ownSend(channel, payload)
      if (route === undefined) return refuse(channel, 'A send was dropped:')
      route(payload)
    }
    if (known !== null) return deliver()
    held = Promise.all([held, placement()]).then(deliver)
  }

  const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (ownAlways(channel)) return ownOn(channel, listener)
    const route = routes.events.get(channel)
    const hostRoute = (listener: (payload: unknown) => void): (() => void) => {
      if (route !== undefined) return route(listener)
      refuse(channel, 'A listener hears nothing:')
      return () => undefined
    }
    if (known !== null) return known ? hostRoute(listener) : ownOn(channel, listener)
    // Until main has answered, listen where the setting being off would send
    // it, so nothing is missed then; once it is on, the host's replaces it.
    let off: () => void = ownOn(channel, listener)
    let done = false
    void placement().then((on) => {
      if (done || !on) return
      off()
      off = hostRoute(listener)
    })
    return () => {
      done = true
      off()
    }
  }

  return {
    invoke: invoke as HelmBridge['invoke'],
    send: send as HelmBridge['send'],
    on: on as HelmBridge['on']
  }
}
