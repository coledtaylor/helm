import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import {
  ICON_MAX_BYTES,
  manifestFiles,
  validateManifest,
  type NormalizedManifest
} from '@helm/plugin-sdk/manifest'
import { isInside } from '../content'

/**
 * A plugin folder, read: the manifest validated, every file it names found
 * inside the folder, and the icon inlined.
 *
 * Read at every start and every reload, never cached across runs - a plugin is
 * developed in place, and the folder is the truth about it.
 */

export const MANIFEST_FILE = 'helm-plugin.json'

/** A manifest is a page of JSON. Past this it is something else. */
const MANIFEST_MAX_BYTES = 256 * 1024

export interface LoadedPlugin {
  /** The folder as the user registered it. */
  path: string
  /** The same folder with every link resolved: what containment is checked against. */
  dir: string
  manifest: NormalizedManifest
  /** A `data:` URL. See `iconData`. */
  icon: string | null
  warnings: string[]
}

export type LoadResult =
  | { ok: true; plugin: LoadedPlugin }
  | {
      ok: false
      error: string
      warnings: string[]
      /** What the manifest said its id and name were, when it said that much. */
      id: string | null
      name: string | null
    }

export function loadPluginFolder(path: string): LoadResult {
  let dir: string
  try {
    dir = realpathSync.native(resolve(path))
    if (!statSync(dir).isDirectory()) return failed('this is not a folder')
  } catch {
    return failed('the folder does not exist')
  }

  let raw: unknown
  try {
    const file = join(dir, MANIFEST_FILE)
    if (statSync(file).size > MANIFEST_MAX_BYTES) return failed(`${MANIFEST_FILE} is larger than a manifest can be`)
    raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return failed(
      missing
        ? `there is no ${MANIFEST_FILE} in this folder`
        : `${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const said = isRecord(raw) ? raw : {}
  const id = typeof said['id'] === 'string' ? said['id'] : null
  const name = typeof said['name'] === 'string' ? said['name'] : null

  const result = validateManifest(raw)
  if (!result.ok) return { ok: false, error: result.errors.join('; '), warnings: result.warnings, id, name }
  const { manifest, warnings } = result

  for (const { field, path: entry } of manifestFiles(manifest)) {
    const problem = fileProblem(dir, entry)
    if (problem !== null) return { ok: false, error: `${field}: ${problem}`, warnings, id, name }
  }

  let icon: string | null = null
  if (manifest.icon !== null) {
    try {
      icon = iconData(dir, manifest.icon)
    } catch (error) {
      return { ok: false, error: `icon: ${error instanceof Error ? error.message : String(error)}`, warnings, id, name }
    }
  }

  return { ok: true, plugin: { path, dir, manifest, icon, warnings } }

  function failed(error: string): LoadResult {
    return { ok: false, error, warnings: [], id: null, name: basename(path) }
  }
}

/**
 * A file the manifest names, resolved inside the folder - links followed, so a
 * junction in a plugin's folder cannot serve a file from outside it - or why
 * it is not one. A missing page is almost always a plugin that has not been
 * built, so it says so.
 */
export function fileProblem(dir: string, entry: string): string | null {
  const target = resolveInside(dir, entry)
  if (target === null) {
    const built = /\.html?$/i.test(entry) ? ' - has the plugin been built?' : ''
    return `${entry} does not exist${built}`
  }
  if (target === 'outside') return `${entry} is outside the plugin folder`
  return null
}

/**
 * A path under `dir` as the file it really is, `'outside'` when it resolves
 * out of the folder, or null when there is no such file.
 */
export function resolveInside(dir: string, entry: string): string | 'outside' | null {
  const lexical = resolve(dir, entry)
  if (!isInside(dir, lexical)) return 'outside'
  let real: string
  try {
    real = realpathSync.native(lexical)
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  return isInside(dir, real) ? real : 'outside'
}

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
  const target = resolveInside(dir, entry)
  if (target === null || target === 'outside') throw new Error(`${entry} is not a file in the plugin folder`)
  const type = extname(target).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png'
  const bytes = readFileSync(target)
  if (bytes.length > ICON_MAX_BYTES) throw new Error(`${entry} is over ${String(ICON_MAX_BYTES / 1024)} KB`)
  return `data:${type};base64,${bytes.toString('base64')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
