import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { linkFolder, unlinkFolder } from '../../../test/links'
import type { PluginPageSource, PluginRuntime } from './protocol'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { injectRuntime, PLUGIN_CSP, servePluginRequest, servePluginRequestFrom } = await import('./protocol')

/**
 * `helm-plugin://<id>/`: a plugin's folder served under its own origin, every
 * response under the plugin CSP, Helm's runtime injected at the top of every
 * page and served under `/__helm/`, and nothing outside the folder reachable.
 */

let root: string
let dir: string

const runtime: PluginRuntime = {
  bridge: () => 'window.__bridge = 1',
  css: () => ':root { --helm: 1 }',
  boot: (plugin) => JSON.stringify({ theme: { kind: 'dark' }, plugin, quote: "it's <b>&" })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm plugin protocol-'))
  dir = join(root, 'my plugin')
  mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'main page.html'), '<!doctype html><html><head><title>t</title></head><body>hi</body></html>')
  writeFileSync(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(dir, 'dist', 'assets', 'app.css'), 'body{}')
  writeFileSync(join(dir, 'dist', 'data.bin'), Buffer.from([0, 1, 2]))
  writeFileSync(join(root, 'secret.txt'), "not the plugin's")
  mkdirSync(join(root, 'elsewhere'))
  writeFileSync(join(root, 'elsewhere', 'x.js'), 'outside')
  linkFolder(join(dir, 'escape'), join(root, 'elsewhere'))
})

afterAll(() => {
  unlinkFolder(join(dir, 'escape'))
  rmSync(root, { recursive: true, force: true })
})

const lookup = (id: string): { dir: string } | null => (id === 'sample' ? { dir: realpathSync.native(dir) } : null)
const serve = (url: string): Response => servePluginRequest(url, lookup, runtime)

describe('servePluginRequest', () => {
  it('serves a page with the runtime at the top of its head, under the plugin policy', async () => {
    const response = serve('helm-plugin://sample/dist/main%20page.html')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('/__helm/helm.css'))
    expect(html.indexOf('/__helm/bridge.js')).toBeLessThan(html.indexOf('<title>'))
    expect(html).toContain('<script src="/__helm/bridge.js" data-helm-boot=')
  })

  it('serves files with their types and no injection', async () => {
    const js = serve('helm-plugin://sample/dist/assets/app.js')
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await js.text()).toBe('console.log(1)')
    expect(serve('helm-plugin://sample/dist/assets/app.css').headers.get('content-type')).toBe('text/css; charset=utf-8')
    const bin = serve('helm-plugin://sample/dist/data.bin')
    expect(bin.headers.get('content-type')).toBe('application/octet-stream')
    expect(bin.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
    expect(new Uint8Array(await bin.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2]))
  })

  it('ignores the query string and fragment when finding the file', async () => {
    const response = serve('helm-plugin://sample/dist/assets/app.js?v=3#x')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('console.log(1)')
  })

  it('serves the runtime on every plugin origin', async () => {
    const bridge = serve('helm-plugin://sample/__helm/bridge.js')
    expect(bridge.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await bridge.text()).toBe('window.__bridge = 1')
    const css = serve('helm-plugin://sample/__helm/helm.css')
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await css.text()).toBe(':root { --helm: 1 }')
    expect(serve('helm-plugin://sample/__helm/other.js').status).toBe(404)
  })

  it('knows nothing of a plugin that is not served', () => {
    expect(serve('helm-plugin://other/dist/assets/app.js').status).toBe(404)
    expect(serve('helm-plugin://other/__helm/bridge.js').status).toBe(404)
  })

  it.each([
    ['helm-plugin://sample/', 404],
    ['helm-plugin://sample/dist/missing.html', 404],
    ['helm-plugin://sample/dist', 404],
    // The URL parser folds encoded dot segments away first: this asks for
    // /secret.txt inside the folder, which is not there.
    ['helm-plugin://sample/%2e%2e/secret.txt', 404],
    // A backslash is a separator on Windows, where this climbs out and is
    // refused; on macOS and Linux it is part of a file name, not there.
    ['helm-plugin://sample/dist/..%5C..%5Csecret.txt', process.platform === 'win32' ? 403 : 404],
    ['helm-plugin://sample/escape/x.js', 403],
    ['helm-plugin://sample/dist/%00.html', 404],
    ['helm-plugin://sample/dist/%E0%A4%A.html', 400]
  ])('answers %s with %i', (url, status) => {
    expect(serve(url).status).toBe(status)
  })
})

describe('injectRuntime', () => {
  const boot = '{"a":"it\'s <b> & co"}'

  it('puts both tags straight after <head>, with any attributes it has', () => {
    const html = injectRuntime('<html><HEAD lang="en"><title>t</title></HEAD></html>', boot)
    expect(html).toMatch(/^<html><HEAD lang="en"><link rel="stylesheet" href="\/__helm\/helm\.css"><script src="\/__helm\/bridge\.js"/)
  })

  it('makes a head for a page with none', () => {
    expect(injectRuntime('<html><body>x</body></html>', '{}')).toBe(
      `<html><head><link rel="stylesheet" href="/__helm/helm.css"><script src="/__helm/bridge.js" data-helm-boot='{}'></script></head><body>x</body></html>`
    )
  })

  it('keeps a bare page out of quirks mode by going after its doctype', () => {
    expect(injectRuntime('<!DOCTYPE html><p>x</p>', '{}')).toMatch(/^<!DOCTYPE html><link rel="stylesheet"/)
    expect(injectRuntime('<p>x</p>', '{}')).toMatch(/^<link rel="stylesheet".*<p>x<\/p>$/)
  })

  it('escapes the boot JSON so it cannot close its attribute or open a tag', () => {
    const html = injectRuntime('<head></head>', boot)
    const attribute = /data-helm-boot='([^']*)'/.exec(html)?.[1]
    expect(attribute).toBe('{"a":"it&#39;s &lt;b> &amp; co"}')
    // What the browser hands the bridge, once it has decoded the attribute.
    const decoded = attribute!.replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    expect(JSON.parse(decoded)).toEqual({ a: "it's <b> & co" })
  })
})

