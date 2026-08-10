import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { insertConfigSnapshot, readConfigSnapshot } from '../store/config'
import type { Store } from '../store/db'
import type {
  ConfigFileContent,
  ConfigWriteReason,
  WriteConfigRequest,
  WriteConfigResult
} from '../types'

/**
 * Reading and replacing a configuration file, safely.
 *
 * Three rules, in this order, and all three are acceptance criteria rather than
 * taste:
 *
 *   1. Nothing is written outside a configuration file. The console addresses
 *      files by absolute path, which means a bug upstream could address any
 *      file on the machine; `assertWritable` is the floor under that.
 *   2. Nothing is written when the bytes on disk are not the bytes the editor
 *      was based on. That is an external edit, and clobbering it silently is
 *      the failure criterion 6 is about.
 *   3. Nothing is written until the previous bytes are in the database. The
 *      snapshot goes first and a failure to take it aborts the write, so
 *      "every write has a snapshot" holds even when the disk write then fails.
 */

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * A file's current state.
 *
 * The hash is over the bytes on disk, not over the decoded string, so it
 * survives a round trip through an editor that would otherwise normalise line
 * endings - and a CRLF file edited to LF genuinely *is* a different file, which
 * is what a conflict check has to notice.
 */
export function readConfigFileContent(path: string): ConfigFileContent {
  const absolute = resolve(path)
  let stat
  try {
    stat = statSync(absolute)
  } catch {
    return {
      path: absolute,
      exists: false,
      content: '',
      hash: '',
      size: 0,
      mtimeMs: 0,
      binary: false
    }
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(absolute)
  } catch {
    return {
      path: absolute,
      exists: true,
      content: '',
      hash: '',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      binary: true
    }
  }

  const content = bytes.toString('utf8')
  // A NUL byte, or a round trip that does not reproduce the bytes, means this
  // is not text and the editor must not offer to rewrite it as if it were.
  const binary = bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)

  return {
    path: absolute,
    exists: true,
    content: binary ? '' : content,
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    binary
  }
}

/**
 * Refuses a path that is not configuration.
 *
 * Under a `.claude` directory, or a `CLAUDE.md` / `.mcp.json` beside one, and
 * inside the scope it claims to belong to. The scope check is what stops a
 * crafted request from using one scope's snapshot history to write into
 * another's tree.
 */
export function assertWritable(scopePath: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`Refusing to write a relative path: ${path}`)
  const absolute = resolve(path)
  const scope = resolve(scopePath)

  const rel = relative(scope, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing to write ${absolute}: it is not inside ${scope}.`)
  }

  const segments = rel.split(sep)
  const name = segments.at(-1) ?? ''
  const inClaudeDir =
    segments.includes('.claude') ||
    // The user scope's base directory *is* `.claude`, so nothing in the
    // relative path names it.
    scope.split(sep).at(-1) === '.claude'
  const isLooseConfig =
    segments.length === 1 && (name.toLowerCase() === 'claude.md' || name === '.mcp.json')

  if (!inClaudeDir && !isLooseConfig) {
    throw new Error(
      `Refusing to write ${absolute}: only files under a .claude directory, ` +
        'a CLAUDE.md, or a .mcp.json are configuration.'
    )
  }
}

/** The snapshot key: relative to the scope, forward-slashed, stable per file. */
export function snapshotKey(scopePath: string, path: string): string {
  return relative(resolve(scopePath), resolve(path)).split(sep).join('/')
}

/**
 * Takes the snapshot, then replaces the file.
 *
 * Returns rather than throws for the two outcomes a user causes - a conflicting
 * external edit and a write that would change nothing - because both are things
 * the editor has to *show*, and an exception carrying structured state back
 * across an IPC boundary arrives as a string.
 */
export function writeConfigFile(store: Store, req: WriteConfigRequest): WriteConfigResult {
  assertWritable(req.scopePath, req.path)
  const absolute = resolve(req.path)
  const current = readConfigFileContent(absolute)

  if (current.binary) {
    return {
      ok: false,
      file: current,
      snapshotId: null,
      unchanged: false,
      error: 'That file is not text, so Helm will not rewrite it.'
    }
  }

  // An editor that was opened on a file which has since changed underneath it.
  // `expectedHash === null` means "I believe this file does not exist", so a
  // file that has appeared since is a conflict too.
  const expected = req.expectedHash
  const disagrees = expected === null ? current.exists : current.hash !== expected
  if (disagrees) {
    return {
      ok: false,
      file: current,
      snapshotId: null,
      unchanged: false,
      conflict: {
        onDiskHash: current.hash,
        onDiskContent: current.content,
        mtimeMs: current.mtimeMs
      }
    }
  }

  if (current.exists && current.content === req.content) {
    // Nothing is written, so nothing needs a snapshot. Reported rather than
    // treated as a success, so the console can say "no change" instead of
    // adding a version that is identical to the one before it.
    return { ok: true, file: current, snapshotId: null, unchanged: true }
  }

  const reason: ConfigWriteReason = current.exists ? req.reason : 'create'
  const snapshotId = insertConfigSnapshot(store, {
    scopePath: resolve(req.scopePath),
    filePath: snapshotKey(req.scopePath, absolute),
    content: current.exists ? current.content : '',
    contentHash: current.exists ? current.hash : hashContent(''),
    reason
  })

  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, req.content, 'utf8')

  return {
    ok: true,
    file: readConfigFileContent(absolute),
    snapshotId,
    unchanged: false
  }
}

/**
 * Puts a snapshot's bytes back, taking a snapshot of what is there first.
 *
 * The restore is itself a write, so it is snapshotted like any other - undoing
 * an undo is a thing people do, and a history that loses the state you restored
 * *from* is a history that can only go one way.
 *
 * A `create` snapshot records a file that did not exist, and restoring one
 * removes the file rather than leaving an empty one behind. Writing zero bytes
 * would be a different outcome from the one being restored: a `settings.json`
 * that is empty is a parse error, where a `settings.json` that is absent is a
 * layer the CLI skips.
 */
export function restoreConfigSnapshot(
  store: Store,
  id: number,
  filePath: string
): WriteConfigResult {
  const snapshot = readConfigSnapshot(store, id)
  if (!snapshot) {
    return {
      ok: false,
      file: readConfigFileContent(filePath),
      snapshotId: null,
      unchanged: false,
      error: 'That version is no longer in the snapshot history.'
    }
  }

  assertWritable(snapshot.scopePath, filePath)
  const absolute = resolve(filePath)
  const current = readConfigFileContent(absolute)

  if (snapshot.reason === 'create') {
    if (!current.exists) {
      return { ok: true, file: current, snapshotId: null, unchanged: true }
    }
    const snapshotId = insertConfigSnapshot(store, {
      scopePath: snapshot.scopePath,
      filePath: snapshot.filePath,
      content: current.content,
      contentHash: current.hash,
      reason: 'restore'
    })
    rmSync(absolute, { force: true })
    return {
      ok: true,
      file: readConfigFileContent(absolute),
      snapshotId,
      unchanged: false
    }
  }

  // Restoring goes through the normal write, which means it gets the same
  // snapshot and the same guard rails. `expectedHash` is the file as it is
  // right now, because the user is deliberately discarding it.
  return writeConfigFile(store, {
    scopePath: snapshot.scopePath,
    path: absolute,
    content: snapshot.content,
    expectedHash: current.exists ? current.hash : null,
    reason: 'restore'
  })
}
