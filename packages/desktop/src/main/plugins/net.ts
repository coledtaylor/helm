import { net, session, type Session } from 'electron'
import { isLoopbackUrl } from '@helm/core/types'
import { originMatches, PLACEHOLDER_PATTERN, type NormalizedManifest } from '@coledtaylor/helm-plugin-sdk/manifest'
import type { PluginFetchRequest, PluginFetchResponse } from '../../shared/ipc'
import { PluginCallError } from './errors'
import type { SecretStore } from './secrets'
import { substituteBody, substituteHeaders, substituteUrl } from './substitute'

/**
 * `helm.fetch`: a plugin's only way onto the network.
 *
 * The page has none of its own (`connect-src 'none'`). It hands the request
 * here, and this process sends it - to an origin the manifest declares and
 * nowhere else, with the `{{secrets}}` the user allowed filled in, following
 * redirects itself so that every hop is checked against the same list rather
 * than only the first.
 *
 * Redirects are taken one hop at a time, as new requests built from the
 * plugin's own template. That is what keeps a secret from following a
 * redirect somewhere it was not allowed to go: each hop's `{{key}}`s are filled
 * for that hop's origin, or the request stops, and a URL the *server* supplied
 * is never searched for placeholders at all.
 */

/** One request, ready to send: secrets filled, headers final. */
export interface Hop {
  url: URL
  method: string
  headers: Array<[string, string]>
  body: Uint8Array | null
}

export type HopResult =
  | {
      kind: 'response'
      status: number
      statusText: string
      headers: Array<[string, string]>
      body: Uint8Array
    }
  | { kind: 'redirect'; status: number; statusText: string; location: string; headers: Array<[string, string]> }

/** Sends one hop and does not follow a redirect. Production is `electronSender`; a test hands its own. */
export type SendHop = (hop: Hop, signal: AbortSignal) => Promise<HopResult>

/** The plugin's service, started if it is not running. Throws `PluginCallError('service')`. */
export type ServiceEndpoint = () => Promise<{ origin: string; token: string }>

export interface FetchContext {
  plugin: string
  manifest: NormalizedManifest
  secrets: SecretStore
  service: ServiceEndpoint | null
  send: SendHop
  signal: AbortSignal
}

/** Every request ends by this, response read or not. */
export const FETCH_TIMEOUT_MS = 120_000
/** A response body past this is refused rather than held in two processes' memory. */
export const RESPONSE_MAX_BYTES = 32 * 1024 * 1024
const REQUEST_MAX_BYTES = 16 * 1024 * 1024
const MAX_HOPS = 20

/** The header the service is told to require. See `ServiceSpec` in the SDK. */
export const SERVICE_TOKEN_HEADER = 'Helm-Service-Token'

/**
 * Headers the transport owns. A page cannot set them in a browser either, and
 * here a wrong `Host` or `Content-Length` would be a request that lies about
 * itself.
 */
const TRANSPORT_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'proxy-connection'
])

/** Taken off a request whose redirect leaves its origin, as `fetch` does - and the two it would have kept in a cookie jar. */
const CROSS_ORIGIN_DROPPED = new Set(['authorization', 'cookie', 'proxy-authorization'])

const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const REFUSED_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

