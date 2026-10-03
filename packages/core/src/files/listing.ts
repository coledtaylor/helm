import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FileListing } from '../types'
import { FALLBACK_SKIPPED_DIRS, repoRootOf } from '../content/filetree'
import { runGit } from './git'

/**
 * Every file in a project, for Ctrl+P.
 *
 * The repository's own answer where there is one: `git ls-files` lists the
 * tracked files and the untracked ones git does not ignore, which is exactly
 * the set a person means by "a file in this project" - no `node_modules`, no
 * build output, and nothing Helm has to decide about. Relative to the project
 * directory and limited to it, because `ls-files` answers for the directory it
 * runs in.
 *
 * Where there is no repository, or no git, a walk takes over with the tree's
 * built-in list of directories not to enter, and a ceiling. A walk has no other
 * way to end on a folder that turns out to hold a drive's worth of files, and a
 * list that stopped says it stopped (`truncated`) rather than passing for the
 * whole project.
 */

/** Past this many files the walk stops, and says so. */
export const FILE_LIST_MAX = 50_000

export async function listProjectFiles(root: string): Promise<FileListing> {
  const project = resolve(root)
  if (repoRootOf(project) !== null) {
    const run = await runGit(project, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (run.code === null) {
      const files = [...new Set(run.stdout.split('\0').filter((path) => path !== ''))]
      return { root: project, files, source: 'git', truncated: false, error: null }
    }
    // A repository git could not list - a corrupt index, a timeout - is still
    // a folder that can be walked. The error rides along so the list can say
    // why it is the walk's and not the repository's.
    return { ...walk(project), error: run.error }
  }
  return walk(project)
}

/**
 * Breadth-first, so a ceiling cuts off the deepest files rather than a whole
 * top-level folder. Links and junctions are listed as files and never entered:
 * an overlay's junction points into another repository, and one pointing at an
 * ancestor would never end.
 */
function walk(project: string): FileListing {
  const files: string[] = []
  const queue: string[] = ['']
  let truncated = false

  while (queue.length > 0 && !truncated) {
    const rel = queue.shift()!
    let entries
    try {
      entries = readdirSync(rel === '' ? project : join(project, rel), { withFileTypes: true })
    } catch {
      // Unreadable: a permissions wall or a folder deleted mid-walk. The rest
      // of the project is still worth listing.
      continue
    }
    for (const entry of entries) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase()
        if (name === '.git' || FALLBACK_SKIPPED_DIRS.has(name)) continue
        queue.push(path)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (files.length >= FILE_LIST_MAX) {
        truncated = true
        break
      }
      files.push(path)
    }
  }
  return { root: project, files, source: 'walk', truncated, error: null }
}
