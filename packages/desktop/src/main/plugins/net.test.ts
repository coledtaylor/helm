import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '@helm/core'
import { validateManifest, type NormalizedManifest } from '@coledtaylor/helm-plugin-sdk/manifest'
import type { PluginFetchRequest } from '../../shared/ipc'
import type { FetchContext, Hop, SendHop } from './net'
import type { SecretStore } from './secrets'

/**
 * Chromium's side of `electronSender`: `net.request` and the plugin
 * partition. Refused unless a test hands `request` a request of its own.
 */
const chromium = vi.hoisted(() => ({
  request: null as ((options: Record<string, unknown>) => unknown) | null,
  partitions: [] as string[],
  verify: null as ((request: { hostname: string }, callback: (result: number) => void) => void) | null
}))

vi.mock('electron', async () => {
  const fake = (await import('../../../test/electron')).electronFake()
  return {
    ...fake,
    net: {
      ...(fake['net'] as Record<string, unknown>),
      request: (options: Record<string, unknown>) => {
        if (chromium.request === null) throw new Error('no network in tests')
        return chromium.request(options)
      }
    },
    session: {
      fromPartition: (name: string) => {
        chromium.partitions.push(name)
        return {
          name,
          setCertificateVerifyProc: (proc: NonNullable<typeof chromium.verify>) => {
            chromium.verify = proc
          }
        }
      }
    }
  }
})

const { electronSender, pluginFetch, PLUGIN_NET_PARTITION, RESPONSE_MAX_BYTES, SERVICE_TOKEN_HEADER } = await import('./net')
const { createSecretStore } = await import('./secrets')
const { PluginCallError } = await import('./errors')

/**
 * `helm.fetch` against real servers on this machine: three origins, two of
 * them in the manifest. What a server *received* is the evidence - a request
 * that was refused never arrives, and a secret is visible exactly where it
 * was sent.
 *
 * The transport is Node's `http` here rather than Chromium's, with the same
 * contract as `electronSender`: one hop, a redirect reported and not followed.
 */

interface Seen {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

interface Origin {
  server: Server
  url: string
  seen: Seen[]
}

/** Every origin answers the same routes, so a test reads as where a request went. */
function startOrigin(): Promise<Origin> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body })
      const url = new URL(req.url ?? '/', 'http://local')
      if (url.pathname === '/redirect') {
        res.writeHead(Number(url.searchParams.get('status') ?? 302), { location: url.searchParams.get('to') ?? '/' })
        res.end()
        return
      }
      // A Location naming a secret: the server's text, which must never be filled.
      if (url.pathname === '/wants-secret') {
        res.writeHead(302, { location: '/landed?k={{token}}' })
        res.end()
        return
      }
      if (url.pathname === '/loop') {
        res.writeHead(302, { location: '/loop' })
        res.end()
        return
      }
      if (url.pathname === '/slow') {
        setTimeout(() => res.end('late'), 5000).unref()
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-origin': 'yes' })
      res.end(`ok ${req.method ?? ''} ${url.pathname}`)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${String(port)}`, seen })
    })
  })
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** One hop over Node's `http`, as `electronSender` does it over Chromium's. */
const nodeSender: SendHop = (hop, signal) =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    for (const [name, value] of hop.headers) {
      const key = name.toLowerCase()
      headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`
    }
    const req = httpRequest(hop.url, { method: hop.method, headers, signal }, (res) => {
      const pairs = Object.entries(res.headers).flatMap(([name, value]) =>
        (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((one): [string, string] => [name, one])
      )
      const status = res.statusCode ?? 0
      if (REDIRECTS.has(status) && typeof res.headers.location === 'string') {
        res.resume()
        resolve({ kind: 'redirect', status, statusText: res.statusMessage ?? '', location: res.headers.location, headers: pairs })
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () =>
        resolve({ kind: 'response', status, statusText: res.statusMessage ?? '', headers: pairs, body: new Uint8Array(Buffer.concat(chunks)) })
      )
    })
    req.on('error', reject)
    if (hop.body !== null) req.write(Buffer.from(hop.body))
    req.end()
  })

let a: Origin
let b: Origin
let outside: Origin
let store: Store
let secrets: SecretStore
let manifest: NormalizedManifest

beforeAll(async () => {
  ;[a, b, outside] = await Promise.all([startOrigin(), startOrigin(), startOrigin()])
  const result = validateManifest({
    apiVersion: 1,
    id: 'sample',
    name: 'Sample',
    network: [a.url, b.url],
    secrets: ['token']
  })
  if (!result.ok) throw new Error(result.errors.join('; '))
  manifest = result.manifest
})

