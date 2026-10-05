import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PluginRuntime } from './protocol'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { injectRuntime, PLUGIN_CSP, servePluginRequest } = await import('./protocol')

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
  execFileSync('cmd', ['/c', 'mklink', '/J', join(dir, 'escape'), join(root, 'elsewhere')], { stdio: 'ignore' })
})

afterAll(() => {
  execFileSync('cmd', ['/c', 'rmdir', join(dir, 'escape')], { stdio: 'ignore' })
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
    ['helm-plugin://sample/dist/..%5C..%5Csecret.txt', 403],
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
