import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Frame, type Page } from '@playwright/test'
import { addPluginFolder, openStore } from '@helm/core'
import { startSampleServer, type SampleServer } from '../../../examples/sample-plugin/server.mjs'
import { repoRoot, type World } from '../test/world'

/**
 * The sample plugin (`examples/sample-plugin`), as the end-to-end tests drive
 * it: a copy in the world, pointed at a sample server of its own.
 *
 * A copy rather than the example itself, for two reasons. Its manifest names
 * the server's origin, and the server here is on whatever port was free; and
 * the copy sits under a path with a space in it, which is where a plugin
 * folder on Windows will be. The `dist/` it copies is built by `test:e2e`
 * before the app is.
 */

export const TOKEN = 'e2e-token-7316'

export interface SampleFixture {
  /** The plugin's folder in the world. */
  dir: string
  server: SampleServer
}

/** Writes a copy of the sample plugin into `world` that reads from `server`, and registers it. */
export function installSample(world: World, server: SampleServer, folder = 'sample plugin'): string {
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
  registerPlugin(world, dir)
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

export function startServer(): Promise<SampleServer> {
  return startSampleServer({ token: TOKEN })
}

/** The plugin page at `path` (`dist/panels/main.html`), once the window has framed it. */
export async function pluginFrame(ui: Page, path: string, plugin = 'sample'): Promise<Frame> {
  const url = `helm-plugin://${plugin}/${path}`
  let found: Frame | undefined
  await expect
    .poll(async () => {
      found = ui.frames().find((frame) => frame.url().startsWith(url))
      if (found === undefined) return false
      // Loaded far enough that Helm's bridge is on the page.
      return found.evaluate(() => typeof (window as unknown as { helm?: unknown }).helm === 'object').catch(() => false)
    })
    .toBe(true)
  return found as Frame
}