afterAll(async () => {
  await Promise.all([a, b, outside].map((origin) => new Promise((resolve) => origin.server.close(resolve))))
})

beforeEach(() => {
  for (const origin of [a, b, outside]) origin.seen.length = 0
  store?.close()
  store = openStore({ file: ':memory:' })
  secrets = createSecretStore({
    store,
    crypto: {
      available: () => true,
      encrypt: (text) => Buffer.from(text, 'utf8'),
      decrypt: (data) => data.toString('utf8')
    },
    onChange: () => undefined
  })
  // Allowed for the first origin only.
  secrets.save({ key: 'token', value: 's3cret', hosts: [a.url], plugins: ['sample'] })
})

function context(patch: Partial<FetchContext> = {}): FetchContext {
  return {
    plugin: 'sample',
    manifest,
    secrets,
    service: null,
    send: nodeSender,
    signal: new AbortController().signal,
    ...patch
  }
}

function req(url: string, init: Partial<PluginFetchRequest> = {}): PluginFetchRequest {
  return { url, method: 'GET', headers: [], body: null, redirect: 'follow', ...init }
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(PluginCallError)
    return { code: (error as InstanceType<typeof PluginCallError>).code, message: (error as Error).message }
  }
  throw new Error('expected a refusal')
}

const text = (body: Uint8Array): string => new TextDecoder().decode(body)
const sent = (origin: Origin): string => JSON.stringify(origin.seen)

describe('reach', () => {
  it('sends to an origin the manifest lists, and says what came back', async () => {
    const response = await pluginFetch(req(`${a.url}/hello?q=1`), context())
    expect(response).toMatchObject({ status: 200, url: `${a.url}/hello?q=1`, redirected: false })
    expect(text(response.body)).toBe('ok GET /hello')
    expect(response.headers).toContainEqual(['x-origin', 'yes'])
    expect(a.seen.map((one) => one.path)).toEqual(['/hello?q=1'])
  })

  it('refuses an origin the manifest does not list, before anything is sent', async () => {
    expect(await refusal(pluginFetch(req(`${outside.url}/x`), context()))).toMatchObject({ code: 'not-declared' })
    expect(outside.seen).toEqual([])
  })

  it.each([
    ['file:///C:/Windows/win.ini', 'not-declared'],
    ['ftp://127.0.0.1/', 'not-declared'],
    ['not a url', 'invalid']
  ])('refuses %s', async (url, code) => {
    expect((await refusal(pluginFetch(req(url), context()))).code).toBe(code)
  })

  it('refuses credentials in the URL', async () => {
    const withUser = a.url.replace('http://', 'http://user:pass@')
    expect(await refusal(pluginFetch(req(`${withUser}/`), context()))).toMatchObject({ code: 'invalid' })
    expect(a.seen).toEqual([])
  })

  it('refuses what is not a request at all', async () => {
    expect((await refusal(pluginFetch(null, context()))).code).toBe('invalid')
    expect((await refusal(pluginFetch(req(`${a.url}/${'x'.repeat(9000)}`), context()))).code).toBe('invalid')
  })

  it('refuses a request body past its limit before anything is sent', async () => {
    const result = await refusal(
      pluginFetch(req(`${a.url}/`, { method: 'POST', body: new Uint8Array(16 * 1024 * 1024 + 1) }), context())
    )
    expect(result).toEqual({ code: 'invalid', message: 'a request body is limited to 16 MB' })
    expect(a.seen).toEqual([])
  })

  it.each([
    [{ method: 'CONNECT' }],
    [{ method: 'BAD METHOD' }],
    [{ headers: [['x', 1]] as unknown as Array<[string, string]> }],
    [{ body: 'text' as unknown as Uint8Array }],
    [{ redirect: 'sometimes' as never }]
  ])('refuses a request a page could only have forged: %j', async (patch) => {
    expect((await refusal(pluginFetch(req(`${a.url}/`, patch), context()))).code).toBe('invalid')
    expect(a.seen).toEqual([])
  })

  it('keeps the transport headers its own: a page cannot name the host', async () => {
    await pluginFetch(req(`${a.url}/`, { headers: [['host', 'evil.example.com'], ['x-mine', '1']] }), context())
    expect(a.seen[0]!.headers.host).toBe(a.url.slice('http://'.length))
    expect(a.seen[0]!.headers['x-mine']).toBe('1')
  })
})

