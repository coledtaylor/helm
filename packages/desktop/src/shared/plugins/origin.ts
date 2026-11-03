import { LOCAL_HOST_KEY } from '@helm/core/types'
import { PLUGIN_SCHEME } from '../ipc'

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
 * Nothing here reaches Node or the DOM: main, the window and the hidden
 * plugin window all read origins with it.
 */

/** A plugin on a host: `host` is `LOCAL_HOST_KEY` for this PC, or a remote host's id. */
export interface PluginOnHost {
  host: string
  plugin: string
}

/** An origin taken apart: the plugin, and the label of the host it is on, or null for this PC. */
export interface ParsedPluginOrigin {
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

/** `helm-plugin://<id>` for this PC, `helm-plugin://<id>.<label>` for a remote host. */
export function pluginOrigin({ host, plugin }: PluginOnHost): string {
  return host === LOCAL_HOST_KEY ? `${PLUGIN_SCHEME}://${plugin}` : `${PLUGIN_SCHEME}://${plugin}.${hostLabel(host)}`
}

/**
 * An origin or a URL on the scheme, taken apart; null for anything else.
 * Read from the text, as Node gives a scheme it does not know an opaque
 * origin.
 */
export function parsePluginOrigin(originOrUrl: string | null | undefined): ParsedPluginOrigin | null {
  if (typeof originOrUrl !== 'string') return null
  const prefix = `${PLUGIN_SCHEME}://`
  if (!originOrUrl.toLowerCase().startsWith(prefix)) return null
  const rest = originOrUrl.slice(prefix.length)
  const end = rest.search(/[/?#]/)
  const authority = (end === -1 ? rest : rest.slice(0, end)).toLowerCase()
  if (authority === '' || /[@:]/.test(authority)) return null
  const dot = authority.indexOf('.')
  if (dot === -1) return { plugin: authority, label: null }
  const plugin = authority.slice(0, dot)
  const label = authority.slice(dot + 1)
  if (plugin === '' || !DNS_LABEL.test(label)) return null
  return { plugin, label }
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
 * plugin: the host's own scheme and authority are replaced, its path, query
 * and fragment kept. This PC's URLs are its own already and come back as
 * they are.
 */
export function onHostOrigin(url: string, at: PluginOnHost): string {
  if (at.host === LOCAL_HOST_KEY) return url
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(url)
  const rest = match?.[1] ?? ''
  return `${pluginOrigin(at)}${rest === '' ? '/' : rest}`
}

/** The frame key of a surface on a remote host: its own key under the host's, so two hosts' frames never share one. */
export function hostFrameKey(host: string | undefined, key: string): string {
  return host === undefined || host === LOCAL_HOST_KEY ? key : `host:${host}/${key}`
}
