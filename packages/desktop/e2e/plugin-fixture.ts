import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Frame, type Page } from '@playwright/test'
import { addPluginFolder, openStore } from '@helm/core'
import { startSampleServer, type SampleServer } from '../../../examples/sample-plugin/server.mjs'
import { repoRoot, type World } from '../test/world'
import type { Helm } from './helm'

/**
 * The sample plugin (`examples/sample-plugin`), as the end-to-end tests drive
 * it: a copy in the world, pointed at a sample server of its own.
 *
 * A copy rather than the example itself, for two reasons. Its manifest names
 * the server's origin, and the server here is on whatever port was free; and
 * the copy sits under a path with a space in it, which is where a plugin
 * folder on Windows will be. The `dist/` it copies is built by `test:e2e`
 * before the app is.
 *
 * The sample is a version 2 plugin: its pages are on `floti-plugin://sample/`
 * with `window.floti`, and its background is a module the host runs, which no
 * window frames, so a test reads it through what it does (the badge, the
 * status bar item, a command's effect, a tool's answer). `installVersion1Plugin`
 * writes a small version 1 plugin beside it, whose page is on `helm-plugin://`
 * with `window.helm` and whose background page is a frame in the hidden plugin
 * window.
 */

export const TOKEN = 'e2e-token-7316'

export interface SampleFixture {
  /** The plugin's folder in the world. */
  dir: string
  server: SampleServer
}

/**
 * Writes a copy of the sample plugin into `world` that reads from `server`, and
 * registers it unless `register` is false, which leaves it for a test to add.
 */
export function installSample(world: World, server: SampleServer, folder = 'sample plugin', register = true): string {
  const source = join(repoRoot(), 'examples', 'sample-plugin')
  if (!existsSync(join(source, 'dist', 'panels', 'main.html'))) {
    throw new Error('examples/sample-plugin is not built: run `pnpm --filter @helm/sample-plugin build`')
  }
  const dir = join(world.root, 'plugins', folder)
  mkdirSync(dir, { recursive: true })
  for (const part of ['dist', 'programs', 'service', 'icon.svg']) {
    cpSync(join(source, part), join(dir, part), { recursive: true })
  }
  const manifest = JSON.parse(readFileSync(join(source, 'helm-plugin.json'), 'utf8')) as {
    network: string[]
    settings: Array<{ key: string; default?: unknown }>
  }
  manifest.network = [server.url]
  for (const setting of manifest.settings) if (setting.key === 'server') setting.default = server.url
  writeFileSync(join(dir, 'helm-plugin.json'), JSON.stringify(manifest, null, 2))
  if (register) registerPlugin(world, dir)
  return dir
}

/** A plugin folder in the plugins table, as Settings > Plugins > Add folder leaves it. */
export function registerPlugin(world: World, dir: string): void {
  const store = openStore({ file: join(world.dataDir, 'helm.db') })
  try {
    addPluginFolder(store, dir)
  } finally {
    store.close()
  }
}

/** The version 1 plugin `installVersion1Plugin` writes: its id, name, and the origin its pages are served on. */
export const CLASSIC = { id: 'classic', name: 'Classic', origin: 'helm-plugin://classic/' } as const

/**
 * Writes a small version 1 plugin into `world` and registers it: a rail panel
 * (`panel.html`) and a background page (`background.html`) that says it is
 * running in the status bar. Version 1 still loads beside version 2, and its
 * background page runs where version 1's always have, in Helm's hidden plugin
 * window, so this is what keeps that window covered.
 */
export function installVersion1Plugin(world: World): string {
  const dir = join(world.root, 'plugins', 'classic plugin')
  mkdirSync(dir, { recursive: true })
  const manifest = {
    apiVersion: 1,
    id: CLASSIC.id,
    name: CLASSIC.name,
    rail: { title: CLASSIC.name, panel: 'main' },
    panels: { main: { title: CLASSIC.name, entry: 'panel.html' } },
    background: 'background.html'
  }
  writeFileSync(join(dir, 'helm-plugin.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, 'panel.html'), '<!doctype html>\n<html><body><p>Classic</p></body></html>\n')
  writeFileSync(join(dir, 'background.html'), '<!doctype html>\n<html><body><script src="background.js"></script></body></html>\n')
  writeFileSync(join(dir, 'background.js'), "void helm.status.set({ text: 'Classic: running' })\n")
  registerPlugin(world, dir)
  return dir
}

/**
 * Runs `script` in the version 1 plugin's background page, a frame in Helm's
 * hidden plugin host window. A version 2 background has no frame to run in.
 */
export function inVersion1Background<T>(helm: Helm, script: string): Promise<T> {
  return helm.app.evaluate(
    async ({ BrowserWindow }, { script, url }) => {
      const host = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/plugin-host.html'))
      const frame = host?.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith(url))
      if (frame === undefined) throw new Error(`no background page at ${url}`)
      return (await frame.executeJavaScript(script)) as T
    },
    { script, url: `${CLASSIC.origin}background.html` }
  )
}

export function startServer(): Promise<SampleServer> {
  return startSampleServer({ token: TOKEN })
}

/**
 * The plugin page at `path` (`dist/panels/main.html`) on `origin`, once the
 * window has framed it and a pointer over it reaches it. The origin is the
 * sample's, a version 2 plugin's, unless a test names another.
 */
export async function pluginFrame(ui: Page, path: string, origin = 'floti-plugin://sample/'): Promise<Frame> {
  const url = `${origin}${path}`
  let found: Frame | undefined
  await expect
    .poll(async () => {
      found = ui.frames().find((frame) => frame.url().startsWith(url))
      if (found === undefined) return false
      // Loaded far enough that Helm's bridge is on the page: `floti` at
      // version 2, `helm` at version 1.
      return found
        .evaluate(() => {
          const page = window as unknown as { floti?: unknown; helm?: unknown }
          return typeof page.floti === 'object' || typeof page.helm === 'object'
        })
        .catch(() => false)
    })
    .toBe(true)
  await pointerReaches(found as Frame)
  return found as Frame
}

/**
 * Waits until a pointer over the page in `frame` reaches the page.
 *
 * A plugin page runs in a process of its own. For a moment after it is framed,
 * Chromium still routes a pointer over it to Helm's window, where it lands on
 * the `<iframe>` and the page never hears it, so a click made then is lost; on
 * a loaded machine the moment is long enough for a test to click in it. A move
 * the page itself hears is the sign that a click will reach it.
 */
async function pointerReaches(frame: Frame): Promise<void> {
  type Heard = Window & { pointerHeard?: boolean }
  await frame.evaluate(() => {
    window.addEventListener('pointermove', () => ((window as Heard).pointerHeard = true), { once: true })
  })
  let moves = 0
  await expect
    .poll(
      async () => {
        // A pointer that stays where it is sends no move, so each look moves it.
        moves += 1
        await frame.locator('body').hover({ position: { x: 1 + (moves % 2), y: 1 } })
        return frame.evaluate(() => (window as Heard).pointerHeard === true)
      },
      { message: `a pointer over ${frame.url()} never reached the page` }
    )
    .toBe(true)
}
