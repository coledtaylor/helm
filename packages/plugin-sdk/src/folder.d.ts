import type { NormalizedManifest } from './manifest'

export const MANIFEST_FILE: 'helm-plugin.json'
export const MANIFEST_MAX_BYTES: number

/**
 * A plugin folder, checked as Helm checks it on load. `dir` is the folder with
 * links resolved, or null when it could not be read. `manifest` is set when
 * the manifest itself passed, even if a file it names is missing.
 */
export interface FolderCheck {
  ok: boolean
  dir: string | null
  errors: string[]
  warnings: string[]
  manifest: NormalizedManifest | null
}

/** Reads, validates and checks the files of a plugin folder. Node only. */
export function checkPluginFolder(folder: string): FolderCheck

/** A path under `dir` as the file it really is, `'outside'` when it leaves the folder, or null when there is none. */
export function resolveInside(dir: string, entry: string): string | 'outside' | null
