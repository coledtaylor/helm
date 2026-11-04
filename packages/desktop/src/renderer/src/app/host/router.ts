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
 * A channel `boundary.rs` lists as client-only stays on the preload's bridge
 * (the browser pane, clipboard, window, theme, dialogs), and so does a
 * host-internal one (a plugin's background page and what runs it). Every
 * channel a host adapter takes goes to the host over this page's own
 * connection, in the protocol's types. Any other channel is refused at once:
 * main has no handler for it, and a host feature is never asked of main.
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
  adapters: readonly HostAdapter[]
  /** Whether `boundary.rs` lists a channel as client-only. */
  clientOnly: (channel: string) => boolean
  /** Whether `boundary.rs` lists a channel as host-internal: between a background page and what runs it. */
  hostInternal: (channel: string) => boolean
  /** Told of a refused send or listener, which has nowhere to fail. */
  log?: (line: string) => void
}

/** The sentence a refused call rejects with. */
export const refusedSentence = (channel: string): string => `${channel} is not one of this page's channels.`

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

/** The channels that reach the host: not client-only, and an adapter takes them. */
export function routedChannels(adapters: readonly HostAdapter[], clientOnly: (channel: string) => boolean): Set<string> {
  const routes = merge(adapters, clientOnly)
  return new Set([...routes.requests.keys(), ...routes.sends.keys(), ...routes.events.keys()])
}

export function createRouter({ own, adapters, clientOnly, hostInternal, log }: RouterDeps): HelmBridge {
  const routes = merge(adapters, clientOnly)
  /** A channel that stays on the preload's bridge. */
  const ownAlways = (channel: string): boolean => clientOnly(channel) || hostInternal(channel)
  const refuse = (channel: string, what: string): void =>
    (log ?? console.warn)(`${what} ${refusedSentence(channel)}`)
  const ownInvoke = own.invoke as (channel: string, payload?: unknown) => Promise<unknown>
  const ownSend = own.send as (channel: string, payload?: unknown) => void
  const ownOn = own.on as (channel: string, listener: (payload: unknown) => void) => () => void

  const invoke = (channel: string, payload?: unknown): Promise<unknown> => {
    if (ownAlways(channel)) return ownInvoke(channel, payload)
    const route = routes.requests.get(channel)
    return route === undefined ? Promise.reject(new Error(refusedSentence(channel))) : route(payload)
  }

  const send = (channel: string, payload?: unknown): void => {
    if (ownAlways(channel)) return ownSend(channel, payload)
    const route = routes.sends.get(channel)
    if (route === undefined) return refuse(channel, 'A send was dropped:')
    route(payload)
  }

  const on = (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (ownAlways(channel)) return ownOn(channel, listener)
    const route = routes.events.get(channel)
    if (route !== undefined) return route(listener)
    refuse(channel, 'A listener hears nothing:')
    return () => undefined
  }

  return {
    invoke: invoke as HelmBridge['invoke'],
    send: send as HelmBridge['send'],
    on: on as HelmBridge['on']
  }
}
