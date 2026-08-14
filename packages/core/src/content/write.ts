import { isAbsolute, relative, resolve, sep } from 'node:path'
import { restoreSnapshot, writeSnapshottedFile } from '../config/write'
import type { Store } from '../store/db'
import type { WriteConfigRequest, WriteConfigResult } from '../types'
import { contentFileKind } from './roots'

/**
 * Saving a note goes through the config console's write, not beside it.
 *
 * Everything that makes a config save safe - the snapshot taken before the
 * bytes are touched, the write aborted if the snapshot cannot be taken, the
 * refusal when the file on disk is not the file the editor was opened on, the
 * refusal to rewrite something that is not text - is the same set of
 * guarantees a note wants. Reimplementing them here would produce a second
 * write path with a second set of bugs and one undo history that only covers
 * half of them.
 *
 * So the only new thing in this file is the *guard*: which paths this surface
 * is allowed to write. Configuration is `assertWritable`'s business; content is
 * this one's.
 */

/**
 * Directories that are never content, whatever they contain.
 *
 * `repos` is the important one: a harness scope contains whole repositories,
 * each of which is a scope in its own right, and a save that reached into one
 * through the harness's snapshot history would file the version under the wrong
 * scope - which is the same failure `assertWritable`'s scope check exists to
 * prevent, one level up.
 */
const FORBIDDEN = new Set([
  'repos',
  'node_modules',
  '.git',
  'out',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  '.turbo'
])

export function assertContentWritable(scopePath: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`Refusing to write a relative path: ${path}`)
  const absolute = resolve(path)
  const scope = resolve(scopePath)

  const rel = relative(scope, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write ${absolute}: it is not inside ${scope}.`)
  }

  const segments = rel.split(sep)
  for (const segment of segments.slice(0, -1)) {
    if (FORBIDDEN.has(segment.toLowerCase())) {
      throw new Error(`Refusing to write ${absolute}: ${segment} is not content.`)
    }
  }

  // A kind decides how a file opens, and here it decides whether it may be
  // written: everything the viewer can *read* as text it may also save, source
  // included - a `tools/` script is a file the agent wrote and fixing a typo in
  // it should not mean a detour through Explorer. `binary` is the one refusal,
  // and it is the same refusal the config write makes for the same reason:
  // Helm will not rewrite bytes it cannot read.
  const name = segments.at(-1) ?? ''
  if (contentFileKind(name) === 'binary') {
    throw new Error(
      `Refusing to write ${absolute}: the content viewer edits text, not binary files.`
    )
  }
}

/** The content viewer's save. Same snapshot table, same conflict check. */
export function writeContentFile(store: Store, req: WriteConfigRequest): WriteConfigResult {
  return writeSnapshottedFile(store, req, assertContentWritable)
}

export function restoreContentSnapshot(
  store: Store,
  id: number,
  filePath: string
): WriteConfigResult {
  return restoreSnapshot(store, id, filePath, assertContentWritable)
}
