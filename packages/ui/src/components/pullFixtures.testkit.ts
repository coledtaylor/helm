import type {
  GhStatus,
  PullDetailView,
  PullRepo,
  PullsSnapshot,
  PullSummary,
  RenderedPullThread
} from '@helm/core/types'

/**
 * Pull-request records for component tests, in the shapes main sends. Not
 * exported from the package: only tests import this.
 */

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

export function pullSummary(number: number, patch: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `Pull request ${String(number)}`,
    url: `https://github.com/acme/alpha/pull/${String(number)}`,
    author: 'octocat',
    authorIsBot: false,
    state: 'OPEN',
    isDraft: false,
    headRefName: `feature/pr-${String(number)}`,
    baseRefName: 'main',
    createdAt: Date.now() - 5 * DAY,
    updatedAt: Date.now() - HOUR,
    additions: 12,
    deletions: 3,
    changedFiles: 2,
    reviewDecision: null,
    checks: null,
    labels: [],
    ...patch
  }
}

export function pullRepo(name: string, pulls: PullSummary[], patch: Partial<PullRepo> = {}): PullRepo {
  return {
    path: `C:\\work space\\${name}`,
    name,
    url: `https://github.com/acme/${name}.git`,
    slug: `acme/${name}`,
    fetchedAtMs: Date.now() - 4 * 60_000,
    error: null,
    pulls,
    ...patch
  }
}

export const SIGNED_IN: GhStatus = {
  path: 'C:\\Program Files\\GitHub CLI\\gh.exe',
  source: 'discovered',
  version: 'gh version 2.86.0 (2026-01-01)',
  authenticated: true,
  problem: null
}

export function pullsSnapshot(repos: PullRepo[], patch: Partial<PullsSnapshot> = {}): PullsSnapshot {
  const fetched = repos.map((repo) => repo.fetchedAtMs).filter((at): at is number => at !== null)
  return {
    repos,
    ignored: [],
    open: repos.reduce((sum, repo) => sum + repo.pulls.length, 0),
    checked: repos.length,
    unmapped: 0,
    gh: SIGNED_IN,
    fetchedAtMs: fetched.length === 0 ? null : Math.min(...fetched),
    fetching: false,
    ...patch
  }
}

/** A rendered thread, as `pullConversation` and main's renderer make one. */
export function renderedThread(
  id: string,
  path: string,
  line: number | null,
  patch: Partial<RenderedPullThread> = {}
): RenderedPullThread {
  const at = Date.now() - 2 * HOUR
  return {
    kind: 'thread',
    id,
    path,
    line,
    originalLine: line,
    diffHunk: '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2',
    isResolved: false,
    isOutdated: false,
    at,
    comments: [
      {
        id: `${id}-c0`,
        author: 'mona',
        authorIsBot: false,
        association: 'MEMBER',
        body: `A note on ${id}`,
        createdAt: at,
        url: `https://github.com/acme/alpha/pull/7#discussion_${id}`,
        html: `<p>A note on <strong>${id}</strong></p>`
      }
    ],
    ...patch
  }
}

/** Pull request #7 of acme/alpha, opened in its tab. */
export function detailView(patch: Partial<PullDetailView> = {}): PullDetailView {
  const summary = pullSummary(7, {
    title: 'Cache the discovery walk',
    headRefName: 'fix/cache-walk',
    additions: 3,
    deletions: 1,
    changedFiles: 2
  })
  return {
    slug: 'acme/alpha',
    repoPath: 'C:\\work space\\alpha',
    summary,
    detail: {
      body: 'Caches it.',
      comments: [],
      reviews: [],
      commits: [
        {
          oid: 'a'.repeat(40),
          messageHeadline: 'Cache the walk',
          author: 'octocat',
          coAuthors: 0,
          committedAt: Date.now() - 3 * HOUR
        },
        {
          oid: 'b'.repeat(40),
          messageHeadline: 'Invalidate on focus',
          author: 'octocat',
          coAuthors: 1,
          committedAt: Date.now() - 2 * HOUR
        }
      ],
      files: [
        { path: 'src/new.ts', additions: 2, deletions: 0 },
        { path: 'src/old.ts', additions: 1, deletions: 1 }
      ],
      checks: { total: 3, failing: 1, pending: 1 },
      mergeStateStatus: 'CLEAN',
      reviewThreads: []
    },
    bodyHtml: '<p>Caches <strong>it</strong>.</p>',
    conversation: [],
    threadsNote: null,
    threadsFetchedAtMs: Date.now() - 10 * 60_000,
    files: [
      {
        path: 'src/new.ts',
        additions: 2,
        deletions: 0,
        status: 'added',
        oldPath: null,
        binary: false,
        droppedLines: 0,
        hunks: [
          {
            header: '@@ -0,0 +1,2 @@',
            lines: [
              { kind: 'add', oldLine: null, newLine: 1, text: 'export const a = 1' },
              { kind: 'add', oldLine: null, newLine: 2, text: 'export const b = 2' }
            ]
          }
        ]
      },
      {
        path: 'src/old.ts',
        additions: 1,
        deletions: 1,
        status: 'modified',
        oldPath: null,
        binary: false,
        droppedLines: 0,
        hunks: [
          {
            header: '@@ -1,3 +1,3 @@ function compute()',
            lines: [
              { kind: 'context', oldLine: 1, newLine: 1, text: 'const keep = 1' },
              { kind: 'del', oldLine: 2, newLine: null, text: 'const gone = 2' },
              { kind: 'add', oldLine: null, newLine: 2, text: 'const here = 3' },
              { kind: 'context', oldLine: 3, newLine: 3, text: 'const tail = 4' }
            ]
          }
        ]
      }
    ],
    diffNote: null,
    fetchedAtMs: Date.now() - 2 * 60_000,
    cached: false,
    ...patch
  }
}
