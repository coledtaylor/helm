import { resolve } from 'node:path'
import type { FileChangeState, LineChanges } from '../types'
import { repoRootOf } from '../content/filetree'
import { literalPath, runGit } from './git'
import { prefixIn } from './status'

/**
 * Which lines of a file differ from the last commit.
 *
 * The working tree against `HEAD`, staged and unstaged together, because "what
 * has changed in this file since it was last committed" is the question
 * somebody reading a file beside the session working on it is asking - and it
 * is the one git can answer without guessing who did it.
 */

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Reads a zero-context diff's hunk headers into line marks on the new file.
 *
 * With `-U0` every hunk is exactly one change, so the header says everything:
 * `-a,b +c,d` replaces `b` old lines with the `d` new lines starting at `c`. A
 * hunk with `d = 0` removed lines and added none, and git then sets `c` to the
 * line *above* the removal - which is exactly where the marker goes. A hunk
 * that removed more than it added marks its new lines as changed and the
 * removal below the last of them.
 */
export function parseZeroContextDiff(diff: string): LineChanges {
  const changed: Array<[number, number]> = []
  const removedAfter: number[] = []
  let changedCount = 0
  let removedCount = 0

  for (const line of diff.split('\n')) {
    const match = HUNK.exec(line)
    if (match === null) continue
    const oldCount = match[2] === undefined ? 1 : Number(match[2])
    const start = Number(match[3])
    const newCount = match[4] === undefined ? 1 : Number(match[4])
    if (newCount === 0) {
      removedAfter.push(start)
      removedCount += oldCount
      continue
    }
    changed.push([start, start + newCount - 1])
    changedCount += newCount
    if (oldCount > newCount) {
      removedAfter.push(start + newCount - 1)
      removedCount += oldCount - newCount
    }
  }
  return { changed, removedAfter, changedCount, removedCount }
}

const NO_CHANGES: LineChanges = { changed: [], removedAfter: [], changedCount: 0, removedCount: 0 }

/**
 * How one file stands against the last commit.
 *
 * A status call first, for the path alone - it is what tells a file that is not
 * in the last commit, or that git ignores, from one that is merely unchanged,
 * and all three would otherwise print the same empty diff. The diff is run only
 * for a file git reports as changed, so an unchanged file costs one process.
 */
export async function readFileChanges(path: string): Promise<FileChangeState> {
  const absolute = resolve(path)
  const repo = repoRootOf(absolute)
  if (repo === null) return { kind: 'outside' }
  const rel = prefixIn(repo, absolute)

  const status = await runGit(repo, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
    '--ignored=matching',
    '--',
    literalPath(rel)
  ])
  if (status.code !== null) {
    return {
      kind: 'unknown',
      reason: status.code === 'ENOENT' ? 'git is not installed, or not on the PATH' : (status.error ?? 'git failed')
    }
  }

  const records = status.stdout.split('\0').filter((record) => record !== '' && !record.startsWith('#'))
  const first = records[0]
  if (first === undefined) return { kind: 'tracked', lines: NO_CHANGES }
  if (first.startsWith('?')) return { kind: 'new' }
  if (first.startsWith('!')) return { kind: 'ignored' }

  const pathspecs = [literalPath(rel)]
  if (first.startsWith('1')) {
    const xy = first.slice(2, 4)
    // Added to the index but never committed: there is no `HEAD` side to
    // compare against, so every line is new.
    if (xy[0] === 'A' || xy[1] === 'A') return { kind: 'new' }
  } else if (first.startsWith('2')) {
    // A rename is only seen as one when both of its paths are in the diff;
    // given the new name alone, git reports a whole new file.
    const from = records[1]
    if (from !== undefined) pathspecs.push(literalPath(from))
  }

  const diff = await runGit(repo, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '-U0',
    'HEAD',
    '--',
    ...pathspecs
  ])
  if (diff.code !== null) return { kind: 'unknown', reason: diff.error ?? 'git diff failed' }
  return { kind: 'tracked', lines: parseZeroContextDiff(diff.stdout) }
}
