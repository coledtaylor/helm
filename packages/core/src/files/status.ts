import { relative, resolve, sep } from 'node:path'
import type { FilesStatus, GitFileState } from '../types'
import { repoRootOf } from '../content/filetree'
import { runGit } from './git'

/**
 * What git says about every changed path under a project, for the Files tree.
 *
 * One `git status --porcelain=v2 -z` per refresh, limited to the project's own
 * subtree with a `.` pathspec, so a project that is a folder inside a larger
 * repository pays for its own files and not the repository's. The answer is
 * keyed by project-relative, forward-slashed path - the key the tree's
 * listings already use.
 */

/** Everything after the `n`th space - porcelain v2 puts the path last, and a path may hold spaces. */
function afterSpaces(record: string, n: number): string {
  let at = -1
  for (let k = 0; k < n; k += 1) {
    at = record.indexOf(' ', at + 1)
    if (at < 0) return ''
  }
  return record.slice(at + 1)
}

/** An ordinary changed entry's state, from its two-letter XY field. */
function stateOf(xy: string): GitFileState {
  const index = xy[0] ?? '.'
  const tree = xy[1] ?? '.'
  if (index === 'A' || tree === 'A') return 'added'
  if (index === 'D' || tree === 'D') return 'deleted'
  return 'modified'
}

/**
 * Parses `git status --porcelain=v2 -z` into project-relative paths.
 *
 * `prefix` is the project's own path inside the repository, forward-slashed,
 * `''` when the project is the repository. Paths outside it are dropped and the
 * prefix is cut off the rest. Compared without case, because git writes the
 * index's spelling of a path and Windows will have handed the project's path to
 * Helm in whatever case it was typed.
 *
 * A rename's record is followed by a second NUL-terminated record holding the
 * path it came from, which is consumed rather than read as an entry of its own.
 * An untracked directory - a nested repository is the usual one - ends in `/`,
 * which is dropped so the tree can look it up by its own name.
 */
export function parseStatusZ(stdout: string, prefix: string): Record<string, GitFileState> {
  const out: Record<string, GitFileState> = {}
  const lowerPrefix = prefix === '' ? '' : `${prefix.toLowerCase()}/`
  const records = stdout.split('\0')

  const add = (path: string, state: GitFileState): void => {
    const clean = path.endsWith('/') ? path.slice(0, -1) : path
    if (clean === '') return
    if (lowerPrefix !== '') {
      if (!clean.toLowerCase().startsWith(lowerPrefix)) return
      out[clean.slice(lowerPrefix.length)] = state
      return
    }
    out[clean] = state
  }

  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!
    if (record === '' || record.startsWith('#')) continue
    switch (record[0]) {
      case '1':
        add(afterSpaces(record, 8), stateOf(record.slice(2, 4)))
        break
      case '2':
        add(afterSpaces(record, 9), 'renamed')
        i += 1
        break
      case 'u':
        add(afterSpaces(record, 10), 'conflicted')
        break
      case '?':
        add(record.slice(2), 'untracked')
        break
      default:
        // `!` is an ignored path, which is only reported when asked for and is
        // not a change. Anything else is a format this build does not know,
        // and guessing at it would put a wrong letter in the tree.
        break
    }
  }
  return out
}

/** The project's path inside its repository, forward-slashed; `''` for the repository itself. */
export function prefixIn(repo: string, project: string): string {
  return relative(repo, project).split(sep).join('/')
}

/**
 * The status of every changed path under `root`.
 *
 * Three answers, and they are not merged (CLAUDE.md, "could not look"): a
 * project outside any repository has `repo: null` and nothing to report; a
 * repository git answered for has `files`; one git could not be asked about -
 * no `git` on the PATH, a corrupt index, a timeout - has `files: null` and the
 * sentence why. An empty map means clean, and only that.
 */
export async function readFilesStatus(root: string): Promise<FilesStatus> {
  const project = resolve(root)
  const repo = repoRootOf(project)
  if (repo === null) return { root: project, repo: null, files: {}, error: null }

  const run = await runGit(project, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=dirty',
    '--',
    '.'
  ])
  if (run.code !== null) {
    return {
      root: project,
      repo,
      files: null,
      error: run.code === 'ENOENT' ? 'git is not installed, or not on the PATH' : run.error
    }
  }
  return { root: project, repo, files: parseStatusZ(run.stdout, prefixIn(repo, project)), error: null }
}