describe('redirects', () => {
  it('follows one that stays inside the list', async () => {
    const response = await pluginFetch(req(`${a.url}/redirect?to=${encodeURIComponent(`${b.url}/landed`)}`), context())
    expect(response).toMatchObject({ status: 200, url: `${b.url}/landed`, redirected: true })
    expect(b.seen.map((one) => one.path)).toEqual(['/landed'])
  })

  it('refuses one that leaves the list, and the hop is never sent', async () => {
    const result = await refusal(pluginFetch(req(`${a.url}/redirect?to=${encodeURIComponent(`${outside.url}/x`)}`), context()))
    expect(result.code).toBe('not-declared')
    expect(result.message).toContain('(a redirect)')
    expect(outside.seen).toEqual([])
  })

  it('stops a loop', async () => {
    expect(await refusal(pluginFetch(req(`${a.url}/loop`), context()))).toMatchObject({ code: 'network' })
    expect(a.seen.length).toBe(20)
  })

  it('hands back the redirect itself when the request said manual, and refuses when it said error', async () => {
    const manual = await pluginFetch(req(`${a.url}/redirect?to=/elsewhere&status=307`, { redirect: 'manual' }), context())
    expect(manual).toMatchObject({ status: 307, redirected: false })
    expect(manual.headers).toContainEqual(['location', '/elsewhere'])
    expect(await refusal(pluginFetch(req(`${a.url}/redirect?to=/elsewhere`, { redirect: 'error' }), context()))).toMatchObject({
      code: 'network'
    })
  })

  it('turns a POST answered with 303 into a GET with no body, as a browser does', async () => {
    const body = new TextEncoder().encode('{"a":1}')
    const response = await pluginFetch(
      req(`${a.url}/redirect?to=/after&status=303`, {
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body
      }),
      context()
    )
    expect(text(response.body)).toBe('ok GET /after')
    expect(a.seen.map((one) => [one.method, one.body, one.headers['content-type'] ?? null])).toEqual([
      ['POST', '{"a":1}', 'application/json'],
      ['GET', '', null]
    ])
  })

  it.each([301, 302])('turns a POST answered with %i into a GET, as a browser does', async (status) => {
    const body = new TextEncoder().encode('form=1')
    await pluginFetch(
      req(`${a.url}/redirect?to=/after&status=${String(status)}`, {
        method: 'POST',
        headers: [['content-type', 'application/x-www-form-urlencoded']],
        body
      }),
      context()
    )
    expect(a.seen.map((one) => [one.method, one.body])).toEqual([
      ['POST', 'form=1'],
      ['GET', '']
    ])
  })

  it('keeps a 307 a POST, body and all', async () => {
    await pluginFetch(
      req(`${a.url}/redirect?to=/after&status=307`, {
        method: 'POST',
        headers: [['content-type', 'text/plain']],
        body: new TextEncoder().encode('kept')
      }),
      context()
    )
    expect(a.seen.map((one) => [one.method, one.path, one.body])).toEqual([
      ['POST', '/redirect?to=/after&status=307', 'kept'],
      ['POST', '/after', 'kept']
    ])
  })

  it('says a redirect to something that is not a URL is the network, and goes nowhere', async () => {
    const result = await refusal(pluginFetch(req(`${a.url}/redirect?to=${encodeURIComponent('http://[nope')}`), context()))
    expect(result.code).toBe('network')
    expect(result.message).toContain('not a URL')
    expect(a.seen).toHaveLength(1)
  })
})

