import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { repoRoot } from './world'

/**
 * A GitHub whose answers are written in advance, for the pull-request tests.
 *
 * `scripts/fake-gh.mjs` in its fixture mode, behind a `.cmd` shim of its own -
 * the scoop and npm shape, which is the one `resolveGhCommand` has a branch
 * for. Everything it is asked is logged, so a test reads back the argv and the
 * working directory of every call rather than trusting what Helm says it ran.
 *
 * The JSON written here is in the shape `gh` prints, not the shape Helm parses
 * it into: the parse is part of what is under test.
 */

/** One call the fake answered, from its `invocations.jsonl`. */
export interface GhCall {
  at: number
  argv: string[]
  cwd: string
  exit: number
  stderr?: string
}

/** `behaviour.json`, re-read by the fake on every call. */
export interface GhBehaviour {
  version?: string
  auth?: 'unauthenticated' | 'offline'
  list?: 'error' | 'invalid-json'
  listError?: string
  view?: 'error'
  viewError?: string
  diff?: 'error'
  diffError?: string
  threads?: 'error' | 'absent'
  threadsError?: string
  checkout?: 'error'
  checkoutError?: string
}

/** A `gh pr list --json` entry. */
export interface GhPull {
  number: number
  title: string
  url: string
  author: { login: string; is_bot: boolean }
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: string
  statusCheckRollup: unknown[]
  labels: Array<{ name: string }>
}

/** A `gh pr view --json` answer. */
export interface GhView {
  body: string
  comments: Array<{
    id: string
    author: { login: string; is_bot: boolean }
    authorAssociation: string
    body: string
    createdAt: string
    url: string
  }>
  reviews: Array<{
    id: string
    author: { login: string; is_bot: boolean }
    authorAssociation: string
    state: string
    body: string
    submittedAt: string
  }>
  commits: Array<{
    oid: string
    messageHeadline: string
    authors: Array<{ login: string; name: string }>
    committedDate: string
    authoredDate: string
  }>
  files: Array<{ path: string; additions: number; deletions: number }>
  statusCheckRollup: unknown[]
  mergeStateStatus: string
}

/** A review thread as a GraphQL node, before the fake pages its comments. */
export interface GhThread {
  id: string
  path: string
  line: number | null
  originalLine: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: Array<{
    id: string
    author: { login: string; __typename: string }
    authorAssociation: string
    body: string
    createdAt: string
    url: string
    diffHunk: string
  }>
}

export interface GhFixture {
  /** The fixture directory the fake answers from. */
  home: string
  /** The `.cmd` shim, which is what a setting or `pointGh` is given. */
  gh: string
  list: (slug: string, pulls: GhPull[]) => void
  view: (slug: string, number: number, view: GhView) => void
  diff: (slug: string, number: number, patch: string) => void
  threads: (slug: string, number: number, threads: GhThread[]) => void
  behave: (how: GhBehaviour) => void
  /** Every call so far, oldest first. */
  calls: () => GhCall[]
  /** Forgets every answer, every behaviour and every logged call. */
  reset: () => void
}

const fileOf = (slug: string): string => slug.replace('/', '__')

export function createGhFixture(home: string): GhFixture {
  mkdirSync(home, { recursive: true })
  const gh = join(home, 'gh.cmd')
  writeFileSync(
    gh,
    [
      '@echo off',
      'setlocal',
      `set "HELM_FAKE_GH_HOME=${home}"`,
      'set "HELM_FAKE_GH_SYNTHETIC="',
      `"${process.execPath}" "${join(repoRoot(), 'packages', 'desktop', 'scripts', 'fake-gh.mjs')}" %*`,
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n')
  )

  const put = (dir: string, name: string, text: string): void => {
    mkdirSync(join(home, dir), { recursive: true })
    writeFileSync(join(home, dir, name), text)
  }

  return {
    home,
    gh,
    list: (slug, pulls) => put('list', `${fileOf(slug)}.json`, JSON.stringify(pulls)),
    view: (slug, number, view) => put('view', `${fileOf(slug)}__${String(number)}.json`, JSON.stringify(view)),
    diff: (slug, number, patch) => put('diff', `${fileOf(slug)}__${String(number)}.patch`, patch),
    threads: (slug, number, threads) =>
      put('threads', `${fileOf(slug)}__${String(number)}.json`, JSON.stringify(threads)),
    behave: (how) => writeFileSync(join(home, 'behaviour.json'), JSON.stringify(how)),
    calls: () => {
      const file = join(home, 'invocations.jsonl')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as GhCall)
    },
    reset: () => {
      for (const entry of ['list', 'view', 'diff', 'threads', 'behaviour.json', 'invocations.jsonl']) {
        rmSync(join(home, entry), { recursive: true, force: true })
      }
    }
  }
}

