import { rmdirSync, symlinkSync, unlinkSync } from 'node:fs'

/**
 * A link to a folder, of the kind overlays make: a junction on Windows, which
 * needs no elevation, and a symbolic link on macOS and Linux, where Node
 * ignores the `'junction'` type.
 */
export function linkFolder(link: string, target: string): void {
  symlinkSync(target, link, 'junction')
}

/** Removes a folder link without walking into it. */
export function unlinkFolder(link: string): void {
  try {
    unlinkSync(link)
  } catch {
    rmdirSync(link)
  }
}
