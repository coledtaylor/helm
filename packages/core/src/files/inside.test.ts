import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isInsideRoot } from './inside'

/**
 * A link to a folder, of the kind overlays make: a junction on Windows, a
 * symbolic link on macOS and Linux (Node ignores the `'junction'` type there).
 */
const linkFolder = (link: string, target: string): void => symlinkSync(target, link, 'junction')

/** Removes a folder link without walking into it. */
function unlinkFolder(link: string): void {
  try {
    unlinkSync(link)
  } catch {
    rmdirSync(link)
  }
}

/**
 * The 8.3 alias Windows keeps for an existing path, such as
 * `C:\Users\RUNNER~1` for a long user name - or null off Windows, and on a
 * volume that keeps no short names. A GitHub Windows runner's TEMP is spelled
 * this way.
 */
function shortPath(path: string): string | null {
  if (process.platform !== 'win32') return null
  const run = spawnSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  const short = run.status === 0 ? run.stdout.trim() : ''
  return short !== '' && short !== path ? short : null
}

let root: string

beforeEach(() => {
  // A space in the path, as every Helm fixture has: quoting is where paths break.
  root = mkdtempSync(join(tmpdir(), 'helm inside-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isInsideRoot', () => {
  it('takes a path under the root, missing or not, and refuses one above it', () => {
    expect(isInsideRoot(root, root)).toBe(true)
    expect(isInsideRoot(root, join(root, 'a', 'b.txt'))).toBe(true)
    expect(isInsideRoot(root, join(root, '..', 'x'))).toBe(false)
  })

  it('takes a project reached through a link as the project, and refuses a link out of it', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'helm inside elsewhere-'))
    const linked = join(elsewhere, 'linked project')
    const escape = join(root, 'escape')
    try {
      linkFolder(linked, root)
      expect(isInsideRoot(linked, join(linked, 'new', 'b.txt'))).toBe(true)

      mkdirSync(join(elsewhere, 'outside'))
      linkFolder(escape, join(elsewhere, 'outside'))
      expect(isInsideRoot(linked, join(linked, 'escape', 'gone.txt'))).toBe(false)
      expect(isInsideRoot(root, join(root, 'escape', 'gone.txt'))).toBe(false)
    } finally {
      for (const link of [linked, escape]) {
        try {
          unlinkFolder(link)
        } catch {
          // Not made before the failure.
        }
      }
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform === 'win32')('takes a project named by its 8.3 alias as the project', ({ skip }) => {
    const short = shortPath(root)
    if (short === null) return skip('this volume keeps no 8.3 names')
    expect(isInsideRoot(short, join(short, 'new', 'b.txt'))).toBe(true)
  })
})