describe('servePluginRequestFrom: pages from the local host’s files', () => {
  const text = (body: string): Uint8Array => new TextEncoder().encode(body)
  /** The host, as the scheme meets it: one plugin on, its files by path, and every path it was asked for. */
  const host = (onHostComputer = true): PluginPageSource & { asked: string[] } => {
    const asked: string[] = []
    return {
      asked,
      onHostComputer,
      serves: (id) => Promise.resolve(id === 'sample'),
      file: (id, path) => {
        asked.push(`${id}:${path}`)
        if (id !== 'sample') return Promise.resolve({ status: 404, contentType: 'text/plain', body: text('Not found') })
        if (path === 'dist/main page.html') {
          return Promise.resolve({ status: 200, contentType: 'text/html; charset=utf-8', body: text('<!doctype html><html><head><title>t</title></head><body>hi</body></html>') })
        }
        if (path === 'dist/assets/app.js') return Promise.resolve({ status: 200, contentType: 'text/javascript; charset=utf-8', body: text('console.log(1)') })
        if (path === 'escape/x.js') return Promise.resolve({ status: 403, contentType: 'text/plain', body: text('Forbidden') })
        return Promise.resolve({ status: 404, contentType: 'text/plain', body: text('Not found') })
      }
    }
  }

  it('renders a page the host served on the plugin’s origin, with the runtime injected and the same policy as today', async () => {
    const source = host()
    const response = await servePluginRequestFrom('helm-plugin://sample/dist/main%20page.html', source, runtime)
    expect(source.asked).toEqual(['sample:dist/main page.html'])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()
    expect(html.indexOf('<head>')).toBeLessThan(html.indexOf('/__helm/helm.css'))
    expect(html).toContain('<script src="/__helm/bridge.js" data-helm-boot=')

    const js = await servePluginRequestFrom('helm-plugin://sample/dist/assets/app.js?v=2', source, runtime)
    expect(js.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
    expect(await js.text()).toBe('console.log(1)')
  })

  const bootOf = (html: string): unknown => {
    const attribute = /data-helm-boot='([^']*)'/.exec(html)?.[1] ?? ''
    return JSON.parse(attribute.replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&amp;/g, '&'))
  }

  it('tells a page drawn from the host’s files that its channels are relayed through the host, and one Helm serves itself nothing of it', async () => {
    const hosted = await servePluginRequestFrom('helm-plugin://sample/dist/main%20page.html', host(), runtime)
    expect(bootOf(await hosted.text())).toEqual({
      theme: { kind: 'dark' },
      plugin: 'sample',
      quote: "it's <b>&",
      channels: 'host',
      onHostComputer: true
    })
    const own = serve('helm-plugin://sample/dist/main%20page.html')
    expect(bootOf(await own.text())).toEqual({ theme: { kind: 'dark' }, plugin: 'sample', quote: "it's <b>&", onHostComputer: true })
  })

  it('tells a page drawn from a host on another computer that it is not on the host’s computer', async () => {
    const remote = await servePluginRequestFrom('helm-plugin://sample/dist/main%20page.html', host(false), runtime)
    expect(bootOf(await remote.text())).toMatchObject({ channels: 'host', onHostComputer: false })
  })

  it('serves the runtime only on the origin of a plugin the host has on', async () => {
    const source = host()
    const bridge = await servePluginRequestFrom('helm-plugin://sample/__helm/bridge.js', source, runtime)
    expect(await bridge.text()).toBe('window.__bridge = 1')
    expect(bridge.headers.get('content-security-policy')).toBe(PLUGIN_CSP)
    expect((await servePluginRequestFrom('helm-plugin://other/__helm/bridge.js', source, runtime)).status).toBe(404)
    expect(source.asked).toEqual([])
  })

  it('passes on the host’s refusals as they are', async () => {
    const source = host()
    expect((await servePluginRequestFrom('helm-plugin://sample/escape/x.js', source, runtime)).status).toBe(403)
    expect((await servePluginRequestFrom('helm-plugin://sample/dist/gone.js', source, runtime)).status).toBe(404)
    expect((await servePluginRequestFrom('helm-plugin://other/dist/main%20page.html', source, runtime)).status).toBe(404)
    expect((await servePluginRequestFrom('helm-plugin://sample/', source, runtime)).status).toBe(404)
  })

  it('says why when the host cannot be reached, in the page’s own place', async () => {
    const sentence = 'Helm could not reach the local host; turn it off.'
    const source: PluginPageSource = {
      onHostComputer: true,
      serves: () => Promise.reject(new Error(sentence)),
      file: () => Promise.reject(new Error(sentence))
    }
    const page = await servePluginRequestFrom('helm-plugin://sample/dist/main%20page.html', source, runtime)
    expect(page.status).toBe(503)
    expect(await page.text()).toBe(sentence)
    expect((await servePluginRequestFrom('helm-plugin://sample/__helm/bridge.js', source, runtime)).status).toBe(503)
  })
})
