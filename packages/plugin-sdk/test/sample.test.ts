import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateManifest } from '../src/manifest.js'
import { SAMPLE, SAMPLE_DIR } from './fixtures'

/**
 * The sample plugin (`examples/sample-plugin`) is the worked example authors
 * copy and the plugin Helm's end-to-end tests drive, so it is a version 2
 * plugin: its background a module the host runs, its pages and that module
 * calling `floti`. Its build is checked by `pnpm --filter @helm/sample-plugin
 * build`; these read what the build starts from.
 */

const SRC = join(SAMPLE_DIR, 'src')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.(ts|tsx|html)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

const read = (path: string): string => readFileSync(path, 'utf8')
const named = (path: string): string => relative(SRC, path).replaceAll('\\', '/')

/** Every import specifier in a module's source. */
function imports(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
}

describe('the sample plugin is a version 2 plugin', () => {
  it('validates at apiVersion 2 with a module for its background, beside every other surface', () => {
    const result = validateManifest(SAMPLE)
    if (!result.ok) throw new Error(`refused: ${result.errors.join('; ')}`)
    expect(result.warnings).toEqual([])
    expect(result.manifest.apiVersion).toBe(2)
    expect(result.manifest.background).toBe('dist/background/main.js')
    expect(Object.keys(result.manifest.panels)).toEqual(['main'])
    expect(Object.keys(result.manifest.tabs)).toEqual(['item'])
    expect(result.manifest.agent?.tools.map((tool) => tool.name)).toEqual(['list_items', 'create_item'])
  })

  it('builds its background from a module, not a page', () => {
    expect(existsSync(join(SRC, 'background', 'main.ts'))).toBe(true)
    expect(readdirSync(join(SRC, 'background')).filter((name) => name.endsWith('.html'))).toEqual([])
  })

  it('imports only its own files from its background, by relative path, as the host requires', () => {
    const background = join(SRC, 'background', 'main.ts')
    const specifiers = imports(read(background))
    expect(specifiers).not.toEqual([])
    expect(specifiers.filter((specifier) => !specifier.startsWith('./') && !specifier.startsWith('../'))).toEqual([])
    // And what it imports holds nothing but types from outside.
    for (const specifier of specifiers) {
      const file = join(SRC, 'background', `${specifier}.ts`)
      const outside = imports(read(file)).filter((name) => !name.startsWith('.'))
      for (const name of outside) expect(read(file)).toMatch(new RegExp(`import type [^\\n]*['"]${name}['"]`))
    }
  })

  it('calls floti from every page and the background, and never the version 1 bridge', () => {
    const files = sources(SRC)
    const scripts = files.filter((file) => !file.endsWith('.html'))
    expect(scripts.map(named)).toEqual(expect.arrayContaining(['background/main.ts', 'panels/main.tsx', 'tabs/item.tsx', 'lib/api.ts']))
    for (const file of ['background/main.ts', 'panels/main.tsx', 'tabs/item.tsx', 'lib/api.ts']) {
      expect(read(join(SRC, file)), file).toMatch(/\bfloti\./)
    }
    // `helm-` class names are the primitives stylesheet's, not the bridge.
    const bridgeUses = files.filter((file) => /\bhelm\.[a-z]|window\.helm\b|\bvoid helm\b/.test(read(file))).map(named)
    expect(bridgeUses).toEqual([])
  })
})
