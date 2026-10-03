import { execFile } from 'node:child_process'

/**
 * One `git` call for the Files view, with the settings every one of them needs.
 *
 * `--no-optional-locks` on every call: these run on a timer and on file-system
 * events while a session may be committing in the same repository, and a
 * status that took the index lock to refresh its stat cache would make that
 * commit fail with "index.lock exists". Read-only is the whole contract here.
 */
const TIMEOUT_MS = 10_000

export interface GitRun {
  stdout: string
  /** Null on success. A spawn failure carries Node's code (`ENOENT`), a git failure its exit code. */
  code: number | string | null
  /** The first line git wrote to stderr, for a sentence on screen. */
  error: string | null
}

export function runGit(cwd: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((settle) => {
    execFile(
      'git',
      ['--no-optional-locks', ...args],
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err === null) {
          settle({ stdout, code: null, error: null })
          return
        }
        const code = (err as { code?: number | string }).code ?? -1
        const first = (stderr || err.message).split('\n').find((line) => line.trim() !== '')
        settle({ stdout, code, error: first?.trim() ?? String(code) })
      }
    )
  })
}

/**
 * A pathspec that means exactly this path.
 *
 * `:(literal)` turns off glob magic, so a file named `[id].tsx` - every Next.js
 * route - is that file and not a character class; `top` anchors it at the
 * repository root, which is what the forward-slashed relative paths here are.
 */
export const literalPath = (repoRelative: string): string => `:(top,literal)${repoRelative}`
