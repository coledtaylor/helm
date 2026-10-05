// @ts-check
/**
 * A plugin folder checked the way Helm checks it when it loads one: the
 * manifest read and validated, every file it names found inside the folder
 * (links followed, so a junction cannot reach outside it), and the icon's
 * size. What `helm-plugin validate` runs.
 *
 * Node only: it reads the disk. The validator it calls is the one Helm runs.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ICON_MAX_BYTES, manifestFiles, validateManifest } from './manifest.js'

export const MANIFEST_FILE = 'helm-plugin.json'

/** A manifest is a page of JSON. Past this it is something else. */
export const MANIFEST_MAX_BYTES = 256 * 1024

/**
 * @param {string} folder
 * @returns {import('./folder').FolderCheck}
 */
export function checkPluginFolder(folder) {
  /** @type {string} */
  let dir
  try {
    dir = realpathSync.native(resolve(folder))
    if (!statSync(dir).isDirectory()) return failed(`${folder} is not a folder`)
  } catch {
    return failed(`${folder} does not exist`)
  }

  /** @type {unknown} */
  let raw
  const file = join(dir, MANIFEST_FILE)
  try {
    if (statSync(file).size > MANIFEST_MAX_BYTES) return failed(`${MANIFEST_FILE} is larger than a manifest can be`)
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    const missing = /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
    return failed(
      missing
        ? `there is no ${MANIFEST_FILE} in ${folder}`
        : `${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const result = validateManifest(raw)
  if (!result.ok) return { ok: false, dir, errors: result.errors, warnings: result.warnings, manifest: null }

  /** @type {string[]} */
  const errors = []
  for (const { field, path } of manifestFiles(result.manifest)) {
    const target = resolveInside(dir, path)
    if (target === null) {
      errors.push(`${field}: ${path} does not exist${/\.html?$/i.test(path) ? ' - has the plugin been built?' : ''}`)
      continue
    }
    if (target === 'outside') {
      errors.push(`${field}: ${path} is outside the plugin folder`)
      continue
    }
    if (field === 'icon' && statSync(target).size > ICON_MAX_BYTES) {
      errors.push(`icon: ${path} is over ${String(ICON_MAX_BYTES / 1024)} KB`)
    }
  }
  return errors.length > 0
    ? { ok: false, dir, errors, warnings: result.warnings, manifest: result.manifest }
    : { ok: true, dir, errors: [], warnings: result.warnings, manifest: result.manifest }

  /**
   * @param {string} message
   * @returns {import('./folder').FolderCheck}
   */
  function failed(message) {
    return { ok: false, dir: null, errors: [message], warnings: [], manifest: null }
  }
}

/**
 * A path under `dir` as the file it really is, `'outside'` when it resolves
 * out of the folder, or null when there is no such file.
 *
 * @param {string} dir
 * @param {string} entry
 * @returns {string | 'outside' | null}
 */
export function resolveInside(dir, entry) {
  const lexical = resolve(dir, entry)
  if (!isInside(dir, lexical)) return 'outside'
  /** @type {string} */
  let real
  try {
    real = realpathSync.native(lexical)
    if (!statSync(real).isFile()) return null
  } catch {
    return null
  }
  return isInside(dir, real) ? real : 'outside'
}

/**
 * @param {string} dir
 * @param {string} target
 */
function isInside(dir, target) {
  const rel = relative(dir, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
