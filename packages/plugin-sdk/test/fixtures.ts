import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Manifests the tests share: the two that ship, and the smallest that loads. */

export const SDK_DIR = fileURLToPath(new URL('..', import.meta.url))

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

/** The sample plugin's folder: a version 2 plugin with every surface, and what Helm's own tests drive. */
export const SAMPLE_DIR = join(SDK_DIR, '..', '..', 'examples', 'sample-plugin')

/** The sample plugin's manifest. */
export const SAMPLE = readJson(join(SAMPLE_DIR, 'helm-plugin.json'))

/** What `helm-plugin create` writes. */
export const TEMPLATE = readJson(join(SDK_DIR, 'template', 'helm-plugin.json'))

export const MINIMAL = { apiVersion: 1, id: 'minimal', name: 'Minimal' }
