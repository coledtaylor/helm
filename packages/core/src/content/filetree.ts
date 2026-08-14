import { execFile } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  ContentDirEntry,
  ContentDirListing,
  ContentIgnoreReason,
  ContentScope
} from '../types'
import { CURATED_SKIPPED_DIRS, contentExtension, contentFileKind } from './roots'

/**
 * An ordinary file tree over a scope, read one directory at a time.
 *
 * This is the other half of the split in SPEC 4.3. The curated view answers
 * "what is worth reading here", which is only a sensible question of a harness.
 * A project wants the other answer - **every file** - and the honest way to give
 * it is the way an editor does: list a directory when somebody opens it, and
 * never claim to have walked what has not been walked.
 *
 * Three rules, and each of them exists because the alternative lies about the
 * disk:
 *
 * **Lazy.** No `MAX_DEPTH`, no `MAX_FILES`. Those ceilings are right for the
 * curated view, which walks eagerly to decide what to offer and has to end; here
 * they would be a tree that silently stopped. A directory costs one `readdir`
 * at the moment it is expanded, so the cost is bounded by what the reader
 * opened rather than by what the repository contains.
 *
 * **Ignored paths are shown.** `node_modules/` and `dist/` are listed, greyed
 * and badged rather than hidden. The complaint this whole task answers is that
 * "nothing on screen says what was left out", and a tree that hid the two
 * largest directories in every repository would be making that same omission at
 * the top level. They are not *descended* - an ignored directory is a directory
 * the reader has been told about and Helm has been told not to read.
 *
 * **The repository decides what is ignored, not Helm.** `git check-ignore` is
 * asked, so nested `.gitignore` files, `.git/info/exclude`, `core.excludesFile`
 * and negations are all exactly right without a second implementation of a
 * format that is famously easy to get subtly wrong. Where there is no git -
 * no repository, or no `git` on the PATH - the built-in list takes over and the
 * listing says which of the two answered.
 */

/** One `git check-ignore` per expand is a user gesture; a hung one is not. */
const GIT_TIMEOUT_MS = 5_000

/**
 * What the tree hides when there is no repository to ask.
 *
 * The curated view's list, minus `repos/`. That exclusion is right for curation
 * and wrong here, and this is where that decision is recorded:
 *
 * A harness's `repos/` holds whole projects, each of which is a scope in its
 * own right. **Curation** drops it because a curated list is a short list of
 * this scope's own knowledge layer, and one that quietly contained six other
 * projects' notes would not be short and would make the scope switcher
 * meaningless. **The tree descends into it**, because the tree's entire promise
 * is "every file, lazily" - it costs one `readdir` to show that `repos/` is
 * there and another to open it, nothing is walked that nobody opened, and
 * refusing to open the one directory a harness keeps its actual work in would
 * be the same silent omission this surface exists to end. A reader who opens
 * `repos/helm/` in a harness tree gets what they asked for; nothing about that
 * competes with `helm` also being its own scope.
 */
const FALLBACK_SKIPPED_DIRS = new Set(
  [...CURATED_SKIPPED_DIRS].filter((name) => name !== 'repos')
)

/**
 * Always hidden from the fallback's point of view, and never descended in
 * either: `.git` is the repository's own database rather than its files, and
 * `git check-ignore` will not call it ignored because no `.gitignore` mentions
 * it.
 */
const ALWAYS_IGNORED = new Set(['.git'])

function slashed(from: string, path: string): string {
  return relative(from, path).split(sep).join('/')
}

