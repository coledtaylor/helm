import { realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/**
 * An absolute path as the disk resolves it: every link followed and every 8.3
 * alias spelled out. A path that does not exist - a file the session deleted,
 * a folder not made yet - resolves through its deepest ancestor that does,
 * with the rest appended as written.
 *
 * Never the path as written: a root reached through a link (macOS's temporary
 * folder is under /var, which is /private/var) or a short name (a Windows
 * runner's TEMP is C:\Users\RUNNER~1) resolves, so a missing file under it
 * compared unresolved would look like it was outside the project - and a
 * missing file behind a junction out of the project would look like it was in.
 */
function realPath(path: string): string {
  const rest: string[] = []
  for (let at = path; ; ) {
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
      const parent = dirname(at)
      if (parent === at) return path
      rest.unshift(basename(at))
      at = parent
    }
  }
}

/**
 * Whether `path` is inside `root`, before and after links are resolved: what
 * the Files view's hand-off to VS Code checks before it hands a path on.
 *
 * Both, because a path spelled inside the project can be a junction out of it
 * - an overlay shim's subdirectories are junctions into other repositories -
 * and a hand-off scoped to a project must not quietly reach the rest of the
 * disk. The resolved check resolves both sides, the root and the path, the
 * same way.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const inside = (base: string, target: string): boolean => {
    const rel = relative(base, target)
    return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith(sep))
  }
  const base = resolve(root)
  const target = resolve(path)
  return inside(base, target) && inside(realPath(base), realPath(target))
}