export async function pluginFetch(raw: unknown, ctx: FetchContext): Promise<PluginFetchResponse> {
  const request = readRequest(raw)

  let target: URL
  try {
    target = new URL(request.url)
  } catch {
    throw new PluginCallError('invalid', `${request.url} is not a URL`)
  }

  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = AbortSignal.any([ctx.signal, timeout])

  // The plugin's own service: reached by path, on the loopback port Helm gave
  // it, with the token it was given. It gets its secrets through its
  // environment, so a placeholder in a request to it is a mistake.
  let service: { origin: string; token: string } | null = null
  if (target.protocol === 'service:') {
    if (ctx.service === null) throw new PluginCallError('not-declared', 'this plugin declares no service')
    if (hasPlaceholder(request.url) || request.headers.some(([, value]) => hasPlaceholder(value))) {
      throw new PluginCallError('secret', 'a service gets its secrets through its environment, not in requests to it')
    }
    service = await ctx.service()
    target = new URL(`${target.pathname.startsWith('/') ? '' : '/'}${target.pathname}${target.search}`, service.origin)
  } else {
    checkReach(target, ctx.manifest)
  }

  let method = request.method
  let body = request.body
  let headers = request.headers.filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
  if (service !== null) {
    headers = headers.filter(([name]) => name.toLowerCase() !== SERVICE_TOKEN_HEADER.toLowerCase())
  }
  let redirected = false

  for (let hops = 0; ; hops += 1) {
    const reveal = ctx.secrets.revealer(ctx.plugin, ctx.manifest.secrets, { kind: 'request', url: target })
    const contentType = headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null
    const hop: Hop = {
      // Only the plugin's own URL is searched for placeholders. A Location
      // header is the server's text, and filling it would let a server name
      // the secret it wants.
      url: hops === 0 && service === null ? substituteUrl(target, reveal) : target,
      method,
      headers: [
        ...substituteHeaders(headers, reveal),
        ...(service === null ? [] : [[SERVICE_TOKEN_HEADER, service.token] as [string, string]])
      ],
      body: substituteBody(body, contentType, reveal)
    }

    let result: HopResult
    try {
      result = await ctx.send(hop, signal)
    } catch (error) {
      if (ctx.signal.aborted) throw new PluginCallError('aborted', 'the request was cancelled')
      if (timeout.aborted) throw new PluginCallError('timeout', `no answer from ${target.origin} within ${String(FETCH_TIMEOUT_MS / 1000)}s`)
      if (error instanceof PluginCallError) throw error
      throw new PluginCallError('network', `${target.origin}: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (result.kind === 'response') {
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
        url: target.href,
        redirected
      }
    }

    if (request.redirect === 'error') {
      throw new PluginCallError('network', `${target.origin} redirected, and the request said not to follow`)
    }
    if (request.redirect === 'manual') {
      return {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: new Uint8Array(0),
        url: target.href,
        redirected
      }
    }
    if (hops + 1 >= MAX_HOPS) throw new PluginCallError('network', `more than ${String(MAX_HOPS)} redirects`)

    let next: URL
    try {
      next = new URL(result.location, target)
    } catch {
      throw new PluginCallError('network', `${target.origin} redirected to something that is not a URL`)
    }
    if (service !== null) {
      if (next.origin !== service.origin) throw new PluginCallError('not-declared', 'the service redirected away from itself')
    } else {
      checkReach(next, ctx.manifest, ' (a redirect)')
    }

    // A 303, and a 301 or 302 answering a POST, become a GET with no body -
    // what every browser does, so a plugin's request behaves here as it would
    // anywhere else.
    if (result.status === 303 ? method !== 'HEAD' : (result.status === 301 || result.status === 302) && method === 'POST') {
      method = 'GET'
      body = null
      headers = headers.filter(([name]) => !/^content-/i.test(name))
    }
    if (next.origin !== target.origin) {
      headers = headers.filter(([name]) => !CROSS_ORIGIN_DROPPED.has(name.toLowerCase()))
    }
    target = next
    redirected = true
  }
}

/** Whether a URL is one the plugin may reach, or the reason it is not. */
export function checkReach(url: URL, manifest: NormalizedManifest, what = ''): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PluginCallError('not-declared', `${url.protocol} URLs cannot be fetched${what}`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new PluginCallError('invalid', 'put credentials in a header, not in the URL')
  }
  if (!manifest.network.some((pattern) => originMatches(pattern, url))) {
    throw new PluginCallError('not-declared', `${url.origin}${what} is not one of the origins the manifest's network lists`)
  }
}

function hasPlaceholder(text: string): boolean {
  PLACEHOLDER_PATTERN.lastIndex = 0
  const found = PLACEHOLDER_PATTERN.test(text) || /%7B%7B/i.test(text)
  PLACEHOLDER_PATTERN.lastIndex = 0
  return found
}

/** The request as the bridge sent it, every field checked: this came from a page. */
function readRequest(raw: unknown): PluginFetchRequest {
  if (typeof raw !== 'object' || raw === null) throw new PluginCallError('invalid', 'fetch needs a request')
  const record = raw as Record<string, unknown>
  const { url, method, headers, body, redirect } = record
  if (typeof url !== 'string' || url.length > 8192) throw new PluginCallError('invalid', 'fetch needs a URL')
  if (typeof method !== 'string' || !METHOD.test(method)) throw new PluginCallError('invalid', 'fetch needs a method')
  const upper = method.toUpperCase()
  if (REFUSED_METHODS.has(upper)) throw new PluginCallError('invalid', `${upper} is not a method fetch sends`)
  if (
    !Array.isArray(headers) ||
    headers.length > 200 ||
    !headers.every(
      (pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string'
    )
  ) {
    throw new PluginCallError('invalid', 'headers must be name and value pairs')
  }
  if (body !== null && !(body instanceof Uint8Array)) throw new PluginCallError('invalid', 'the body must be bytes')
  if (body !== null && body.byteLength > REQUEST_MAX_BYTES) {
    throw new PluginCallError('invalid', `a request body is limited to ${String(REQUEST_MAX_BYTES / 1024 / 1024)} MB`)
  }
  if (redirect !== 'follow' && redirect !== 'manual' && redirect !== 'error') {
    throw new PluginCallError('invalid', 'redirect must be follow, manual or error')
  }
  return { url, method: upper, headers: headers as Array<[string, string]>, body, redirect }
}

// ---------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------

/** The partition plugin requests go out on: in memory, so nothing a request brings back is kept on disk. */
export const PLUGIN_NET_PARTITION = 'helm-plugin-net'

let netSession: Session | null = null

/**
 * The session plugin requests use: no cookies sent or kept, no cache, the
 * system's proxy. A self-signed certificate is accepted for loopback only -
 * a service on this machine, or a local build of an API - which is the rule
 * the browser pane follows and for the same reason.
 */
function pluginNetSession(): Session {
  if (netSession !== null) return netSession
  const partition = session.fromPartition(PLUGIN_NET_PARTITION)
  partition.setCertificateVerifyProc((request, callback) => {
    const host = request.hostname.includes(':') ? `[${request.hostname}]` : request.hostname
    callback(isLoopbackUrl(`https://${host}/`) ? 0 : -3)
  })
  netSession = partition
  return partition
}

/**
 * One hop over Chromium's network stack (`net.request`), which brings the
 * system proxy and certificate store with it - what a company network needs.
 * A redirect is reported, not followed: see `pluginFetch`.
 */
export const electronSender: SendHop = (hop, signal) =>
  new Promise<HopResult>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const request = net.request({
      method: hop.method,
      url: hop.url.href,
      session: pluginNetSession(),
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store'
    })
    const onAbort = (): void => {
      request.abort()
      settle(() => reject(new DOMException('aborted', 'AbortError')))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort)

    try {
      for (const [name, value] of hop.headers) request.setHeader(name, value)
    } catch (error) {
      request.abort()
      settle(() =>
        reject(new PluginCallError('invalid', `a header was refused: ${error instanceof Error ? error.message : String(error)}`))
      )
      return
    }

    request.on('redirect', (status, _method, location, responseHeaders) => {
      settle(() =>
        resolve({ kind: 'redirect', status, statusText: '', location, headers: headerPairs(responseHeaders) })
      )
      request.abort()
    })
    request.on('response', (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > RESPONSE_MAX_BYTES) {
          request.abort()
          settle(() =>
            reject(new PluginCallError('network', `the response is over ${String(RESPONSE_MAX_BYTES / 1024 / 1024)} MB`))
          )
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        settle(() =>
          resolve({
            kind: 'response',
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: headerPairs(response.headers),
            body: new Uint8Array(Buffer.concat(chunks))
          })
        )
      })
      response.on('error', () => settle(() => reject(new Error('the response was cut off'))))
    })
    request.on('error', (error) => settle(() => reject(error)))
    if (hop.body !== null) request.write(Buffer.from(hop.body))
    request.end()
  })

function headerPairs(headers: Record<string, string | string[]>): Array<[string, string]> {
  return Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one): [string, string] => [name, one])
  )
}