describe('secrets', () => {
  it('are filled for a host the user allowed', async () => {
    await pluginFetch(req(`${a.url}/me?key={{token}}`, { headers: [['authorization', 'Bearer {{token}}']] }), context())
    expect(a.seen[0]).toMatchObject({ path: '/me?key=s3cret', headers: expect.objectContaining({ authorization: 'Bearer s3cret' }) })
  })

  it('are refused for a listed host the user did not allow, and nothing is sent', async () => {
    const result = await refusal(pluginFetch(req(`${b.url}/me`, { headers: [['authorization', 'Bearer {{token}}']] }), context()))
    expect(result).toMatchObject({ code: 'secret' })
    expect(result.message).toContain(b.url)
    expect(b.seen).toEqual([])
  })

  it('are filled in a JSON body, escaped for it', async () => {
    secrets.save({ key: 'token', value: 'with "quotes"', hosts: [a.url], plugins: ['sample'] })
    await pluginFetch(
      req(`${a.url}/post`, {
        method: 'POST',
        headers: [['content-type', 'application/json']],
        body: new TextEncoder().encode('{"t":"{{token}}"}')
      }),
      context()
    )
    expect(JSON.parse(a.seen[0]!.body)).toEqual({ t: 'with "quotes"' })
  })

  it('are never read from a URL the server supplied', async () => {
    const response = await pluginFetch(req(`${a.url}/wants-secret`), context())
    expect(response.status).toBe(200)
    expect(a.seen).toHaveLength(2)
    expect(sent(a)).not.toContain('s3cret')
    expect(decodeURIComponent(a.seen[1]!.path)).toBe('/landed?k={{token}}')
  })

  it('do not follow a redirect to another origin, and neither do credentials or cookies', async () => {
    const response = await pluginFetch(
      req(`${a.url}/redirect?to=${encodeURIComponent(`${b.url}/landed`)}`, {
        headers: [
          ['authorization', 'Bearer {{token}}'],
          ['cookie', 'session=1'],
          ['proxy-authorization', 'Basic x'],
          ['x-kept', 'yes']
        ]
      }),
      context()
    )
    expect(response.status).toBe(200)
    expect(a.seen[0]!.headers.authorization).toBe('Bearer s3cret')
    const landed = b.seen[0]!.headers
    expect(landed.authorization).toBeUndefined()
    expect(landed.cookie).toBeUndefined()
    expect(landed['proxy-authorization']).toBeUndefined()
    expect(landed['x-kept']).toBe('yes')
    expect(sent(b)).not.toContain('s3cret')
  })

  it('keep credentials across a redirect that stays on the origin', async () => {
    await pluginFetch(req(`${a.url}/redirect?to=/again`, { headers: [['authorization', 'Bearer {{token}}']] }), context())
    expect(a.seen.map((one) => one.headers.authorization)).toEqual(['Bearer s3cret', 'Bearer s3cret'])
  })
})

describe('the service', () => {
  it('is reached by path on its own port, with the token Helm gave it in place of any the page sent', async () => {
    const response = await pluginFetch(
      req('service:/hello?x=1', { headers: [[SERVICE_TOKEN_HEADER, 'forged']] }),
      context({ service: () => Promise.resolve({ origin: a.url, token: 'run-token' }) })
    )
    expect(text(response.body)).toBe('ok GET /hello')
    expect(a.seen[0]!.path).toBe('/hello?x=1')
    expect(a.seen[0]!.headers['helm-service-token']).toBe('run-token')
  })

  it('is refused for a plugin that declares none', async () => {
    expect(await refusal(pluginFetch(req('service:/hello'), context()))).toMatchObject({ code: 'not-declared' })
  })

  it('takes no secrets in requests to it', async () => {
    const result = await refusal(
      pluginFetch(
        req('service:/x', { headers: [['authorization', '{{token}}']] }),
        context({ service: () => Promise.resolve({ origin: a.url, token: 't' }) })
      )
    )
    expect(result.code).toBe('secret')
    expect(a.seen).toEqual([])
  })

  it('may not redirect away from itself', async () => {
    const result = await refusal(
      pluginFetch(
        req(`service:/redirect?to=${encodeURIComponent(`${b.url}/x`)}`),
        context({ service: () => Promise.resolve({ origin: a.url, token: 't' }) })
      )
    )
    expect(result.code).toBe('not-declared')
    expect(b.seen).toEqual([])
  })

  it('passes a service that would not start on as the call error', async () => {
    const result = await refusal(
      pluginFetch(req('service:/x'), context({ service: () => Promise.reject(new PluginCallError('service', 'it failed')) }))
    )
    expect(result).toEqual({ code: 'service', message: 'it failed' })
  })
})

describe('cancelling', () => {
  it('ends a request in flight as aborted', async () => {
    const controller = new AbortController()
    const pending = pluginFetch(req(`${a.url}/slow`), context({ signal: controller.signal }))
    await vi.waitFor(() => expect(a.seen.map((one) => one.path)).toContain('/slow'))
    controller.abort()
    expect(await refusal(pending)).toMatchObject({ code: 'aborted' })
  })

  it('says a transport failure is the network', async () => {
    const broken: SendHop = () => Promise.reject(new Error('connection reset'))
    const result = await refusal(pluginFetch(req(`${a.url}/`), context({ send: broken })))
    expect(result.code).toBe('network')
    expect(result.message).toContain('connection reset')
  })
})

