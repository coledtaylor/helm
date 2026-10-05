import { app, protocol, type BrowserWindow } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { delimiter, extname, resolve, sep } from 'node:path'
import { PLUGIN_SCHEME, type PluginFrameReport, type PluginInfo, type PluginSurface } from '../shared/ipc'
import { isInside, MIME } from './content'

/**
 * Plugins - the spike.
 *
 * A plugin is a folder with a `helm-plugin.json`. Its pages are served on a
 * scheme of their own, `helm-plugin://<id>/<path>`, so every plugin is its own
 * **origin**: the browser keeps it out of Helm's page and out of every other
 * plugin's, gives it storage of its own, and stamps its `postMessage`s with an
 * origin it cannot forge. That origin is the plugin's identity everywhere.
 *
 * The pages are framed by the renderer as iframes rather than shown in native
 * views, because a native view paints over all of Helm's DOM - menus, drop
 * previews, tooltips - and an iframe is composited with it. What the spike
 * measures is whether that costs the isolation a native view would have given:
 * see `pluginFrameReport`.
 *
 * Spike scope: plugins are named by `HELM_PLUGINS` (folders separated by `;`),
 * read once at start. Settings, secrets, network and the rest come later.
 */

export { PLUGIN_SCHEME }

/** The id is the URL host, and a standard scheme lowercases its host. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * What a plugin page may do.
 *
 * Its own folder for script, style, images and fonts, and no network of any
 * kind: `connect-src 'none'` closes fetch, XHR, WebSocket and EventSource. In
 * the finished design network goes through Helm (`helm.fetch`), which is where
 * the host list and secrets live. No inline script, because a built plugin has
 * none and an injected one is the commonest way a page that renders remote
 * data goes wrong.
 */
const PLUGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

const plugins = new Map<string, { dir: string; info: PluginInfo }>()

