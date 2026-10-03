import type { FileChangeState, GitFileState, LineChanges } from '../types'

/**
 * What the Files view says about git, as pure functions over the shapes main
 * hands it. Browser-safe: the renderer imports these through
 * `@helm/core/types`, so nothing here may reach `node:`.
 */

/**
 * Every directory, project-relative, that holds a changed path somewhere below
 * it - so the tree can mark a folder without searching the whole status map for
 * every folder it draws. `''` is not included: the root is the whole tree, and a
 * mark on it would say nothing the letters below it do not.
 */
export function changedDirectories(files: Readonly<Record<string, GitFileState>>): Set<string> {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    let cut = path.lastIndexOf('/')
    while (cut > 0) {
      const dir = path.slice(0, cut)
      if (dirs.has(dir)) break
      dirs.add(dir)
      cut = dir.lastIndexOf('/')
    }
  }
  return dirs
}

/** The letter a changed file wears in the tree, as git's own short status writes it. */
export const GIT_STATE_LETTER: Record<GitFileState, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: '!'
}

/** The same, in words, for the hover text and a screen reader. */
export const GIT_STATE_LABEL: Record<GitFileState, string> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  untracked: 'Untracked',
  conflicted: 'Conflicted'
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`

/**
 * One line about how a file differs from the last commit, and whether that is
 * news - `marked` is true when the file view has lines to show for it. `short`
 * is the same fact for a pane too narrow for the sentence.
 *
 * The comparison is the working tree against `HEAD`, and the sentence says so
 * rather than naming a session: git records what changed, not who changed it,
 * and a file two sessions and a person all touched would be attributed to
 * whichever one happened to be on screen.
 */
export function describeFileChanges(state: FileChangeState): {
  text: string
  short: string
  marked: boolean
} {
  switch (state.kind) {
    case 'tracked': {
      const { changedCount, removedCount } = state.lines
      if (changedCount === 0 && removedCount === 0) {
        return { text: 'No changes since the last commit', short: 'Unchanged', marked: false }
      }
      const parts: string[] = []
      const brief: string[] = []
      if (changedCount > 0) {
        parts.push(plural(changedCount, 'line changed', 'lines changed'))
        brief.push(`${String(changedCount)} changed`)
      }
      if (removedCount > 0) {
        parts.push(plural(removedCount, 'line removed', 'lines removed'))
        brief.push(`${String(removedCount)} removed`)
      }
      return { text: `${parts.join(', ')} since the last commit`, short: brief.join(', '), marked: true }
    }
    case 'new':
      return { text: 'New file, not in the last commit', short: 'New file', marked: true }
    case 'ignored':
      return { text: 'Ignored by git', short: 'Ignored', marked: false }
    case 'outside':
      return { text: 'Not in a git repository', short: 'Not in git', marked: false }
    case 'unknown':
      return { text: 'Could not read what changed', short: 'Changes unknown', marked: false }
  }
}

/** The changed lines as a set, for an editor that asks one line at a time. */
export function changedLineSet(lines: LineChanges): Set<number> {
  const out = new Set<number>()
  for (const [from, to] of lines.changed) {
    for (let line = from; line <= to; line += 1) out.add(line)
  }
  return out
}
