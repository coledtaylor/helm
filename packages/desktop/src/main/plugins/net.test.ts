import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store } from '@helm/core'
import { validateManifest, type NormalizedManifest } from '@helm/plugin-sdk/manifest'
import type { PluginFetchRequest } from '../../shared/ipc'
import type { FetchContext, SendHop } from './net'
import type { SecretStore } from './secrets'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { pluginFetch, SERVICE_TOKEN_HEADER } = await import('./net')
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