/** Reads every folder `HELM_PLUGINS` names. A folder that cannot be read is said, never skipped quietly. */
export function loadPlugins(spec: string | undefined): void {
  plugins.clear()
  for (const raw of (spec ?? '').split(delimiter)) {
    const dir = raw.trim()
    if (dir === '') continue
    try {
      const plugin = readPlugin(resolve(dir))
      if (plugins.has(plugin.id)) throw new Error(`a plugin with the id "${plugin.id}" is already loaded`)
      plugins.set(plugin.id, { dir: resolve(dir), info: plugin })
    } catch (error) {
      console.warn(`[plugins] ${dir}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function listPlugins(): PluginInfo[] {
  return [...plugins.values()].map((plugin) => plugin.info)
}

function readPlugin(dir: string): PluginInfo {
  const manifest = JSON.parse(readFileSync(resolve(dir, 'helm-plugin.json'), 'utf8')) as unknown
  if (!isRecord(manifest)) throw new Error('helm-plugin.json is not an object')
  if (manifest['apiVersion'] !== 1) throw new Error(`apiVersion ${String(manifest['apiVersion'])} is not supported`)

  const id = manifest['id']
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('id must be lowercase letters, digits and dashes')
  const name = text(manifest['name'], 'name')

  const surfaces = (value: unknown, field: string): Record<string, PluginSurface> => {
    if (value === undefined) return {}
    if (!isRecord(value)) throw new Error(`${field} must be an object`)
    const out: Record<string, PluginSurface> = {}
    for (const [key, surface] of Object.entries(value)) {
      if (!isRecord(surface)) throw new Error(`${field}.${key} must be an object`)
      out[key] = {
        title: text(surface['title'], `${field}.${key}.title`),
        url: pageUrl(id, dir, text(surface['entry'], `${field}.${key}.entry`))
      }
    }
    return out
  }

  const panels = surfaces(manifest['panels'], 'panels')
  const tabs = surfaces(manifest['tabs'], 'tabs')

  let rail: PluginInfo['rail'] = null
  if (manifest['rail'] !== undefined) {
    const value = manifest['rail']
    if (!isRecord(value)) throw new Error('rail must be an object')
    const panel = text(value['panel'], 'rail.panel')
    if (panels[panel] === undefined) throw new Error(`rail.panel "${panel}" is not one of the panels`)
    rail = { title: text(value['title'], 'rail.title'), panel }
  }

  const icon = manifest['icon'] === undefined ? null : iconData(dir, text(manifest['icon'], 'icon'))
  return { id, name, icon, rail, panels, tabs }
}

/** Past this an icon is not an icon. */
const ICON_MAX_BYTES = 64 * 1024

/**
 * The rail icon, inlined as a `data:` URL.
 *
 * Not a `helm-plugin://` URL like the pages: Helm draws the icon as a CSS mask
 * so it takes the rail's colours, and a mask image is fetched in CORS mode,
 * which a cross-origin URL on a scheme that answers no CORS fails silently -
 * measured, the icon came out blank. Reading it here once also means the rail
 * never waits on a plugin's folder to draw.
 */
function iconData(dir: string, entry: string): string {
  const target = resolve(dir, entry)
  if (!isInside(dir, target)) throw new Error(`icon ${entry} is outside the plugin folder`)
  const type = { '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(target).toLowerCase()]
  if (type === undefined) throw new Error('icon must be an .svg or a .png')
  let bytes: Buffer
  try {
    bytes = readFileSync(target)
  } catch {
    throw new Error(`icon ${entry} does not exist`)
  }
  if (bytes.length > ICON_MAX_BYTES) throw new Error(`icon ${entry} is over ${String(ICON_MAX_BYTES / 1024)} KB`)
  return `data:${type};base64,${bytes.toString('base64')}`
}

/** A file inside the plugin's folder, as the URL its frame loads. */
function pageUrl(id: string, dir: string, entry: string): string {
  const target = resolve(dir, entry)
  if (!isInside(dir, target)) throw new Error(`${entry} is outside the plugin folder`)
  try {
    if (!statSync(target).isFile()) throw new Error()
  } catch {
    throw new Error(`${entry} does not exist - has the plugin been built?`)
  }
  const path = entry.split(/[\\/]/).filter((part) => part !== '' && part !== '.').map(encodeURIComponent)
  return `${PLUGIN_SCHEME}://${id}/${path.join('/')}`
}

/**
 * Serves a plugin's folder and nothing else on the disk.
 *
 * The host names the plugin, so a frame can only address the folder of a
 * plugin Helm loaded; the containment check then refuses `..` out of it.
 */
export function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }
    const plugin = plugins.get(url.hostname)
    if (plugin === undefined) return new Response('Not found', { status: 404 })

    const rel = url.pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part))
      .join(sep)
    const target = resolve(plugin.dir, rel)
    if (rel === '' || !isInside(plugin.dir, target)) return new Response('Forbidden', { status: 403 })

    let bytes: Buffer
    try {
      if (!statSync(target).isFile()) return new Response('Not found', { status: 404 })
      bytes = readFileSync(target)
    } catch {
      return new Response('Not found', { status: 404 })
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': PLUGIN_CSP,
        'x-content-type-options': 'nosniff',
        // A plugin under development is rebuilt underneath a running Helm.
        'cache-control': 'no-store'
      }
    })
  })
}

/**
 * Which process each frame in the window runs in, and what it costs.
 *
 * The spike's first question. A cross-origin iframe in its own process cannot
 * stall Helm's UI however long it spins; one that shares the window's process
 * stops Helm painting for as long as it does.
 */
export function pluginFrameReport(win: BrowserWindow | null): PluginFrameReport {
  if (win === null || win.isDestroyed()) return { chrome: process.versions['chrome'] ?? 'unknown', app: null, frames: [] }
  const memory = new Map(app.getAppMetrics().map((metric) => [metric.pid, metric.memory.workingSetSize]))
  const main = win.webContents.mainFrame
  return {
    chrome: process.versions['chrome'] ?? 'unknown',
    app: { osProcessId: main.osProcessId, memoryKb: memory.get(main.osProcessId) ?? null },
    frames: main.framesInSubtree
      .filter((frame) => frame !== main)
      .map((frame) => ({
        url: frame.url,
        origin: frame.origin,
        osProcessId: frame.osProcessId,
        memoryKb: memory.get(frame.osProcessId) ?? null
      }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`)
  return value
}
