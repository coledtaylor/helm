import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveInside } from '../src/folder.js'

/**
 * `resolveInside`, which `helm-plugin validate` checks every file a manifest
 * names with: the file and the folder compared as the disk resolves them, so
 * a folder reached through a link holds its own files, and a link inside it
 * cannot reach out.
 */

let root: string
let dir: string
const links: string[] = []

/** A junction on Windows, a symbolic link on macOS and Linux. */
function linkFolder(link: string, target: string): void {
  symlinkSync(target, link, 'junction')
  links.push(link)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm sdk folder-'))
  dir = join(root, 'my plugin')
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'a b.html'), '')
})

afterEach(() => {
  // Links first, unlinked rather than walked.
  for (const link of links.splice(0)) {
    try {
      unlinkSync(link)
    } catch {
      rmdirSync(link)
    }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('resolveInside', () => {
  it('is the real file for a path inside the folder, and outside for one that climbs out', () => {
    writeFileSync(join(root, 'secret.txt'), '')
    expect(resolveInside(dir, 'dist/a b.html')).toBe(realpathSync.native(join(dir, 'dist', 'a b.html')))
    expect(resolveInside(dir, '../secret.txt')).toBe('outside')
    expect(resolveInside(dir, 'dist/nope.html')).toBeNull()
  })

  it('is the real file for a path inside a folder reached through a link, and still outside through a link out of it', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'x.js'), '')
    linkFolder(join(dir, 'escape'), elsewhere)
    const linked = join(root, 'linked plugin')
    linkFolder(linked, dir)

    expect(resolveInside(linked, 'dist/a b.html')).toBe(realpathSync.native(join(dir, 'dist', 'a b.html')))
    expect(resolveInside(linked, 'escape/x.js')).toBe('outside')
  })
})