/** A request as Chromium's `net.request` hands it back: what was set on it, and its events. */
class FakeRequest extends EventEmitter {
  headers: Array<[string, string]> = []
  written: Buffer[] = []
  ended = false
  aborted = false

  constructor(private readonly refuseHeader: string | null) {
    super()
  }

  setHeader(name: string, value: string): void {
    if (name === this.refuseHeader) throw new Error(`Invalid header name: ${name}`)
    this.headers.push([name, value])
  }

  write(chunk: Buffer): void {
    this.written.push(chunk)
  }

  end(): void {
    this.ended = true
  }

  abort(): void {
    this.aborted = true
  }
}

class FakeResponse extends EventEmitter {
  constructor(
    readonly statusCode: number,
    readonly statusMessage: string,
    readonly headers: Record<string, string | string[]>
  ) {
    super()
  }
}

/** Chromium answering from now on: every request it was asked for, and the options each was made with. */
function chromiumAnswers(refuseHeader: string | null = null): {
  requests: FakeRequest[]
  options: Array<Record<string, unknown>>
} {
  const requests: FakeRequest[] = []
  const options: Array<Record<string, unknown>> = []
  chromium.request = (made) => {
    options.push(made)
    const request = new FakeRequest(refuseHeader)
    requests.push(request)
    return request
  }
  return { requests, options }
}

const API = 'https://api.example.com/items'
const hop = (patch: Partial<Hop> = {}): Hop => ({ url: new URL(API), method: 'GET', headers: [], body: null, ...patch })
const live = (): AbortSignal => new AbortController().signal

