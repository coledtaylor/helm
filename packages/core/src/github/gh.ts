import { execFile } from 'node:child_process'
import {
  PR_LIST_FIELDS,
  PR_LIST_LIMIT,
  PR_VIEW_FIELDS,
  parseGhAuth,
  parseGhVersion,
  parsePullDetail,
  parsePullList
} from './parse'
import type { GhAuthReading } from './parse'
import type { PullDetail, PullSummary } from './types'

/**
 * Running the user's own `gh`.
 *
 * Helm makes no GitHub request of its own and holds no GitHub credential. Every
 * fetch on this surface is `gh` doing what `gh` does, on the token the user
 * gave it - which is the same arrangement Helm has with the `claude` CLI, and
 * it is deliberate rather than convenient: a token Helm never receives is a
 * token Helm cannot leak.
 *
 * The binary is **passed in**, not looked up here. `core` is headless and knows
 * nothing about install locations or a settings override; resolving those is
 * the host's job (`desktop/src/main/gh-cli.ts`), and this module is handed the
 * answer. Same shape as `readGitState` shelling out to `git`.
 */

/** Long enough for a cold API call, short enough that a pass cannot hang. */
const TIMEOUT_MS = 30_000

/** A repository's PR list is a few hundred kilobytes at most. */
const MAX_BUFFER = 8 * 1024 * 1024

/**
 * How to spawn `gh`, resolved by the host.
 *
 * `prefixArgs` carries the `cmd.exe /c` dance a `.cmd` shim needs on Windows -
 * the same reason `ClaudeCommand` has one. A scoop or npm installation of gh is
 * a batch file, and `CreateProcess` cannot execute one.
 */
export interface GhCommand {
  file: string
  prefixArgs: string[]
  /** The gh entry point itself, for diagnostics. */
  resolved: string
}

export interface GhRun {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** Set when the process could not be run or was killed; null otherwise. */
  error: string | null
  durationMs: number
}

/**
 * The environment `gh` is given.
 *
 * Three of these keep the output parseable and one keeps the process from
 * waiting for a person: gh will otherwise print an update banner, colour its
 * diagnostics, page its output, and - on a repository it cannot resolve -
 * prompt. None of that is answerable from inside a fetch pass.
 *
 * Nothing is *removed*: `GH_TOKEN`, `GH_HOST` and the rest are the user's own
 * configuration, and a Helm that quietly unset them would be a Helm that
 * fetches as somebody else.
 */
function ghEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PROMPT_DISABLED: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1'
  }
}

export async function runGh(
  command: GhCommand,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<GhRun> {
  const started = Date.now()
  return new Promise<GhRun>((resolve) => {
    execFile(
      command.file,
      [...command.prefixArgs, ...args],
      {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs ?? TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        env: ghEnv()
      },
      (err, stdout, stderr) => {
        // Resolved rather than rejected in every case, including the ones where
        // gh never started: a failed fetch is a fact this surface reports on a
        // repository row, not an exception the poller has to survive.
        const code = err === null ? 0 : typeof err.code === 'number' ? err.code : null
        resolve({
          ok: err === null,
          exitCode: code,
          stdout,
          stderr,
          error: err === null ? null : firstLine(err.message),
          durationMs: Date.now() - started
        })
      }
    )
  })
}

export async function readGhVersion(command: GhCommand): Promise<string | null> {
  const run = await runGh(command, ['--version'], { timeoutMs: 15_000 })
  return run.ok ? parseGhVersion(run.stdout) : null
}

/** Whether gh is signed in, from its exit code alone. See `parseGhAuth`. */
export async function readGhAuth(command: GhCommand): Promise<GhAuthReading> {
  const run = await runGh(command, ['auth', 'status'], { timeoutMs: 20_000 })
  return parseGhAuth(run)
}

/**
 * Open pull requests for one repository.
 *
 * `--repo <slug>` rather than a working directory, which is what makes this
 * independent of where the process happens to be: the same call answers for a
 * repository whose checkout has been renamed, moved or is mid-rebase, and it
 * cannot accidentally answer for whatever repository the cwd is inside.
 *
 * Rejects with gh's own first line of complaint. The caller records that
 * against the repository and keeps the rows it already had.
 */
export async function fetchOpenPulls(
  command: GhCommand,
  slug: string,
  options: { limit?: number; timeoutMs?: number } = {}
): Promise<PullSummary[]> {
  const run = await runGh(
    command,
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--state',
      'open',
      '--limit',
      String(options.limit ?? PR_LIST_LIMIT),
      '--json',
      PR_LIST_FIELDS
    ],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  )

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return parsePullList(run.stdout)
}

/**
 * Everything behind one pull request.
 *
 * A second call and a second cache column rather than more fields on the list
 * fetch, because the two cost very different things: a list is one request per
 * repository on a five-minute timer, and this is the conversation, the commits
 * and the file list of a single pull request, asked for once when somebody
 * opens it. Folding them together would make the poll pay for detail nobody has
 * looked at.
 *
 * `--repo <slug>` again, so the answer does not depend on the working
 * directory - see `fetchOpenPulls`.
 */
export async function fetchPullDetail(
  command: GhCommand,
  slug: string,
  number: number,
  options: { timeoutMs?: number } = {}
): Promise<PullDetail> {
  const run = await runGh(
    command,
    ['pr', 'view', String(number), '--repo', slug, '--json', PR_VIEW_FIELDS],
    options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
  )

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return parsePullDetail(run.stdout)
}

/**
 * `gh pr checkout`, the one call on this surface that changes something.
 *
 * Everything else here reads. This fetches the pull request's head into the
 * checkout at `cwd` and moves it there, which is why `cwd` is required rather
 * than optional: `--repo` names which repository the number belongs to, but the
 * tree being moved is whichever one the process is standing in, and defaulting
 * that to `process.cwd()` would be a working directory nobody chose.
 *
 * The dirty-tree guard is the **caller's**, deliberately: this is `core`, it
 * has one job, and the guard needs `readGitState` plus a sentence to show. See
 * `desktop/src/main/pulls.ts`.
 *
 * Rejects with gh's own first line of complaint - a fork whose head has been
 * deleted, a branch name that collides with a local one, a repository mid-merge.
 */
export async function checkoutPull(
  command: GhCommand,
  slug: string,
  number: number,
  cwd: string,
  options: { timeoutMs?: number } = {}
): Promise<GhRun> {
  const run = await runGh(command, ['pr', 'checkout', String(number), '--repo', slug], {
    cwd,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  })

  if (!run.ok) {
    const said = firstMeaningfulLine(run.stderr) ?? run.error ?? 'gh failed with no output'
    throw new Error(said)
  }
  return run
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text
}

function firstMeaningfulLine(text: string): string | null {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? null
  )
}