/** The nearest ancestor holding a `.git`, or null. A worktree's is a file. */
function repoRootOf(start: string): string | null {
  let dir = resolve(start)
  for (;;) {
    try {
      statSync(join(dir, '.git'))
      return dir
    } catch {
      // Not here; keep climbing.
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Whether `git` can be run at all, remembered.
 *
 * A machine without git answers this once rather than paying a failed spawn per
 * directory expanded, and it is a fact about the machine rather than about a
 * scope - so it outlives any one listing.
 */
let gitUsable: boolean | null = null

/**
 * The subset of `names` this repository ignores.
 *
 * Directories are passed with a trailing slash because a `build/` pattern is
 * directory-only and `check-ignore` decides directory-ness from the string it
 * is given, not from the disk.
 *
 * The default index-aware behaviour is kept deliberately - no `--no-index`. A
 * tracked file that also matches an ignore rule is **not** ignored by that
 * repository, and greying it would be Helm disagreeing with git about git's own
 * rules.
 */
async function gitIgnoredNames(
  dir: string,
  entries: Array<{ name: string; directory: boolean }>
): Promise<Set<string> | null> {
  if (entries.length === 0) return new Set()
  if (gitUsable === false) return null

  // NUL-separated in as well as out, so a name with a newline in it cannot be
  // read as two paths. `execFile`'s promisified form has no `input`, so the
  // callback form is used and stdin written by hand.
  const probe = entries.map((entry) => (entry.directory ? `${entry.name}/` : entry.name)).join('\0')

  const answer = await new Promise<{ stdout: string; code: number | string | null }>((settle) => {
    const child = execFile(
      'git',
      ['check-ignore', '--stdin', '-z'],
      { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        settle({ stdout, code: err === null ? 0 : ((err as { code?: number | string }).code ?? -1) })
      }
    )
    child.stdin?.on('error', () => {
      // The process exited before the list was written. The callback above
      // still settles this promise with whatever it managed to say.
    })
    child.stdin?.end(probe)
  })

  // Exit 1 is "none of these are ignored", which is an answer rather than a
  // failure. Anything else - no git, not a repository, a corrupt index - is the
  // fallback's cue, and the listing says so on screen.
  if (answer.code === 0 || answer.code === 1) {
    gitUsable = true
    return new Set(
      answer.stdout
        .split('\0')
        .filter((line) => line !== '')
        .map((line) => line.replace(/\/$/, ''))
    )
  }
  if (answer.code === 'ENOENT') gitUsable = false
  return null
}

export interface ReadContentDirOptions {
  /**
   * Forces the built-in list instead of asking git. The driver uses it to
   * exercise the fallback on a machine that does have git; nothing in the app
   * passes it.
   */
  ignoreSource?: ContentIgnoreReason
}

/**
 * One directory of a scope, listed.
 *
 * `relPath` is scope-relative and forward-slashed; `''` is the scope directory
 * itself. A path that escapes the scope is refused rather than clamped - the
 * renderer names directories it was given, and a listing function that quietly
 * resolved `../../..` would be a directory browser for the whole disk reachable
 * from a pane that says it is scoped.
 */
export async function readContentDir(
  scope: ContentScope,
  relPath = '',
  options: ReadContentDirOptions = {}
): Promise<ContentDirListing> {
  const started = Date.now()
  const base = resolve(scope.path)
  const dir = relPath === '' ? base : resolve(base, relPath)

  const inside = relative(base, dir)
  if (inside.startsWith('..') || /^[A-Za-z]:/.test(inside)) {
    return {
      scopePath: base,
      relPath,
      entries: [],
      ignored: 0,
      ignoreSource: 'default',
      error: `${relPath} is outside this scope`,
      tookMs: Date.now() - started
    }
  }

  let raw
  try {
    raw = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    return {
      scopePath: base,
      relPath,
      entries: [],
      ignored: 0,
      ignoreSource: 'default',
      error: err instanceof Error ? err.message : String(err),
      tookMs: Date.now() - started
    }
  }

  const listed = raw
    .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, directory: entry.isDirectory(), link: entry.isSymbolicLink() }))

  const forced = options.ignoreSource
  const fromGit =
    forced === 'default' || repoRootOf(dir) === null ? null : await gitIgnoredNames(dir, listed)
  const ignoreSource: ContentIgnoreReason = fromGit === null ? 'default' : 'gitignore'

  const entries: ContentDirEntry[] = []
  let ignored = 0

  for (const entry of listed) {
    const path = join(dir, entry.name)
    const lower = entry.name.toLowerCase()

    const byRule =
      ALWAYS_IGNORED.has(lower) ||
      (fromGit === null
        ? entry.directory && FALLBACK_SKIPPED_DIRS.has(lower)
        : fromGit.has(entry.name))

    let size = 0
    let mtimeMs = 0
    try {
      // `lstat` semantics are what `withFileTypes` already gave; this is only
      // for the numbers, and a link whose target is gone still gets a row.
      const stat = statSync(path)
      size = stat.size
      mtimeMs = stat.mtimeMs
    } catch {
      // Deleted between the readdir and the stat, or a junction into nothing.
      // Still listed - it was there a moment ago and saying so is the point.
    }

    if (byRule) ignored++
    entries.push({
      name: entry.name,
      relPath: slashed(base, path),
      path,
      directory: entry.directory,
      link: entry.link,
      kind: entry.directory ? null : contentFileKind(entry.name),
      ext: entry.directory ? '' : contentExtension(entry.name).replace(/^\./, ''),
      size,
      mtimeMs,
      ignored: byRule,
      ignoredBy: byRule ? (ALWAYS_IGNORED.has(lower) ? 'default' : ignoreSource) : null
    })
  }

  // Directories first, then by name, the way every file tree on this platform
  // orders one. Not by mtime: the curated view sorts newest-first because a
  // notes directory is a journal, and a source tree is not.
  entries.sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  return {
    scopePath: base,
    relPath,
    entries,
    ignored,
    ignoreSource,
    error: null,
    tookMs: Date.now() - started
  }
}

/** The label a tree's root row wears: the scope directory's own name. */
export function contentTreeRootLabel(scope: ContentScope): string {
  return basename(resolve(scope.path)) || scope.label
}