/** The calls that were `gh <first> <second> ...`, e.g. `('pr', 'list')`. */
export function callsOf(calls: GhCall[], ...command: string[]): GhCall[] {
  return calls.filter((call) => command.every((word, at) => call.argv[at] === word))
}

/** The value after `name` in an argv. */
export function argOf(call: GhCall, name: string): string | undefined {
  const at = call.argv.indexOf(name)
  return at < 0 ? undefined : call.argv[at + 1]
}

/** An hour offset from now, as gh prints a timestamp. */
export function hoursAgo(hours: number, now = Date.now()): string {
  return new Date(now - hours * 3_600_000).toISOString()
}

/**
 * A pull request as `gh pr list` prints it. Updated `number` hours ago, so a
 * list's order - most recent first - is fixed by the numbers in it rather than
 * by which entry happened to be built a millisecond later.
 */
export function ghPull(slug: string, number: number, patch: Partial<GhPull> = {}): GhPull {
  return {
    number,
    title: `Pull request ${String(number)}`,
    url: `https://github.com/${slug}/pull/${String(number)}`,
    author: { login: 'octocat', is_bot: false },
    state: 'OPEN',
    isDraft: false,
    headRefName: `feature/pr-${String(number)}`,
    baseRefName: 'main',
    createdAt: hoursAgo(1000),
    updatedAt: hoursAgo(number),
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: '',
    statusCheckRollup: [],
    labels: [],
    ...patch
  }
}

export function ghView(patch: Partial<GhView> = {}): GhView {
  return {
    body: 'A description.',
    comments: [],
    reviews: [],
    commits: [],
    files: [],
    statusCheckRollup: [],
    mergeStateStatus: 'CLEAN',
    ...patch
  }
}

/** A thread with `count` comments, the first at `firstAt`, a minute apart. */
export function ghThread(
  id: string,
  path: string,
  line: number | null,
  options: { count?: number; firstAt?: number; resolved?: boolean; outdated?: boolean; originalLine?: number } = {}
): GhThread {
  const firstAt = options.firstAt ?? Date.now() - 3_600_000
  const hunk = [`@@ -1,3 +1,4 @@`, ' const before = 1', `+  const added = ${String(line ?? 0)}`].join('\n')
  return {
    id,
    path,
    line,
    originalLine: options.originalLine ?? line,
    isResolved: options.resolved ?? false,
    isOutdated: options.outdated ?? false,
    comments: Array.from({ length: options.count ?? 1 }, (_, at) => ({
      id: `${id}-c${String(at)}`,
      author: { login: 'mona', __typename: 'User' },
      authorAssociation: 'MEMBER',
      body: `Comment ${String(at)} on ${id}`,
      createdAt: new Date(firstAt + at * 60_000).toISOString(),
      url: `https://github.com/acme/x/pull/1#discussion_${id}_${String(at)}`,
      diffHunk: hunk
    }))
  }
}

/** Points a project's `origin` at `url`, through git, the way a clone would. */
export function setOrigin(project: string, url: string): void {
  const remotes = execFileSync('git', ['remote'], { cwd: project, encoding: 'utf8' })
  const verb = remotes.split('\n').some((name) => name.trim() === 'origin') ? 'set-url' : 'add'
  execFileSync('git', ['remote', verb, 'origin', url], { cwd: project, stdio: 'ignore' })
}

/**
 * `PATH` without any directory holding a `gh`, so discovery in a test can only
 * find what the test put there. Git and the system stay reachable.
 */
export function pathWithoutGh(path: string): string {
  return path
    .split(delimiter)
    .filter((dir) => dir !== '' && !['gh.exe', 'gh.cmd', 'gh.bat', 'gh.com'].some((name) => existsSync(join(dir, name))))
    .join(delimiter)
}
