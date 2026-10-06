import { readFileSync } from 'node:fs'
import { extname, sep } from 'node:path'
import { protocol } from 'electron'
import { RESERVED_PREFIX } from '@coledtaylor/helm-plugin-sdk/manifest'
import { PLUGIN_SCHEME } from '../../shared/ipc'
import { MIME } from '../content'
import { resolveInside } from './loader'

/**
 * `helm-plugin://<id>/<path>`: a plugin's folder, and Helm's runtime beside it.
 *
 * The host names the plugin, so every plugin is its own **origin**: the
 * browser keeps it out of Helm's page and out of every other plugin's, gives
 * it storage of its own, and stamps its `postMessage`s with an origin it
 * cannot forge. That origin is the plugin's identity everywhere.
 *
 * Under `/__helm/` on every origin Helm serves its runtime - the bridge and
 * the primitives stylesheet - so a plugin never ships a copy of either and
 * never runs a stale one. Every HTML page the plugin serves gets the two
 * injected at the top of its `<head>`, before its own styles and scripts:
 * `window.helm` exists before the plugin's first line runs, and the plugin's
 * CSS wins over the primitives wherever it says something different.
 */

/**
 * What a plugin page may do.
 *
 * Its own origin for script, style, images and fonts, and no network of any
 * kind: `connect-src 'none'` closes fetch, XHR, WebSocket and EventSource, so
 * `helm.fetch` - where the host list and the secrets are - is the only way out.
 * No inline script, because a built plugin has none and an injected one is the
 * commonest way a page that renders remote data goes wrong.
 */
export const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

/** A plugin Helm serves: enabled and loaded. */
export interface ServedPlugin {
  dir: string
}

export interface PluginRuntime {
  /** The bridge script, for this plugin's pages. */
  bridge(): string
  /** The page's first theme and the bridge's other start-up facts, as JSON. */
  boot(plugin: string): string
  /** The primitives stylesheet. */
  css(): string
}

const RUNTIME_PATH = `/${RESERVED_PREFIX}`

const HEADERS = {
  'content-security-policy': PLUGIN_CSP,
  'x-content-type-options': 'nosniff',
  // A plugin under development is rebuilt underneath a running Helm.
  'cache-control': 'no-store'
}

/** Answers one request on the scheme. Separate from the registration so a test can call it. */
export function servePluginRequest(
  requestUrl: string,
  lookup: (id: string) => ServedPlugin | null,
  runtime: PluginRuntime
): Response {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const id = url.hostname
  const plugin = lookup(id)
  if (plugin === null) return new Response('Not found', { status: 404 })

  if (url.pathname.startsWith(RUNTIME_PATH)) {
    const name = url.pathname.slice(RUNTIME_PATH.length)
    if (name === 'bridge.js') return asset(runtime.bridge(), 'text/javascript; charset=utf-8')
    if (name === 'helm.css') return asset(runtime.css(), 'text/css; charset=utf-8')
    return new Response('Not found', { status: 404 })
  }

  let rel: string
  try {
    rel = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part))
      .join(sep)
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  if (rel === '' || rel.includes('\0')) return new Response('Not found', { status: 404 })
  const target = resolveInside(plugin.dir, rel)
  if (target === 'outside') return new Response('Forbidden', { status: 403 })
  if (target === null) return new Response('Not found', { status: 404 })

  let bytes: Buffer
  try {
    bytes = readFileSync(target)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const extension = extname(target).toLowerCase()
  const type = MIME[extension] ?? 'application/octet-stream'
  if (extension === '.html' || extension === '.htm') {
    return asset(injectRuntime(bytes.toString('utf8'), runtime.boot(id)), type)
  }
  return new Response(new Uint8Array(bytes), { status: 200, headers: { ...HEADERS, 'content-type': type } })
}

function asset(body: string, type: string): Response {
  return new Response(body, { status: 200, headers: { ...HEADERS, 'content-type': type } })
}

/**
 * The runtime's two tags, at the top of the document's `<head>`.
 *
 * The page's first theme rides on the script tag (`data-helm-boot`), so the
 * bridge can paint it before anything else draws and the bridge itself stays
 * the same bytes for every page.
 */
export function injectRuntime(html: string, boot: string): string {
  const attribute = boot.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;')
  const tags =
    `<link rel="stylesheet" href="${RUNTIME_PATH}helm.css">` +
    `<script src="${RUNTIME_PATH}bridge.js" data-helm-boot='${attribute}'></script>`
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head !== null) return insertAt(html, head.index + head[0].length, tags)
  const root = /<html(?:\s[^>]*)?>/i.exec(html)
  if (root !== null) return insertAt(html, root.index + root[0].length, `<head>${tags}</head>`)
  // No `<html>`: after the doctype if there is one, so the page stays out of quirks mode.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype !== null ? insertAt(html, doctype[0].length, tags) : tags + html
}

function insertAt(text: string, at: number, insert: string): string {
  return text.slice(0, at) + insert + text.slice(at)
}

export function registerPluginProtocol(lookup: (id: string) => ServedPlugin | null, runtime: PluginRuntime): void {
  protocol.handle(PLUGIN_SCHEME, (request) => servePluginRequest(request.url, lookup, runtime))
}
