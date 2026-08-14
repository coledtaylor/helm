import { existsSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { insertConfigSnapshot } from '../store/config'
import type { Store } from '../store/db'
import type {
  ConfigFile,
  ConfigScope,
  CreateConfigResult,
  DeleteConfigResult,
  DeletedConfigFile,
  RenameConfigResult
} from '../types'
import {
  checkConfigName,
  configUnit,
  isRenamable,
  planConfigFile,
  renameRefusal,
  type CreatableKind
} from './names'
import { parseFrontmatter } from './validate'
import {
  assertWritable,
  readConfigFileContent,
  snapshotKey,
  writeSnapshottedFile,
  type WriteGuard
} from './write'

/**
 * Adding, renaming and removing an entry in a `.claude` tree.
 *
 * `write.ts` is one file's bytes being replaced. This is the other three things
 * a directory supports, and all three obey the same rule it does, which
 * CLAUDE.md states as the single exception to "`~/.claude` is Claude Code's and
 * Helm only reads it": **a snapshot row goes in before the file is touched, and
 * a failure to take it aborts.** The posture is not widened by any of them -
 * every path here goes through the same `assertWritable`, so the set of files
 * Helm can write is exactly what it was.
 *
 * Three consequences of that rule are worth stating before reading the code,
 * because each one is why something below is more roundabout than it looks:
 *
 *   1. **A rename is a copy and then a delete**, not `fs.rename`. A move made
 *      by the filesystem leaves no row anywhere, so the bytes at the old path
 *      would be unrecoverable and the bytes at the new one would have no
 *      history. Copying through `writeSnapshottedFile` gives the destination a
 *      `create` row (restoring it removes the file again) and the source a
 *      `rename` row (restoring it puts the bytes back). `.claude` files are
 *      kilobytes; the cost of copying them is not a consideration.
 *   2. **Nothing is removed until everything is recorded.** Snapshots for the
 *      whole set go in first, then the files come off the disk. A failure part
 *      way through the snapshots leaves the disk untouched.
 *   3. **A file Helm cannot read as text stops the whole operation.** The
 *      snapshot table holds text, so a binary bundled beside a `SKILL.md` cannot
 *      be recorded - and moving or deleting it anyway would be doing the one
 *      thing this file exists to prevent. It is refused by name, and the message
 *      says so.
 */

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** A scope-relative, forward-slashed path as an absolute one. */
function absolutePath(scope: ConfigScope, relPath: string): string {
  return resolve(join(scope.path, ...relPath.split('/')))
}

function relPathOf(scope: ConfigScope, path: string): string {
  return snapshotKey(scope.path, path)
}

/**
 * Removes directories that the operation emptied, from the deepest up.
 *
 * Renaming `/spec:plan` to `/plan` leaves `commands/spec/` behind with nothing
 * in it, and an empty namespace directory is a namespace the console still
 * lists as a path fragment on every file under it. Stops at the scope's
 * `.claude` directory, which is never removed however empty it gets: its
 * absence is what `ConfigScope.exists` reports, and a scope that vanished
 * because its last file was deleted would drop out of the switcher the user is
 * standing in.
 */
function pruneEmptyDirs(from: string, claudeDir: string): void {
  const stop = resolve(claudeDir)
  let dir = resolve(from)
  while (dir !== stop && dir.length > stop.length && dir.toLowerCase().startsWith(stop.toLowerCase())) {
    try {
      if (readdirSync(dir).length > 0) return
      rmdirSync(dir)
    } catch {
      // Held open by something else, or already gone. Either way the tree is
      // consistent and an empty directory is not worth failing an operation for.
      return
    }
    dir = dirname(dir)
  }
}

interface ReadFile {
  path: string
  content: string
  /** The hash of the bytes read, carried so the snapshot is over what was read. */
  hash: string
}

/**
 * Reads every file in a set, or says which one it will not touch.
 *
 * Done before anything is written or removed, so a set containing a binary is
 * refused whole rather than half-processed. The hash comes back with the bytes
 * rather than being taken again at snapshot time: two reads of a file being
 * written by something else can disagree, and the row has to describe the
 * content it stores.
 */
function readAll(
  scope: ConfigScope,
  paths: readonly string[]
): { files: ReadFile[]; error: string | null } {
  const files: ReadFile[] = []
  for (const path of paths) {
    const current = readConfigFileContent(path)
    if (!current.exists) {
      return {
        files: [],
        error: `${relPathOf(scope, path)} is no longer there. Re-read the scope and try again.`
      }
    }
    if (current.binary) {
      return {
        files: [],
        error:
          `${relPathOf(scope, path)} is not text, so Helm cannot record it before moving or ` +
          'removing it - and it will not touch bytes it cannot put back. Use Explorer for this one.'
      }
    }
    files.push({ path, content: current.content, hash: current.hash })
  }
  return { files, error: null }
}

/**
 * Records every file, then removes every file.
 *
 * The order is the guarantee. `insertConfigSnapshot` throwing part way through
 * leaves rows for the files it reached and *nothing* off the disk, which is the
 * recoverable failure; removing first and recording afterwards would make the
 * same fault unrecoverable.
 */
function snapshotThenRemove(
  store: Store,
  scope: ConfigScope,
  files: readonly ReadFile[],
  reason: 'rename' | 'delete',
  guard: WriteGuard
): DeletedConfigFile[] {
  for (const file of files) guard(scope.path, file.path)

  const rows: DeletedConfigFile[] = files.map((file) => ({
    path: file.path,
    relPath: relPathOf(scope, file.path),
    snapshotId: insertConfigSnapshot(store, {
      scopePath: resolve(scope.path),
      filePath: relPathOf(scope, file.path),
      content: file.content,
      contentHash: file.hash,
      reason
    })
  }))

  for (const file of files) rmSync(file.path, { force: true })
  for (const file of files) pruneEmptyDirs(dirname(file.path), scope.claudeDir)
  return rows
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Scaffolds a new entry of a given kind.
 *
 * The collision check is before the write and not merely implied by it. A
 * `SKILL.md` written into a directory that already holds one would be an edit
 * of somebody else's skill wearing the word "New", and the same request twice
 * in a row must be refused the second time rather than quietly reset the first.
 * The directory is what is checked for a skill, because the directory is the
 * name: `skills/think/` with no `SKILL.md` in it is still `think` taken.
 */
export function createConfigFile(
  store: Store,
  scope: ConfigScope,
  input: { kind: CreatableKind; name: string },
  guard: WriteGuard = assertWritable
): CreateConfigResult {
  const refuse = (error: string): CreateConfigResult => ({
    ok: false,
    path: null,
    relPath: null,
    snapshotId: null,
    error
  })

  const planned = planConfigFile({
    kind: input.kind,
    name: input.name,
    userScope: scope.kind === 'user'
  })
  if (!planned.ok || planned.plan === null) {
    return refuse(planned.error ?? 'That cannot be created here.')
  }
  const plan = planned.plan

  if (plan.dirRelPath !== null && existsSync(absolutePath(scope, plan.dirRelPath))) {
    return refuse(`${scope.label} already has a skill called ${plan.address}.`)
  }
  const target = absolutePath(scope, plan.relPath)
  if (existsSync(target)) {
    return refuse(`${plan.relPath} is already there. Open it instead of creating it.`)
  }

  const result = writeSnapshottedFile(
    store,
    {
      scopePath: scope.path,
      path: target,
      content: plan.content,
      // Null is "I believe this file does not exist", so a file that appeared
      // between the check above and this line is a conflict rather than a
      // silent overwrite.
      expectedHash: null,
      reason: 'create'
    },
    guard
  )

  if (!result.ok) {
    return refuse(
      result.conflict
        ? `${plan.relPath} appeared on disk while Helm was creating it, so nothing was written.`
        : (result.error ?? 'The write was refused.')
    )
  }

  return {
    ok: true,
    path: target,
    relPath: plan.relPath,
    snapshotId: result.snapshotId,
    error: null
  }
}

// ---------------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------------

/**
 * Makes a `name:` follow the rename that moved the file it is in.
 *
 * A skill's frontmatter `name` and its directory have to agree, and an agent's
 * has to name the agent - so a rename that moved the file and left it declaring
 * its old self has half-renamed the thing, which is the failure this scaffold's
 * own comment warns about at the other end.
 *
 * **Only when the declared name is exactly the old one.** A file whose
 * frontmatter says something else is not claiming to be the thing being
 * renamed, and rewriting it would be Helm editing a field the user set on
 * purpose. That condition is why this can be done at all without it counting as
 * a surprise edit - and the dialog states it before the button is pressed.
 */
function retitleFrontmatter(content: string, fromLeaf: string, toLeaf: string): string {
  const parsed = parseFrontmatter(content)
  if (parsed === null) return content
  if (parsed.fields.find((field) => field.key === 'name')?.value !== fromLeaf) return content

  // `endLine` is the 1-based line the closing fence is on, so the block is
  // everything between it and the opening one.
  const lines = content.split('\n')
  for (let i = 1; i < parsed.endLine - 1; i++) {
    const line = lines[i] ?? ''
    if (!/^name\s*:/.test(line)) continue
    lines[i] = `name: ${toLeaf}${line.endsWith('\r') ? '\r' : ''}`
    break
  }
  return lines.join('\n')
}

/** The last step of an address - a skill's directory, an agent's file name. */
function leafOf(name: string): string {
  return name.split('/').at(-1) ?? name
}

/**
 * Moves an entry to a new name.
 *
 * The two shapes are different and both are the criterion:
 *
 * - A **skill** is a directory. Its whole contents move, keeping their layout,
 *   into a sibling directory with the new name - so a skill that bundles a
 *   reference file arrives with it. The parent is kept rather than taken from
 *   the planner, because a nested `skills/vendor/thing` renamed must stay under
 *   `vendor` rather than being flattened to the top.
 * - A **command, agent or rule** is addressed by its whole path, so the new name
 *   *is* the new path: renaming `/spec:plan` to `/plan` moves
 *   `commands/spec/plan.md` to `commands/plan.md`, and the emptied `spec/` goes
 *   with it.
 */
export function renameConfigEntry(
  store: Store,
  scope: ConfigScope,
  files: readonly ConfigFile[],
  file: ConfigFile,
  name: string,
  guard: WriteGuard = assertWritable
): RenameConfigResult {
  const refuse = (error: string): RenameConfigResult => ({
    ok: false,
    path: null,
    relPath: null,
    moved: [],
    snapshotIds: [],
    frontmatterRenamed: false,
    error
  })

  if (!isRenamable(file.kind)) {
    return refuse(renameRefusal(file.kind) ?? 'That file cannot be renamed here.')
  }

  let moves: Array<{ from: string; to: string }>
  let addressedTo: string
  let newLeaf: string

  if (file.kind === 'skill') {
    const checked = checkConfigName('skill', name)
    if (!checked.ok) return refuse(checked.error ?? 'That name will not do.')
    const leaf = checked.segments[0] ?? ''
    const fromDir = dirname(resolve(file.path))
    const toDir = join(dirname(fromDir), leaf)

    if (resolve(toDir) === fromDir) return refuse(`It is already called ${leaf}.`)
    if (existsSync(toDir)) return refuse(`${scope.label} already has a skill called ${leaf}.`)

    const unit = configUnit(files, file)
    moves = unit.map((member) => ({
      from: resolve(member.path),
      to: join(toDir, relative(fromDir, resolve(member.path)))
    }))
    addressedTo = join(toDir, relative(fromDir, resolve(file.path)))
    newLeaf = leaf
  } else {
    const planned = planConfigFile({
      kind: file.kind as CreatableKind,
      name,
      userScope: scope.kind === 'user'
    })
    if (!planned.ok || planned.plan === null) {
      return refuse(planned.error ?? 'That name will not do.')
    }
    const to = absolutePath(scope, planned.plan.relPath)
    if (to === resolve(file.path)) return refuse(`It is already called ${planned.plan.address}.`)
    if (existsSync(to)) return refuse(`${planned.plan.relPath} is already there.`)
    moves = [{ from: resolve(file.path), to }]
    addressedTo = to
    newLeaf = leafOf(planned.plan.address.replace(/^\//, '').replace(/:/g, '/'))
  }

  const read = readAll(scope, moves.map((move) => move.from))
  if (read.error !== null) return refuse(read.error)

  /**
   * The addressed file's own `name:` follows it, for the two kinds that declare
   * one.
   *
   * Computed into a *separate* list rather than by editing what was read. The
   * rows that record the sources have to hold the bytes that were on disk, or
   * restoring a rename would give back a file somebody else's edit had already
   * been applied to.
   */
  const addressedFrom = resolve(file.path)
  const declaresName = file.kind === 'skill' || file.kind === 'agent'
  let frontmatterRenamed = false
  const contentFor = (source: ReadFile): string => {
    if (!declaresName || source.path !== addressedFrom) return source.content
    const retitled = retitleFrontmatter(source.content, leafOf(file.name), newLeaf)
    frontmatterRenamed = retitled !== source.content
    return retitled
  }

  // The destinations first. Every one is a real write with a `create` row
  // behind it, so an interrupted rename leaves files that can be un-created
  // rather than files nobody has a record of - and the sources are still there.
  const snapshotIds: number[] = []
  for (const [index, move] of moves.entries()) {
    const source = read.files[index]
    if (!source) return refuse('The set of files to move changed underneath the rename.')
    const written = writeSnapshottedFile(
      store,
      {
        scopePath: scope.path,
        path: move.to,
        content: contentFor(source),
        expectedHash: null,
        reason: 'create'
      },
      guard
    )
    if (!written.ok) {
      return refuse(
        `${relPathOf(scope, move.to)} could not be written, so the rename stopped. ` +
          `Nothing has been removed; ${String(index)} of ${String(moves.length)} files were copied.`
      )
    }
    if (written.snapshotId !== null) snapshotIds.push(written.snapshotId)
  }

  const removed = snapshotThenRemove(store, scope, read.files, 'rename', guard)
  snapshotIds.push(...removed.map((row) => row.snapshotId))

  return {
    ok: true,
    path: addressedTo,
    relPath: relPathOf(scope, addressedTo),
    moved: moves,
    snapshotIds,
    frontmatterRenamed,
    error: null
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Removes an entry, recording it first.
 *
 * The rows are ordinary per-file history: a `delete` snapshot holds the bytes
 * that were there, and `restoreConfigSnapshot` puts them back the same way it
 * would any other version - the file being absent is not a conflict, because
 * absent is what the restore was told to expect. So "undo this delete" and
 * "restore this version" are the same mechanism, and the confirmation says so
 * where the user is deciding rather than in a comment here.
 */
export function deleteConfigEntry(
  store: Store,
  scope: ConfigScope,
  files: readonly ConfigFile[],
  file: ConfigFile,
  guard: WriteGuard = assertWritable
): DeleteConfigResult {
  const unit = configUnit(files, file)
  const read = readAll(scope, unit.map((member) => resolve(member.path)))
  if (read.error !== null) return { ok: false, removed: [], error: read.error }

  return { ok: true, removed: snapshotThenRemove(store, scope, read.files, 'delete', guard), error: null }
}
