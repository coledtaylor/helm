import { LOCAL_HOST_KEY } from '@helm/core/types'
import { FLOTI_PLUGIN_SCHEME, PLUGIN_SCHEME, PLUGIN_SCHEMES, type PluginScheme } from '../ipc'

/**
 * Where a plugin's pages live: one origin per host and plugin.
 *
 * This PC's plugins keep `helm-plugin://<id>/`, the origin they have always
 * had, so what they stored stays theirs. A plugin on a host on another
 * computer is served on `helm-plugin://<id>.<label>/`, the label a DNS-safe
 * one derived from that host's id. A plugin id holds no dot (the manifest's
 * rule), so the two never meet, and the same plugin on two hosts has two
 * origins: the browser keeps their storage, cookies and frames apart, and a
 * page's `postMessage` names which host's plugin sent it.
 *
 * A version 2 plugin's pages are laid out the same way on `floti-plugin://`.
 * The scheme is part of the origin, and it says which bridge a page has:
 * `window.helm` on `helm-plugin`, `window.floti` on `floti-plugin`.
 *
 * Nothing here reaches Node or the DOM: main, the window and the hidden
 * plugin window all read origins with it.
 */

/**
 * A plugin on a host: `host` is `LOCAL_HOST_KEY` for this PC, or a remote
 * host's id. `scheme` is its pages' scheme, `helm-plugin` when not given.
 */
export interface PluginOnHost {
  host: string
  plugin: string
  scheme?: PluginScheme
}

/**
 * An origin taken apart: its scheme, the plugin, and the label of the host it
 * is on, or null for this PC.
 */
export interface ParsedPluginOrigin {
  scheme: PluginScheme
  plugin: string
  label: string | null
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A 64-bit FNV-1a of `text`, as 16 hex digits: stable everywhere, with no crypto to load. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * The label a remote host's plugins are served under. A host id that is a
 * DNS label already (the ids Helm mints are lower-case UUIDs) is its own
 * label; any other is `h` and a hash of it, which only ever holds what a
 * DNS label may. A label never names this PC.
 */
export function hostLabel(host: string): string {
  if (host === LOCAL_HOST_KEY) throw new Error('This PC’s plugins have no host label.')
  return DNS_LABEL.test(host) ? host : `h${fnv1a64(host)}`
}

/** The plugin API version a page on `scheme` is served for: 2 on `floti-plugin`, 1 on `helm-plugin`. */
export function apiVersionOfScheme(scheme: PluginScheme): 1 | 2 {
  return scheme === FLOTI_PLUGIN_SCHEME ? 2 : 1
}

/**
 * `<scheme>://<id>` for this PC, `<scheme>://<id>.<label>` for a remote host,
 * on `helm-plugin` unless `scheme` names the other.
 */
export function pluginOrigin({ host, plugin, scheme = PLUGIN_SCHEME }: PluginOnHost): string {
  return host === LOCAL_HOST_KEY ? `${scheme}://${plugin}` : `${scheme}://${plugin}.${hostLabel(host)}`
}

/** The plugin scheme an origin or URL is on, or null when it is on neither. */
export function pluginSchemeOf(originOrUrl: string | null | undefined): PluginScheme | null {
  if (typeof originOrUrl !== 'string') return null
  const lower = originOrUrl.toLowerCase()
  return PLUGIN_SCHEMES.find((scheme) => lower.startsWith(`${scheme}://`)) ?? null
}

/**
 * An origin or a URL on either plugin scheme, taken apart; null for anything
 * else. Read from the text, as Node gives a scheme it does not know an opaque
 * origin.
 */
export function parsePluginOrigin(originOrUrl: string | null | undefined): ParsedPluginOrigin | null {
  const scheme = pluginSchemeOf(originOrUrl)
  if (scheme === null || typeof originOrUrl !== 'string') return null
  const rest = originOrUrl.slice(`${scheme}://`.length)
  const end = rest.search(/[/?#]/)
  const authority = (end === -1 ? rest : rest.slice(0, end)).toLowerCase()
  if (authority === '' || /[@:]/.test(authority)) return null
  const dot = authority.indexOf('.')
  if (dot === -1) return { scheme, plugin: authority, label: null }
  const plugin = authority.slice(0, dot)
  const label = authority.slice(dot + 1)
  if (plugin === '' || !DNS_LABEL.test(label)) return null
  return { scheme, plugin, label }
}

/** A parsed origin written back: `<scheme>://<id>` or `<scheme>://<id>.<label>`. */
export function formatPluginOrigin({ scheme, plugin, label }: ParsedPluginOrigin): string {
  return `${scheme}://${plugin}${label === null ? '' : `.${label}`}`
}

/**
 * The host a parsed origin is on: this PC for no label, otherwise the one of
 * `hosts` whose label it is, or null when none is.
 */
export function hostOfLabel(label: string | null, hosts: Iterable<string>): string | null {
  if (label === null) return LOCAL_HOST_KEY
  for (const host of hosts) if (host !== LOCAL_HOST_KEY && hostLabel(host) === label) return host
  return null
}

/**
 * A page URL as a host listed it, moved onto that host's origin for the
 * plugin: the host's authority is replaced and its path, query and fragment
 * kept. Its plugin scheme is kept too, so a version 2 page stays on
 * `floti-plugin`; a URL on neither scheme is put on `at.scheme`, or
 * `helm-plugin`. This PC's URLs are its own already and come back as they
 * are.
 */
export function onHostOrigin(url: string, at: PluginOnHost): string {
  if (at.host === LOCAL_HOST_KEY) return url
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(url)
  const rest = match?.[1] ?? ''
  const scheme = pluginSchemeOf(url) ?? at.scheme ?? PLUGIN_SCHEME
  return `${pluginOrigin({ host: at.host, plugin: at.plugin, scheme })}${rest === '' ? '/' : rest}`
}

/** The frame key of a surface on a remote host: its own key under the host's, so two hosts' frames never share one. */
export function hostFrameKey(host: string | undefined, key: string): string {
  return host === undefined || host === LOCAL_HOST_KEY ? key : `host:${host}/${key}`
}
