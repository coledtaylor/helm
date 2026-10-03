import { realpathSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { FileView } from '../types'
import { readConfigFileContent } from '../config/write'
import { readFileChanges } from './changes'

/**
 * One file, as the file view shows it: its text, how its lines end, and how it
 * stands against the last commit.
 *
 * Read-only by construction - there is no write beside this, because the file
 * view is for reading a file next to the session changing it, and editing it
 * is VS Code's job (one click away). A second writer racing an agent's edits
 * would be the one way this surface could do harm.
 */

/**
 * Past this a file is not read at all. The view is a textarea under a layer of
 * spans, and a 40 MB log in it is a frozen window; the pane says how large the
 * file is and offers VS Code and Explorer instead.
 */
export const FILE_VIEW_MAX_BYTES = 5 * 1024 * 1024

const realOrSelf = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` is inside `root`, before and after links are resolved.
 *
 * Both, for the reason the content tree checks both: a path spelled inside the
 * project can be a junction out of it - an overlay shim's subdirectories are
 * junctions into other repositories - and a file view scoped to a project must
 * not quietly become a reader for the rest of the disk.
 */
export function isInsideRoot(root: string, path: string): boolean {
  const inside = (base: string, target: string): boolean => {
    const rel = relative(base, target)
    return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel) && !rel.startsWith(sep))
  }
  const base = resolve(root)
  const target = resolve(path)
  return inside(base, target) && inside(realOrSelf(base), realOrSelf(target))
}

/** How the file's lines end. `null` for a file with one line or none. */
function lineEndings(text: string): FileView['eol'] {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf
  if (crlf === 0 && lf === 0) return null
  if (crlf === 0) return 'LF'
  if (lf === 0) return 'CRLF'
  return 'mixed'
}

export async function readFileView(root: string, path: string): Promise<FileView> {
  const base = resolve(root)
  const absolute = resolve(path)
  const relPath = relative(base, absolute).split(sep).join('/')
  const empty: FileView = {
    root: base,
    path: absolute,
    relPath,
    exists: false,
    size: 0,
    mtimeMs: 0,
    binary: false,
    tooLarge: false,
    content: '',
    eol: null,
    changes: { kind: 'unknown', reason: 'not read' },
    error: null
  }

  if (!isInsideRoot(base, absolute)) {
    return { ...empty, error: `${absolute} is not inside ${base}, and Helm reads only inside the project.` }
  }

  let stat
  try {
    stat = statSync(absolute)
  } catch {
    // Gone: deleted by the session, or renamed under the tab. Said, not thrown,
    // because the tab outlives the file and has to have something to show.
    return { ...empty, changes: await readFileChanges(absolute) }
  }
  if (stat.isDirectory()) return { ...empty, exists: true, error: 'That is a folder, not a file.' }

  const changes = await readFileChanges(absolute)
  if (stat.size > FILE_VIEW_MAX_BYTES) {
    return { ...empty, exists: true, size: stat.size, mtimeMs: stat.mtimeMs, tooLarge: true, changes }
  }

  const read = readConfigFileContent(absolute)
  // Line feeds only. A textarea normalises CRLF to LF in its value, so text
  // handed over with carriage returns would put every offset the editor
  // computes - go to line, the caret's column - one character further out per
  // line above it. What the file actually uses is reported in `eol`.
  const text = read.binary ? '' : read.content
  return {
    root: base,
    path: absolute,
    relPath,
    exists: read.exists,
    size: read.size,
    mtimeMs: read.mtimeMs,
    binary: read.binary,
    tooLarge: false,
    content: text.replace(/\r\n/g, '\n'),
    eol: read.binary ? null : lineEndings(text),
    changes,
    error: null
  }
}