describe('the transport, over Chromium', () => {
  beforeEach(() => {
    chromium.request = null
  })

  it('sends one hop on the plugin partition, with no cookies, no cache, and its headers and body as given', async () => {
    const { requests, options } = chromiumAnswers()
    const pending = electronSender(
      hop({
        method: 'POST',
        headers: [
          ['content-type', 'application/json'],
          ['x-trace', '7']
        ],
        body: new TextEncoder().encode('{"a":1}')
      }),
      live()
    )
    const request = requests[0]!
    expect(options[0]).toMatchObject({
      method: 'POST',
      url: API,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      session: { name: PLUGIN_NET_PARTITION }
    })
    expect(request.headers).toEqual([
      ['content-type', 'application/json'],
      ['x-trace', '7']
    ])
    expect(Buffer.concat(request.written).toString('utf8')).toBe('{"a":1}')
    expect(request.ended).toBe(true)

    const response = new FakeResponse(201, 'Created', { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] })
    request.emit('response', response)
    response.emit('data', Buffer.from('{"items":'))
    response.emit('data', Buffer.from('[]}'))
    response.emit('end')
    const result = await pending
    expect(result).toMatchObject({
      kind: 'response',
      status: 201,
      statusText: 'Created',
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2']
      ]
    })
    expect(result.kind === 'response' ? new TextDecoder().decode(result.body) : null).toBe('{"items":[]}')
  })

  it('writes no body for a request without one, and makes the partition once however many are sent', async () => {
    const { requests } = chromiumAnswers()
    for (let i = 0; i < 3; i += 1) {
      const pending = electronSender(hop(), live())
      const request = requests.at(-1)!
      const response = new FakeResponse(204, 'No Content', {})
      request.emit('response', response)
      response.emit('end')
      expect(await pending).toMatchObject({ kind: 'response', status: 204 })
      expect(request.written).toEqual([])
    }
    expect(chromium.partitions).toEqual([PLUGIN_NET_PARTITION])
  })

  it('reports a redirect without following it, and stops the request', async () => {
    const { requests } = chromiumAnswers()
    const pending = electronSender(hop(), live())
    const request = requests[0]!
    request.emit('redirect', 302, 'GET', 'https://api.example.com/next', { location: ['https://api.example.com/next'] })
    expect(await pending).toEqual({
      kind: 'redirect',
      status: 302,
      statusText: '',
      location: 'https://api.example.com/next',
      headers: [['location', 'https://api.example.com/next']]
    })
    expect(request.aborted).toBe(true)
    expect(requests).toHaveLength(1)
  })

  it('refuses a response past its limit, stops reading it, and ignores the end that follows', async () => {
    const { requests } = chromiumAnswers()
    const pending = electronSender(hop(), live())
    const request = requests[0]!
    const response = new FakeResponse(200, 'OK', {})
    request.emit('response', response)
    response.emit('data', Buffer.alloc(RESPONSE_MAX_BYTES))
    response.emit('data', Buffer.alloc(1))
    response.emit('end')
    await expect(pending).rejects.toMatchObject({ code: 'network', message: 'the response is over 32 MB' })
    expect(request.aborted).toBe(true)
  })

  it('ends as aborted when cancelled before it was sent, setting nothing on the request', async () => {
    const { requests } = chromiumAnswers()
    const controller = new AbortController()
    controller.abort()
    await expect(electronSender(hop({ headers: [['x-a', '1']] }), controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(requests[0]!.aborted).toBe(true)
    expect(requests[0]!.headers).toEqual([])
  })

  it('ends as aborted when cancelled in flight, and an answer that comes later changes nothing', async () => {
    const { requests } = chromiumAnswers()
    const controller = new AbortController()
    const pending = electronSender(hop(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const request = requests[0]!
    expect(request.aborted).toBe(true)
    request.emit('redirect', 302, 'GET', 'https://api.example.com/late', {})
  })

  it('refuses a header Chromium will not send, and sends nothing', async () => {
    const { requests } = chromiumAnswers('bad header')
    const result = electronSender(
      hop({
        headers: [
          ['x-fine', '1'],
          ['bad header', '2']
        ]
      }),
      live()
    )
    await expect(result).rejects.toMatchObject({
      code: 'invalid',
      message: 'a header was refused: Invalid header name: bad header'
    })
    expect(requests[0]!.aborted).toBe(true)
    expect(requests[0]!.ended).toBe(false)
  })

  it("passes on the transport's own error, and says a response cut off midway was cut off", async () => {
    const { requests } = chromiumAnswers()
    const refused = electronSender(hop(), live())
    requests[0]!.emit('error', new Error('net::ERR_CONNECTION_REFUSED'))
    await expect(refused).rejects.toThrow('net::ERR_CONNECTION_REFUSED')

    const cut = electronSender(hop(), live())
    const response = new FakeResponse(200, 'OK', {})
    requests[1]!.emit('response', response)
    response.emit('data', Buffer.from('half'))
    response.emit('error', new Error('socket hang up'))
    await expect(cut).rejects.toThrow('the response was cut off')
  })

  it('accepts a self-signed certificate on this machine and nowhere else', async () => {
    const { requests } = chromiumAnswers()
    // The partition, and its rule, are made with the first request.
    const pending = electronSender(hop(), live())
    const response = new FakeResponse(200, 'OK', {})
    requests[0]!.emit('response', response)
    response.emit('end')
    await pending

    const verdict = (hostname: string): number => {
      let result = Number.NaN
      chromium.verify?.({ hostname }, (value) => {
        result = value
      })
      return result
    }
    expect(['localhost', '127.0.0.1', '::1'].map(verdict)).toEqual([0, 0, 0])
    expect(['api.example.com', '10.0.0.5', '127.0.0.1.example.com'].map(verdict)).toEqual([-3, -3, -3])
  })

  it('is what helm.fetch sends through: a redirect reported by Chromium is followed as the next hop', async () => {
    secrets.save({ key: 'token', value: 's3cret', hosts: ['https://api.example.com'], plugins: ['sample'] })
    const listed = validateManifest({
      apiVersion: 1,
      id: 'sample',
      name: 'Sample',
      network: ['https://api.example.com'],
      secrets: ['token']
    })
    if (!listed.ok) throw new Error(listed.errors.join('; '))
    const { requests, options } = chromiumAnswers()
    const pending = pluginFetch(
      req(`${API}?page=1`, { headers: [['authorization', 'Bearer {{token}}']] }),
      context({ manifest: listed.manifest, send: electronSender })
    )
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]!.headers).toEqual([['authorization', 'Bearer s3cret']])
    requests[0]!.emit('redirect', 301, 'GET', '/items?page=2', {})

    await vi.waitFor(() => expect(requests).toHaveLength(2))
    const response = new FakeResponse(200, 'OK', { 'content-type': 'text/plain' })
    requests[1]!.emit('response', response)
    response.emit('data', Buffer.from('page 2'))
    response.emit('end')

    const result = await pending
    expect(result).toMatchObject({ status: 200, url: 'https://api.example.com/items?page=2', redirected: true })
    expect(text(result.body)).toBe('page 2')
    expect(options.map((one) => one['url'])).toEqual([`${API}?page=1`, 'https://api.example.com/items?page=2'])
    expect(requests[1]!.headers).toEqual([['authorization', 'Bearer s3cret']])
  })
})
