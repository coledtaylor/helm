import { describe, expect, it } from 'vitest'
import {
  classifyGhFailure,
  heldReviewThreads,
  parseGhAuth,
  parseGhVersion,
  parsePullDetail,
  parsePullList,
  parseReviewThreadPage,
  parseThreadCommentPage,
  pullConversation,
  reduceChecks,
  PR_LIST_FIELDS,
  PR_THREAD_COMMENTS_QUERY,
  PR_THREADS_QUERY,
  PR_VIEW_FIELDS
} from './parse'
import type { PullDetail, PullReviewThread } from './types'
import { renderPullPrompt, DEFAULT_PR_REVIEW_PROMPT, PR_PROMPT_PLACEHOLDERS } from './prompt'
import { parseGitHubRemote } from './remote'
import { indexDiffByPath, parseUnifiedDiff } from './diff'
import { isRepoIgnored, isRepoSlug, withRepoIgnored } from './types'

describe('parseGitHubRemote', () => {
  const accepted: Array<{ remote: string; why: string }> = [
    { remote: 'https://github.com/coledtaylor/helm.git', why: 'https clone URL' },
    { remote: 'https://github.com/coledtaylor/helm', why: 'https without the extension' },
    { remote: 'http://github.com/coledtaylor/helm.git', why: 'http, which git still allows' },
    { remote: 'https://www.github.com/coledtaylor/helm', why: 'the www alias' },
    { remote: 'https://GitHub.com/coledtaylor/helm', why: 'a host is case-insensitive' },
    { remote: 'https://github.com/coledtaylor/helm.git/', why: 'a trailing slash' },
    { remote: 'git@github.com:coledtaylor/helm.git', why: 'scp syntax, what git clone leaves' },
    { remote: 'git@github.com:coledtaylor/helm', why: 'scp syntax without the extension' },
    { remote: 'ssh://git@github.com/coledtaylor/helm.git', why: 'a full ssh URL' },
    { remote: 'ssh://git@github.com:22/coledtaylor/helm.git', why: 'ssh with an explicit port' },
    { remote: 'git://github.com/coledtaylor/helm.git', why: 'the git protocol' },
    { remote: '  https://github.com/coledtaylor/helm.git  ', why: 'surrounding whitespace' }
  ]

  for (const { remote, why } of accepted) {
    it(`reads ${remote.trim()} (${why})`, () => {
      expect(parseGitHubRemote(remote)).toMatchObject({
        owner: 'coledtaylor',
        name: 'helm',
        slug: 'coledtaylor/helm'
      })
    })
  }

  const rejected: Array<{ remote: string; why: string }> = [
    { remote: '', why: 'no remote at all' },
    { remote: '   ', why: 'whitespace' },
    { remote: 'https://gitlab.com/coledtaylor/helm.git', why: 'a different forge' },
    { remote: 'https://bitbucket.org/coledtaylor/helm.git', why: 'a different forge' },
    { remote: 'git@gitlab.com:coledtaylor/helm.git', why: 'a different forge over ssh' },
    { remote: 'https://github.example.com/o/r.git', why: 'GitHub Enterprise is not github.com' },
    { remote: 'https://github.com.example.net/o/r', why: 'a host that merely starts with it' },
    { remote: 'https://mygithub.com/o/r', why: 'a host that merely ends with it' },
    { remote: 'https://github.com/coledtaylor', why: 'an owner with no repository' },
    { remote: 'https://github.com/', why: 'no path' },
    { remote: 'https://github.com/o/r/tree/main', why: 'a page, not a remote' },
    { remote: 'file:///C:/repos/helm', why: 'a local clone source' },
    { remote: 'C:\\repos\\helm', why: 'a Windows path' },
    { remote: '\\\\server\\share\\helm', why: 'a UNC path' },
    { remote: '../sibling', why: 'a relative path' },
    { remote: 'https://github.com/o wner/repo', why: 'a space in the owner' },
    { remote: 'https://github.com/-owner/repo', why: 'an owner GitHub would not issue' }
  ]

  for (const { remote, why } of rejected) {
    it(`rejects ${JSON.stringify(remote)} (${why})`, () => {
      expect(parseGitHubRemote(remote)).toBeNull()
    })
  }

  it('keeps a repository whose name legitimately ends in something else', () => {
    expect(parseGitHubRemote('https://github.com/acme/.github')).toMatchObject({ name: '.github' })
    expect(parseGitHubRemote('https://github.com/acme/dot.github.git')).toMatchObject({
      name: 'dot.github'
    })
  })

  it('reports the remote it was given, so a row can show where it came from', () => {
    expect(parseGitHubRemote('git@github.com:acme/web.git')?.url).toBe('git@github.com:acme/web.git')
  })

  it('does not keep a credential embedded in the remote', () => {
    const parsed = parseGitHubRemote('https://ghp_secrettokenvalue@github.com/acme/web.git')

    expect(parsed?.slug).toBe('acme/web')
    expect(parsed?.url).toBe('https://github.com/acme/web.git')
    expect(parsed?.url).not.toContain('ghp_')
  })
})

// ---------------------------------------------------------------------------

/** One entry shaped exactly as gh 2.86.0 prints it, verified against a live PR. */
const LIVE_ENTRY = {
  additions: 304,
  author: { id: 'MDQ6VXNlcjQ3Mzk0MjAw', is_bot: false, login: 'BagToad', name: 'Kynan Ware' },
  baseRefName: 'trunk',
  changedFiles: 86,
  createdAt: '2026-08-10T23:12:16Z',
  deletions: 254,
  headRefName: 'bagtoad/probable-funicular',
  isDraft: false,
  labels: [],
  number: 14128,
  reviewDecision: 'REVIEW_REQUIRED',
  state: 'OPEN',
  title: "Isolate tests from the local machine's configuration",
  updatedAt: '2026-08-10T23:53:03Z',
  url: 'https://github.com/cli/cli/pull/14128'
}

describe('parsePullList', () => {
  it('asks for every field the list view paints', () => {
    // The list is what the fetch actually sends, so a field the pane reads and
    // the request does not ask for would arrive undefined at runtime only.
    for (const field of [
      'number',
      'title',
      'url',
      'author',
      'state',
      'isDraft',
      'headRefName',
      'baseRefName',
      'createdAt',
      'updatedAt',
      'additions',
      'deletions',
      'changedFiles',
      'reviewDecision',
      'statusCheckRollup',
      'labels'
    ]) {
      expect(PR_LIST_FIELDS.split(',')).toContain(field)
    }
  })

  it('reads an entry in the shape gh actually prints', () => {
    const [pull] = parsePullList(JSON.stringify([LIVE_ENTRY]))

    expect(pull).toEqual({
      number: 14128,
      title: "Isolate tests from the local machine's configuration",
      url: 'https://github.com/cli/cli/pull/14128',
      author: 'BagToad',
      authorIsBot: false,
      state: 'OPEN',
      isDraft: false,
      headRefName: 'bagtoad/probable-funicular',
      baseRefName: 'trunk',
      createdAt: Date.parse('2026-08-10T23:12:16Z'),
      updatedAt: Date.parse('2026-08-10T23:53:03Z'),
      additions: 304,
      deletions: 254,
      changedFiles: 86,
      reviewDecision: 'REVIEW_REQUIRED',
      // The capture predates Helm asking for `statusCheckRollup`, so this entry
      // genuinely has no rollup on it - and an absent one reduces to null,
      // which is the value that paints no tick rather than a green one.
      checks: null,
      labels: []
    })
  })

  it('reduces the rollup a list entry now carries', () => {
    const [pull] = parsePullList(
      JSON.stringify([
        {
          ...LIVE_ENTRY,
          statusCheckRollup: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
            { __typename: 'StatusContext', state: 'FAILURE' }
          ]
        }
      ])
    )

    // The same three numbers the detail reduces to, from the same function: a
    // row and the tab it opens must not disagree about what is green.
    expect(pull?.checks).toEqual({ total: 3, failing: 1, pending: 1 })
  })

  it('takes label names and leaves GitHub’s colours behind', () => {
    const [pull] = parsePullList(
      JSON.stringify([
        {
          ...LIVE_ENTRY,
          labels: [
            { id: 'LA_1', name: 'dependencies', description: '', color: '0366d6' },
            { id: 'LA_2', name: 'go', description: '', color: '16e2e2' }
          ]
        }
      ])
    )

    expect(pull?.labels).toEqual(['dependencies', 'go'])
  })

  it('recognises a bot from the flag and from the login prefix', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, author: { is_bot: true, login: 'app/dependabot' } },
        { ...LIVE_ENTRY, number: 2, author: { login: 'app/renovate' } },
        { ...LIVE_ENTRY, number: 3, author: { is_bot: false, login: 'coledtaylor' } }
      ])
    )

    expect(pulls.map((p) => p.authorIsBot)).toEqual([true, true, false])
  })

  it('treats an absent review requirement as no decision rather than a chip', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, reviewDecision: '' },
        { ...LIVE_ENTRY, number: 2, reviewDecision: 'APPROVED' },
        { ...LIVE_ENTRY, number: 3, reviewDecision: 'SOMETHING_NEW' }
      ])
    )

    expect(pulls.map((p) => p.reviewDecision)).toEqual([null, 'APPROVED', null])
  })

  it('orders by most recent activity, whatever order gh printed', () => {
    const pulls = parsePullList(
      JSON.stringify([
        { ...LIVE_ENTRY, number: 1, updatedAt: '2026-08-01T00:00:00Z' },
        { ...LIVE_ENTRY, number: 2, updatedAt: '2026-08-09T00:00:00Z' },
        { ...LIVE_ENTRY, number: 3, updatedAt: '2026-08-05T00:00:00Z' }
      ])
    )

    expect(pulls.map((p) => p.number)).toEqual([2, 3, 1])
  })

  it('keeps a row whose timestamp it cannot read, with no age rather than a wrong one', () => {
    const [pull] = parsePullList(JSON.stringify([{ ...LIVE_ENTRY, updatedAt: 'whenever' }]))

    expect(pull?.number).toBe(14128)
    expect(pull?.updatedAt).toBeNull()
  })

  it('fills a missing field rather than losing the pull request', () => {
    const [pull] = parsePullList(JSON.stringify([{ number: 7 }]))

    expect(pull).toMatchObject({
      number: 7,
      title: '',
      author: '',
      additions: 0,
      labels: [],
      reviewDecision: null
    })
  })

  it('drops an entry with no number, which is the one field that identifies it', () => {
    expect(parsePullList(JSON.stringify([{ title: 'nameless' }, LIVE_ENTRY]))).toHaveLength(1)
    expect(parsePullList(JSON.stringify([null, 'string', 42]))).toEqual([])
  })

  it('reads an empty list and an empty answer as no pull requests', () => {
    expect(parsePullList('[]')).toEqual([])
    expect(parsePullList('   ')).toEqual([])
  })

  it('refuses a payload that is not a list, rather than showing it as empty', () => {
    // A repository with no PRs and a gh that printed a diagnostic must not look
    // the same on screen.
    expect(() => parsePullList('gh: could not resolve to a Repository')).toThrow(/not JSON/)
    expect(() => parsePullList('{"message":"Not Found"}')).toThrow(/an object/)
    expect(() => parsePullList('null')).toThrow(/null/)
  })
})

// ---------------------------------------------------------------------------

/**
 * A `pr view` answer in the shape gh 2.86.0 prints it.
 *
 * Copied field for field from a live fetch against `cli/cli#14104` - including
 * the fields Helm does not read (`includesCreatedEdit`, `reactionGroups`,
 * `messageBody`), because a parser tested only against the fields it wants is a
 * parser that has never seen the payload it will actually get.
 */
const LIVE_DETAIL = {
  body: 'This draft PR continues the `api_host` rollout.',
  comments: [
    {
      id: 'IC_kwDODKw3uc8AAAABOHSlbg',
      author: { login: 'cli-triage' },
      authorAssociation: 'NONE',
      body: '**Recommendation: Merge, Confidence: High**',
      createdAt: '2026-08-10T15:08:36Z',
      includesCreatedEdit: false,
      isMinimized: false,
      minimizedReason: '',
      reactionGroups: [],
      url: 'https://github.com/cli/cli/pull/14119#issuecomment-5242135918',
      viewerDidAuthor: false
    }
  ],
  reviews: [
    {
      id: 'PRR_kwDODKw3uc8AAAABIzAvFg',
      author: { login: 'williammartin' },
      authorAssociation: 'MEMBER',
      body: '',
      submittedAt: '2026-08-07T18:26:49Z',
      includesCreatedEdit: false,
      reactionGroups: [],
      state: 'COMMENTED',
      commit: { oid: '9869df6e5acdab29cecbaae887f57afb51d7c3cf' }
    }
  ],
  commits: [
    {
      authoredDate: '2026-08-07T11:06:49Z',
      authors: [
        { email: 'williammartin@github.com', id: 'MDQ6VXNlcjE2', login: 'williammartin', name: 'William Martin' },
        { email: '223556219+Copilot@users.noreply.github.com', id: 'BOT_kgDO', login: 'Copilot', name: 'Copilot App' }
      ],
      committedDate: '2026-08-07T15:45:41Z',
      messageBody: 'gist had no acceptance scripts.\n\nCo-authored-by: Copilot App <x@y>',
      messageHeadline: 'Add acceptance coverage for gist',
      oid: 'ecdb100b3c56df9b17bbdea88cad9fd550b9d76e'
    }
  ],
  files: [{ path: 'acceptance/acceptance_test.go', additions: 85, deletions: 30 }],
  mergeStateStatus: 'BLOCKED',
  statusCheckRollup: [
    {
      __typename: 'CheckRun',
      completedAt: '2026-08-07T15:49:16Z',
      conclusion: 'SKIPPED',
      detailsUrl: 'https://github.com/cli/cli/actions/runs/31194516585/job/92919334681',
      name: 'label-external',
      startedAt: '2026-08-07T15:49:17Z',
      status: 'COMPLETED',
      workflowName: 'PR Triaging'
    }
  ]
}

describe('parsePullDetail', () => {
  it('asks for every field the detail tab paints', () => {
    for (const field of [
      'body',
      'comments',
      'reviews',
      'commits',
      'files',
      'statusCheckRollup',
      'mergeStateStatus'
    ]) {
      expect(PR_VIEW_FIELDS.split(',')).toContain(field)
    }
  })

  it('reads an answer in the shape gh actually prints', () => {
    const detail = parsePullDetail(JSON.stringify(LIVE_DETAIL))

    expect(detail.body).toBe('This draft PR continues the `api_host` rollout.')
    expect(detail.mergeStateStatus).toBe('BLOCKED')
    expect(detail.comments).toEqual([
      {
        id: 'IC_kwDODKw3uc8AAAABOHSlbg',
        author: 'cli-triage',
        authorIsBot: false,
        association: 'NONE',
        body: '**Recommendation: Merge, Confidence: High**',
        createdAt: Date.parse('2026-08-10T15:08:36Z'),
        url: 'https://github.com/cli/cli/pull/14119#issuecomment-5242135918'
      }
    ])
    expect(detail.reviews).toEqual([
      {
        id: 'PRR_kwDODKw3uc8AAAABIzAvFg',
        author: 'williammartin',
        authorIsBot: false,
        association: 'MEMBER',
        state: 'COMMENTED',
        body: '',
        submittedAt: Date.parse('2026-08-07T18:26:49Z')
      }
    ])
    expect(detail.files).toEqual([
      { path: 'acceptance/acceptance_test.go', additions: 85, deletions: 30 }
    ])
  })

  it('keeps the whole sha and counts the co-authors of a commit', () => {
    const [commit] = parsePullDetail(JSON.stringify(LIVE_DETAIL)).commits

    expect(commit).toEqual({
      oid: 'ecdb100b3c56df9b17bbdea88cad9fd550b9d76e',
      messageHeadline: 'Add acceptance coverage for gist',
      author: 'williammartin',
      coAuthors: 1,
      committedAt: Date.parse('2026-08-07T15:45:41Z')
    })
  })

  it('names a commit by the git name when GitHub has no account for it', () => {
    const [commit] = parsePullDetail(
      JSON.stringify({
        ...LIVE_DETAIL,
        commits: [
          {
            oid: 'b'.repeat(40),
            messageHeadline: 'Imported',
            authors: [{ email: 'nobody@example.com', name: 'A Person' }],
            committedDate: '2026-08-07T15:45:41Z'
          }
        ]
      })
    ).commits

    expect(commit).toMatchObject({ author: 'A Person', coAuthors: 0 })
  })

  it('falls back to the authored date when there is no commit date', () => {
    const [commit] = parsePullDetail(
      JSON.stringify({
        ...LIVE_DETAIL,
        commits: [{ oid: 'c'.repeat(40), authors: [], authoredDate: '2026-08-07T11:06:49Z' }]
      })
    ).commits

    expect(commit?.committedAt).toBe(Date.parse('2026-08-07T11:06:49Z'))
  })

  it('reads an absent list as an empty view rather than a broken one', () => {
    // A repository with checks disabled sends no rollup at all, and a pull
    // request nobody has commented on sends no comments.
    const detail = parsePullDetail(JSON.stringify({ body: 'Only a body.' }))

    expect(detail).toEqual({
      body: 'Only a body.',
      comments: [],
      reviews: [],
      commits: [],
      files: [],
      checks: null,
      mergeStateStatus: ''
    })
  })

  it('drops a commit with no sha and a file with no path', () => {
    const detail = parsePullDetail(
      JSON.stringify({
        ...LIVE_DETAIL,
        commits: [{ messageHeadline: 'nameless' }, LIVE_DETAIL.commits[0]],
        files: [{ additions: 3, deletions: 1 }, LIVE_DETAIL.files[0]]
      })
    )

    expect(detail.commits).toHaveLength(1)
    expect(detail.files).toHaveLength(1)
  })

  it('refuses a payload that is not a pull request, rather than showing it empty', () => {
    expect(() => parsePullDetail('gh: could not resolve to a PullRequest')).toThrow(/not JSON/)
    expect(() => parsePullDetail('[]')).toThrow(/an object/)
    expect(() => parsePullDetail('null')).toThrow(/null/)
    expect(() => parsePullDetail('   ')).toThrow(/printed nothing/)
  })
})

describe('reduceChecks', () => {
  it('counts a run of check runs the way GitHub spells them', () => {
    expect(
      reduceChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
        { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
        { __typename: 'CheckRun', status: 'QUEUED', conclusion: '' }
      ])
    ).toEqual({ total: 7, failing: 2, pending: 2 })
  })

  it('counts a legacy status context, which speaks a different vocabulary', () => {
    // `StatusContext` has no `status` and its verdict is in `state`. Reading it
    // with the check-run rules would call every one of these pending.
    expect(
      reduceChecks([
        { __typename: 'StatusContext', context: 'ci/travis', state: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/netlify', state: 'PENDING' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
        { __typename: 'StatusContext', context: 'ci/other', state: 'FAILURE' }
      ])
    ).toEqual({ total: 4, failing: 2, pending: 1 })
  })

  it('mixes the two shapes in one rollup, which is what a real one does', () => {
    expect(
      reduceChecks([
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', state: 'PENDING' }
      ])
    ).toEqual({ total: 2, failing: 1, pending: 1 })
  })

  it('counts a member it does not understand without claiming it passed', () => {
    // GitHub adds members to the union. One that speaks neither vocabulary is
    // present - so it is in `total` - and nothing is asserted about it.
    expect(reduceChecks([{ __typename: 'SomethingNew', name: 'x' }])).toEqual({
      total: 1,
      failing: 0,
      pending: 0
    })
  })

  it('reads no checks as none, which is not the same as unreadable', () => {
    expect(reduceChecks([])).toEqual({ total: 0, failing: 0, pending: 0 })
  })

  it('reports null for anything that is not a list at all', () => {
    // Null is what makes the pane paint nothing. Zeroes here would paint a
    // green "0 checks" over a rollup Helm could not read.
    for (const value of [null, undefined, 'PENDING', 42, { state: 'SUCCESS' }]) {
      expect(reduceChecks(value)).toBeNull()
    }
  })

  it('is null through the whole parse when the rollup is reshaped', () => {
    const detail = parsePullDetail(
      JSON.stringify({ ...LIVE_DETAIL, statusCheckRollup: { nodes: [] } })
    )

    expect(detail.checks).toBeNull()
    // ...and the rest of the pull request still arrives.
    expect(detail.commits).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

/**
 * A `gh api graphql` answer in the shape GitHub actually returns it.
 *
 * Copied from a live fetch against `cli/cli#14003` with the query this module
 * ships, bodies abridged and the rest left exactly as it arrived - the `Bot`
 * `__typename` on an actor, the `line: null` of an outdated thread, the em dash
 * inside a body, and the `@@` header at the top of a `diffHunk`. A parser
 * tested only against a payload written to suit it is a parser that has never
 * seen the one it will get.
 */
const LIVE_THREADS = {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpK0Mj' },
          nodes: [
            {
              id: 'PRRT_kwDODKw3uc6Uj0GH',
              path: 'AGENTS.md',
              line: 146,
              originalLine: 146,
              isResolved: true,
              isOutdated: false,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpK0MjA' },
                nodes: [
                  {
                    id: 'PRRC_kwDODKw3uc7at0BJ',
                    author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                    authorAssociation: 'CONTRIBUTOR',
                    body: 'The wording is grammatically incorrect here.',
                    createdAt: '2026-07-28T21:52:42Z',
                    url: 'https://github.com/cli/cli/pull/14003#discussion_r3669442633',
                    diffHunk:
                      '@@ -138,6 +143,7 @@ for _, tt := range tests {\n \n - Add godoc comments to all exported functions\n - Avoid unnecessary code comments — only comment when the *why* is not obvious\n+- Comments that carry context from your conversation are very valuable.'
                  },
                  {
                    id: 'PRRC_kwDODKw3uc7at1Xc',
                    author: { login: 'BagToad', __typename: 'User' },
                    authorAssociation: 'MEMBER',
                    body: "I don't think it matters.",
                    createdAt: '2026-07-28T21:53:36Z',
                    url: 'https://github.com/cli/cli/pull/14003#discussion_r3669448156',
                    diffHunk: '@@ -138,6 +143,7 @@ for _, tt := range tests {\n \n - Add godoc comments'
                  }
                ]
              }
            },
            {
              id: 'PRRT_kwDODKw3uc6Uj0Gf',
              path: 'AGENTS.md',
              line: null,
              originalLine: 184,
              isResolved: true,
              isOutdated: true,
              comments: {
                pageInfo: { hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpK0MjB' },
                nodes: [
                  {
                    id: 'PRRC_kwDODKw3uc7at0Br',
                    author: { login: 'copilot-pull-request-reviewer', __typename: 'Bot' },
                    authorAssociation: 'CONTRIBUTOR',
                    body: 'This line uses an em dash even though the Code Style section says not to.',
                    createdAt: '2026-07-28T21:52:43Z',
                    url: 'https://github.com/cli/cli/pull/14003#discussion_r3669442667',
                    diffHunk: '@@ -180,3 +184,4 @@\n+- Never use an em dash — like this one.'
                  }
                ]
              }
            }
          ]
        }
      }
    }
  }
}

describe('parseReviewThreadPage', () => {
  it('asks GraphQL for every field a thread is painted from', () => {
    for (const field of [
      'reviewThreads',
      'isResolved',
      'isOutdated',
      'originalLine',
      'diffHunk',
      'authorAssociation',
      'pageInfo',
      'endCursor'
    ]) {
      expect(PR_THREADS_QUERY).toContain(field)
    }
    // Both connections page, and both page sizes are under GitHub's ceiling of
    // 100 - `first: 100` twice over is 10,000 nodes and a request that GitHub
    // refuses on the first pull request with a long review.
    expect(PR_THREADS_QUERY).toContain('reviewThreads(first: 50, after: $cursor)')
    expect(PR_THREADS_QUERY).toContain('comments(first: 50)')
    expect(PR_THREAD_COMMENTS_QUERY).toContain('comments(first: 50, after: $cursor)')
    // The continuation is by node id. Re-walking the pull request to reach one
    // thread's fifty-first reply would re-fetch every thread beside it.
    expect(PR_THREAD_COMMENTS_QUERY).toContain('PullRequestReviewThread')
  })

  it('keeps both queries to one line and off cmd.exe’s special characters', () => {
    // Not formatting. A `gh` installed by scoop or npm is a batch file, so
    // `resolveGhCommand` runs it through `cmd.exe /c` - and cmd ends its
    // command line at the first newline whatever the quoting. Measured on 2.86
    // against a `.cmd` shim: a pretty-printed query arrived truncated at
    // `query($owner: String!,` with every `-f` after it gone, the request was
    // still made, and it exited 0. This is the assertion that stops somebody
    // reformatting the constant above and finding out on Windows only.
    for (const query of [PR_THREADS_QUERY, PR_THREAD_COMMENTS_QUERY]) {
      expect(query).not.toMatch(/[\r\n]/)
      expect(query).not.toMatch(/[&|<>^%]/)
    }
  })

  it('reads a page in the shape GitHub actually returns it', () => {
    const page = parseReviewThreadPage(JSON.stringify(LIVE_THREADS))

    expect(page.page).toEqual({ hasNextPage: false, endCursor: 'Y3Vyc29yOnYyOpK0Mj' })
    expect(page.threads).toHaveLength(2)
    expect(page.threads[0]?.thread.id).toBe('PRRT_kwDODKw3uc6Uj0GH')
    expect(page.threads[0]?.thread.path).toBe('AGENTS.md')
    expect(page.threads[0]?.thread.line).toBe(146)
    expect(page.threads[0]?.thread.isResolved).toBe(true)
    expect(page.threads[0]?.thread.isOutdated).toBe(false)
    expect(page.threads[0]?.thread.comments.map((c) => c.id)).toEqual([
      'PRRC_kwDODKw3uc7at0BJ',
      'PRRC_kwDODKw3uc7at1Xc'
    ])
    expect(page.threads[0]?.thread.comments[1]).toEqual({
      id: 'PRRC_kwDODKw3uc7at1Xc',
      author: 'BagToad',
      authorIsBot: false,
      association: 'MEMBER',
      body: "I don't think it matters.",
      createdAt: Date.parse('2026-07-28T21:53:36Z'),
      url: 'https://github.com/cli/cli/pull/14003#discussion_r3669448156'
    })
  })

  it('reads a bot from the GraphQL typename, which has no is_bot flag', () => {
    // The two fetches on this surface describe a bot in two different
    // vocabularies: `gh --json` says `is_bot`, GraphQL answers with an actor
    // whose `__typename` is `Bot`. A parser that only knew the first would
    // paint a review bot as a person.
    const [first] = parseReviewThreadPage(JSON.stringify(LIVE_THREADS)).threads
    expect(first?.thread.comments[0]?.authorIsBot).toBe(true)
    expect(first?.thread.comments[1]?.authorIsBot).toBe(false)
  })

  it('keeps the original line of an outdated thread, whose current line is null', () => {
    // The normal state of an outdated thread: the lines it was written against
    // have moved, GitHub stops claiming a current position, and the original is
    // then the only honest number there is.
    const [, outdated] = parseReviewThreadPage(JSON.stringify(LIVE_THREADS)).threads
    expect(outdated?.thread.line).toBeNull()
    expect(outdated?.thread.originalLine).toBe(184)
    expect(outdated?.thread.isOutdated).toBe(true)
  })

  it('takes the hunk off the first comment, which is where GitHub puts it', () => {
    // There is no thread-level `diffHunk` in the schema. The thread's hunk is
    // the one its opening note was written against, and taking the last
    // comment's would show the reply's view of a diff that has since moved.
    const [first] = parseReviewThreadPage(JSON.stringify(LIVE_THREADS)).threads
    expect(first?.thread.diffHunk.startsWith('@@ -138,6 +143,7 @@')).toBe(true)
    expect(first?.thread.diffHunk.split('\n')).toHaveLength(5)
  })

  it('carries the comments cursor so a long thread can be continued', () => {
    const payload = structuredClone(LIVE_THREADS)
    const thread = payload.data.repository.pullRequest.reviewThreads.nodes[0]
    if (thread !== undefined) {
      thread.comments.pageInfo = { hasNextPage: true, endCursor: 'CURSOR_51' }
    }
    const [first] = parseReviewThreadPage(JSON.stringify(payload)).threads
    expect(first?.comments).toEqual({ hasNextPage: true, endCursor: 'CURSOR_51' })
  })

  it('drops a thread with no comments left in it and one with no id', () => {
    // GitHub keeps a thread whose every comment has been deleted. It has no
    // author, no body and no moment to sit at in the chronology - a card with a
    // file name on it and nothing underneath.
    const page = parseReviewThreadPage(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: 'T_empty', path: 'a.ts', comments: { nodes: [] } },
                  { path: 'b.ts', comments: { nodes: [{ id: 'C1', body: 'x' }] } },
                  { id: 'T_ok', path: 'c.ts', comments: { nodes: [{ id: 'C2', body: 'y' }] } }
                ]
              }
            }
          }
        }
      })
    )
    expect(page.threads.map((t) => t.thread.id)).toEqual(['T_ok'])
  })

  it('fills a missing field rather than losing the thread', () => {
    const page = parseReviewThreadPage(
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ id: 'T1', comments: { nodes: [{ id: 'C1' }] } }]
              }
            }
          }
        }
      })
    )
    expect(page.threads[0]?.thread).toEqual({
      id: 'T1',
      path: '',
      line: null,
      originalLine: null,
      diffHunk: '',
      isResolved: false,
      isOutdated: false,
      comments: [
        { id: 'C1', author: '', authorIsBot: false, association: '', body: '', createdAt: null, url: '' }
      ]
    })
    expect(page.page).toEqual({ hasNextPage: false, endCursor: null })
  })

  it('refuses an answer with no threads connection rather than reading it as none', () => {
    // The whole `undefined` versus `[]` rule, made at the point the answer
    // arrives: "the query did not run" must never become "this pull request has
    // no diff-line comments".
    expect(() => parseReviewThreadPage('')).toThrow(/printed nothing/)
    expect(() => parseReviewThreadPage('<html>a login page</html>')).toThrow(/not JSON/)
    expect(() => parseReviewThreadPage('[]')).toThrow(/where a page of review threads/)
    expect(() =>
      parseReviewThreadPage(JSON.stringify({ data: { repository: { pullRequest: {} } } }))
    ).toThrow(/no review threads connection/)
    expect(() =>
      parseReviewThreadPage(JSON.stringify({ data: { repository: { pullRequest: null } } }))
    ).toThrow(/no review threads connection/)
  })

  it('reports GitHub’s own message when the answer is errors and no data', () => {
    expect(() =>
      parseReviewThreadPage(
        JSON.stringify({
          errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with 9.' }]
        })
      )
    ).toThrow(/Could not resolve to a PullRequest with 9\./)
  })
})

describe('parseThreadCommentPage', () => {
  it('reads a continuation page and its cursor', () => {
    const page = parseThreadCommentPage(
      JSON.stringify({
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: true, endCursor: 'CURSOR_101' },
              nodes: [
                {
                  id: 'PRRC_51',
                  author: { login: 'mona', __typename: 'User' },
                  authorAssociation: 'OWNER',
                  body: 'Reply fifty-one.',
                  createdAt: '2026-08-01T10:00:00Z',
                  url: 'https://github.com/o/n/pull/1#discussion_r51'
                }
              ]
            }
          }
        }
      })
    )
    expect(page.page).toEqual({ hasNextPage: true, endCursor: 'CURSOR_101' })
    expect(page.comments).toEqual([
      {
        id: 'PRRC_51',
        author: 'mona',
        authorIsBot: false,
        association: 'OWNER',
        body: 'Reply fifty-one.',
        createdAt: Date.parse('2026-08-01T10:00:00Z'),
        url: 'https://github.com/o/n/pull/1#discussion_r51'
      }
    ])
  })

  it('refuses an answer with no comments connection', () => {
    expect(() => parseThreadCommentPage(JSON.stringify({ data: { node: null } }))).toThrow(
      /no comments connection/
    )
  })
})

describe('heldReviewThreads', () => {
  const detail = (extra: Partial<PullDetail>): PullDetail => ({
    body: '',
    comments: [],
    reviews: [],
    commits: [],
    files: [],
    checks: null,
    mergeStateStatus: '',
    ...extra
  })

  it('reads a row cached before threads existed as not fetched, never as none', () => {
    // The single correctness rule of this feature. A detail with no key is a
    // pull request nobody has asked the question of, and answering `[]` would
    // be Helm stating as a fact that nobody annotated the diff.
    expect(heldReviewThreads(detail({}))).toBeUndefined()
    expect(heldReviewThreads(null)).toBeUndefined()
    expect(heldReviewThreads(undefined)).toBeUndefined()
  })

  it('reads an empty answer that actually came back as none', () => {
    expect(heldReviewThreads(detail({ reviewThreads: [] }))).toEqual([])
  })

  it('survives the round trip through the cache in both directions', () => {
    // How the distinction is kept: `JSON.stringify` drops an undefined value,
    // so a detail written with no threads comes back as an object with no key -
    // and one written with `[]` comes back as `[]`.
    // `exactOptionalPropertyTypes` is on, so the "never fetched" detail cannot
    // even be spelled with an explicit undefined - which is the type system
    // holding the same line: the key is absent or it is an array.
    const never = JSON.parse(JSON.stringify(detail({}))) as PullDetail
    const asked = JSON.parse(JSON.stringify(detail({ reviewThreads: [] }))) as PullDetail

    expect('reviewThreads' in never).toBe(false)
    expect(heldReviewThreads(never)).toBeUndefined()
    expect(heldReviewThreads(asked)).toEqual([])
  })

  it('collapses anything that is not an array to not-fetched, not to none', () => {
    // The safe direction. A sentence telling somebody to refresh costs a click;
    // a pull request reported as one nobody annotated costs the review.
    const reshaped = JSON.parse('{"reviewThreads":null}') as PullDetail
    expect(heldReviewThreads(reshaped)).toBeUndefined()
  })
})

describe('pullConversation', () => {
  const entry = (
    kind: 'comment' | 'review',
    id: string,
    at: string | null
  ): Record<string, unknown> =>
    kind === 'comment'
      ? { id, author: { login: 'a' }, body: id, createdAt: at, url: `u/${id}` }
      : { id, author: { login: 'b' }, body: id, submittedAt: at, state: 'COMMENTED' }

  const conversationOf = (payload: Record<string, unknown>): string[] =>
    pullConversation(parsePullDetail(JSON.stringify(payload))).map((e) => e.id)

  it('interleaves reviews and comments by the moment each happened', () => {
    expect(
      conversationOf({
        comments: [
          entry('comment', 'c1', '2026-08-01T10:00:00Z'),
          entry('comment', 'c2', '2026-08-03T10:00:00Z')
        ],
        reviews: [
          entry('review', 'r1', '2026-08-02T10:00:00Z'),
          entry('review', 'r2', '2026-08-04T10:00:00Z')
        ]
      })
    ).toEqual(['c1', 'r1', 'c2', 'r2'])
  })

  it('keeps a comment and the review of the same second in a fixed order', () => {
    // Common - a review is submitted with a comment - and an order decided by
    // the sort's internals would differ between two fetches of the same PR.
    const same = '2026-08-02T10:00:00Z'
    expect(
      conversationOf({
        comments: [entry('comment', 'c9', same)],
        reviews: [entry('review', 'r1', same)]
      })
    ).toEqual(['c9', 'r1'])
  })

  it('sinks an entry with no timestamp to the end rather than to the start', () => {
    expect(
      conversationOf({
        comments: [entry('comment', 'c1', null), entry('comment', 'c2', '2026-08-01T10:00:00Z')],
        reviews: [entry('review', 'r1', '2026-08-02T10:00:00Z')]
      })
    ).toEqual(['c2', 'r1', 'c1'])
  })

  it('carries the verdict of a review and nothing for a comment', () => {
    const merged = pullConversation(parsePullDetail(JSON.stringify(LIVE_DETAIL)))

    expect(merged.map((e) => [e.kind, e.kind === 'thread' ? '' : e.state])).toEqual([
      ['review', 'COMMENTED'],
      ['comment', '']
    ])
  })

  it('keeps a review whose body is empty, because the verdict is the message', () => {
    const merged = pullConversation(
      parsePullDetail(JSON.stringify({ reviews: [{ ...entry('review', 'r1', null), body: '' }] }))
    )

    expect(merged).toHaveLength(1)
    expect(merged[0]?.kind === 'thread' ? null : merged[0]?.body).toBe('')
  })

  const thread = (id: string, at: string | null, replyAt?: string): PullReviewThread => ({
    id,
    path: 'packages/core/src/github/parse.ts',
    line: 42,
    originalLine: 42,
    diffHunk: '@@ -1,2 +1,3 @@\n+const x = 1',
    isResolved: false,
    isOutdated: false,
    comments: [
      { id: `${id}c1`, author: 'a', authorIsBot: false, association: '', body: 'note', createdAt: at === null ? null : Date.parse(at), url: '' },
      ...(replyAt === undefined
        ? []
        : [{ id: `${id}c2`, author: 'b', authorIsBot: false, association: '', body: 'reply', createdAt: Date.parse(replyAt), url: '' }])
    ]
  })

  const withThreads = (threads: PullReviewThread[], payload: Record<string, unknown> = {}): PullDetail => ({
    ...parsePullDetail(JSON.stringify(payload)),
    reviewThreads: threads
  })

  it('puts a thread into the chronology at its first comment', () => {
    expect(
      pullConversation(
        withThreads([thread('t1', '2026-08-02T10:00:00Z')], {
          comments: [
            entry('comment', 'c1', '2026-08-01T10:00:00Z'),
            entry('comment', 'c2', '2026-08-03T10:00:00Z')
          ]
        })
      ).map((e) => e.id)
    ).toEqual(['c1', 't1', 'c2'])
  })

  it('sorts by the first comment and not by the last reply', () => {
    // A thread opened on Monday and replied to on Friday is a Monday remark.
    // Sorting by the reply would move a week of conversation to the bottom of
    // the page every time somebody answered it.
    expect(
      pullConversation(
        withThreads([thread('t1', '2026-08-01T10:00:00Z', '2026-08-09T10:00:00Z')], {
          comments: [entry('comment', 'c1', '2026-08-05T10:00:00Z')]
        })
      ).map((e) => e.id)
    ).toEqual(['t1', 'c1'])
  })

  it('carries the thread whole rather than flattening it into its comments', () => {
    const [item] = pullConversation(withThreads([thread('t1', '2026-08-01T10:00:00Z', '2026-08-02T10:00:00Z')]))

    expect(item?.kind).toBe('thread')
    if (item?.kind !== 'thread') throw new Error('the thread did not survive the merge')
    expect(item.comments).toHaveLength(2)
    expect(item.path).toBe('packages/core/src/github/parse.ts')
    expect(item.line).toBe(42)
    expect(item.diffHunk).toContain('@@ -1,2 +1,3 @@')
  })

  it('contributes nothing at all when the threads were never fetched', () => {
    // Not an empty run of entries and not a placeholder: "never fetched" is a
    // statement about the fetch, and the sentence that says so belongs to the
    // view rather than to the chronology.
    const never = parsePullDetail(JSON.stringify({ comments: [entry('comment', 'c1', null)] }))
    expect(pullConversation(never).map((e) => e.kind)).toEqual(['comment'])
    expect(pullConversation({ ...never, reviewThreads: [] }).map((e) => e.kind)).toEqual(['comment'])
  })
})

describe('parseGhAuth', () => {
  it('reads a sign-in from the exit code alone', () => {
    expect(parseGhAuth({ exitCode: 0, stdout: '', stderr: '' })).toEqual({
      authenticated: true,
      message: null
    })
  })

  it('reads a non-zero exit as not signed in, whichever stream gh used', () => {
    const onStderr = parseGhAuth({
      exitCode: 1,
      stdout: '',
      stderr: '  \nYou are not logged into any GitHub hosts.\n'
    })
    const onStdout = parseGhAuth({
      exitCode: 1,
      stdout: 'You are not logged into any GitHub hosts.',
      stderr: ''
    })

    expect(onStderr).toEqual({
      authenticated: false,
      message: 'You are not logged into any GitHub hosts.'
    })
    expect(onStdout).toEqual(onStderr)
  })

  it('reports "not signed in" for a gh that could not be run at all', () => {
    expect(parseGhAuth({ exitCode: null, stdout: '', stderr: '' })).toEqual({
      authenticated: false,
      message: null
    })
  })
})

describe('classifyGhFailure', () => {
  /**
   * Captured from `gh` 2.86 on Windows with the network made unreachable, not
   * invented. This is the failure the whole classifier exists for: it is what a
   * *fetch* prints when there is no route to github.com, and the reason the
   * fetch is what gets classified rather than `gh auth status` - see the case
   * below it, which is the same machine at the same moment.
   */
  const OFFLINE_FETCH =
    'Post "https://api.github.com/graphql": proxyconnect tcp: dial tcp 127.0.0.1:1: connectex: No connection could be made because the target machine actively refused it.'

  it('reads a connection failure as offline, not as a sign-in problem', () => {
    expect(classifyGhFailure(OFFLINE_FETCH)).toBe('offline')
  })

  it('reads a TLS failure as offline', () => {
    expect(
      classifyGhFailure(
        'Get "https://api.github.com/": tls: failed to verify certificate: x509: certificate signed by unknown authority'
      )
    ).toBe('offline')
    expect(classifyGhFailure('net/http: TLS handshake timeout')).toBe('offline')
  })

  it('reads DNS and timeouts as offline', () => {
    expect(classifyGhFailure('dial tcp: lookup api.github.com: no such host')).toBe('offline')
    expect(classifyGhFailure('context deadline exceeded (Client.Timeout exceeded)')).toBe('offline')
    expect(classifyGhFailure('connect ETIMEDOUT 140.82.121.6:443')).toBe('offline')
  })

  it('reads a refused token as auth', () => {
    expect(classifyGhFailure('HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe(
      'auth'
    )
    expect(
      classifyGhFailure('To get started with GitHub CLI, please run: gh auth login')
    ).toBe('auth')
  })

  /**
   * The reason `gh auth status` is not the thing being classified. Offline, it
   * exits 1 and prints exactly this - a sentence about the token, and an
   * instruction to replace a credential that is in fact perfectly good. Fed to
   * the classifier it reads as `auth`, which is why nothing on the offline path
   * is allowed to consult it.
   */
  it('would misread gh auth status offline, which is why fetches are classified instead', () => {
    expect(
      classifyGhFailure(
        'The token in keyring is invalid. To re-authenticate, run: gh auth login -h github.com'
      )
    ).toBe('auth')
    // Same machine, same second, the honest signal:
    expect(classifyGhFailure(OFFLINE_FETCH)).toBe('offline')
  })

  it('leaves a per-repository failure alone, 403 included', () => {
    // Neither of these is a fact about the machine, so neither may raise a
    // global banner. 403 in particular is spent on rate limits and on
    // permissions alike and says nothing about the sign-in.
    expect(classifyGhFailure("could not resolve to a Repository with the name 'o/r'")).toBe('other')
    expect(classifyGhFailure('HTTP 403: Resource not accessible by integration')).toBe('other')
    expect(classifyGhFailure('HTTP 404: Not Found')).toBe('other')
    expect(classifyGhFailure('gh printed something that is not JSON: <!DOCTYPE html>')).toBe(
      'other'
    )
  })

  it('prefers offline when a message could be read either way', () => {
    // A proxy that answers 401 for an unauthenticated tunnel is still the
    // network, and of the two readings only "you are offline" is safe to act
    // on: the other one asks the user to throw away a working login.
    expect(classifyGhFailure('proxyconnect tcp: HTTP 401 from the proxy')).toBe('offline')
  })
})

describe('parseGhVersion', () => {
  it('takes the first line, which is the one with the number on it', () => {
    expect(parseGhVersion('gh version 2.86.0 (2026-01-21)\nhttps://github.com/cli/cli\n')).toBe(
      'gh version 2.86.0 (2026-01-21)'
    )
  })

  it('reports nothing for nothing', () => {
    expect(parseGhVersion('')).toBeNull()
    expect(parseGhVersion('\n\n')).toBeNull()
  })
})

describe('renderPullPrompt', () => {
  const facts = {
    number: 42,
    url: 'https://github.com/coledtaylor/helm/pull/42',
    branch: 'feature/pulls',
    title: 'A Pull requests pane',
    slug: 'coledtaylor/helm'
  }

  it('substitutes every placeholder the setting documents', () => {
    for (const name of PR_PROMPT_PLACEHOLDERS) {
      expect(renderPullPrompt(`{${name}}`, facts)).not.toContain('{')
    }

    expect(renderPullPrompt('{slug}#{number} "{title}" {branch} {url}', facts)).toBe(
      'coledtaylor/helm#42 "A Pull requests pane" feature/pulls https://github.com/coledtaylor/helm/pull/42'
    )
  })

  it('renders the shipped default to the built-in skill invocation', () => {
    expect(renderPullPrompt(DEFAULT_PR_REVIEW_PROMPT, facts)).toBe('/code-review 42')
  })

  it('leaves a placeholder it does not know exactly as written', () => {
    // Not dropped: a misspelling has to be visible in the pane's disclosure
    // sentence rather than becoming a word missing from the argv.
    expect(renderPullPrompt('review {nubmer} and {author}', facts)).toBe(
      'review {nubmer} and {author}'
    )
  })

  it('does not rescan what it substituted', () => {
    // A title is written by a stranger and a template by the user; one pass is
    // what keeps the first from becoming the second.
    expect(renderPullPrompt('{title}', { ...facts, title: 'fix {number} off-by-one' })).toBe(
      'fix {number} off-by-one'
    )
  })

  it('flattens a value onto one line', () => {
    // The result is one positional argument, so a newline out of a title would
    // put a line break into the opening message.
    expect(renderPullPrompt('{title}', { ...facts, title: 'two\nlines\tand   spaces' })).toBe(
      'two lines and spaces'
    )
  })

  it('accepts a template with no placeholders at all', () => {
    expect(renderPullPrompt('/security-review', facts)).toBe('/security-review')
  })
})

describe('parseUnifiedDiff', () => {
  it('reads an added file, its hunk header and its line numbers', () => {
    const { files, truncated } = parseUnifiedDiff(
      [
        'diff --git a/docs/helm-demo.md b/docs/helm-demo.md',
        'new file mode 100644',
        'index 0000000..2a0d3f1',
        '--- /dev/null',
        '+++ b/docs/helm-demo.md',
        '@@ -0,0 +1,3 @@',
        '+# Helm demo page',
        '+',
        '+A tiny file so the pull-request pane has a diff to show.',
        ''
      ].join('\n')
    )

    expect(truncated).toBe(false)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: 'docs/helm-demo.md',
      status: 'added',
      additions: 3,
      deletions: 0
    })
    expect(files[0]?.hunks[0]?.header).toBe('@@ -0,0 +1,3 @@')
    expect(files[0]?.hunks[0]?.lines).toEqual([
      { kind: 'add', oldLine: null, newLine: 1, text: '# Helm demo page' },
      // An added line that is empty is a `+` on its own, and is still a line.
      { kind: 'add', oldLine: null, newLine: 2, text: '' },
      {
        kind: 'add',
        oldLine: null,
        newLine: 3,
        text: 'A tiny file so the pull-request pane has a diff to show.'
      }
    ])
  })

  it('walks both gutters through a mixed hunk', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/src/wheel.lua b/src/wheel.lua',
        '--- a/src/wheel.lua',
        '+++ b/src/wheel.lua',
        '@@ -10,4 +10,5 @@ function wheel.new()',
        ' local wheel = {}',
        '-wheel.spokes = 6',
        '+wheel.spokes = 8',
        '+wheel.rim = true',
        ' return wheel',
        ''
      ].join('\n')
    )

    expect(files[0]).toMatchObject({ status: 'modified', additions: 2, deletions: 1 })
    // The old side skips the additions and the new side skips the deletion,
    // which is the whole job of having two columns.
    expect(files[0]?.hunks[0]?.lines.map((line) => [line.kind, line.oldLine, line.newLine])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13]
    ])
    // The enclosing function is on the header, and is kept verbatim.
    expect(files[0]?.hunks[0]?.header).toBe('@@ -10,4 +10,5 @@ function wheel.new()')
  })

  it('keeps a deleted file under the name it had', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/old/gone.txt b/old/gone.txt',
        'deleted file mode 100644',
        '--- a/old/gone.txt',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-first',
        '-second',
        ''
      ].join('\n')
    )

    // `/dev/null` is not a path, so the head side never names this file.
    expect(files[0]).toMatchObject({ status: 'removed', path: 'old/gone.txt', deletions: 2 })
  })

  it('reads a rename, and finds the file under both of its names', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/docs/old.md b/docs/new.md',
        'similarity index 94%',
        'rename from docs/old.md',
        'rename to docs/new.md',
        '--- a/docs/old.md',
        '+++ b/docs/new.md',
        '@@ -1 +1 @@',
        '-# Old',
        '+# New',
        ''
      ].join('\n')
    )

    expect(files[0]).toMatchObject({
      status: 'renamed',
      path: 'docs/new.md',
      oldPath: 'docs/old.md'
    })
    // GitHub's JSON reports one path for a rename and it is not always this
    // one, so the index has to answer to both.
    expect(indexDiffByPath({ files, truncated: false }).get('docs/old.md')).toBe(files[0])
  })

  it('carries no lines for a binary file', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/logo.png b/logo.png',
        'index 1234567..89abcde 100644',
        'Binary files a/logo.png and b/logo.png differ',
        ''
      ].join('\n')
    )

    // The path comes off the `diff --git` line here: a binary file has no
    // `---`/`+++` pair to take one from.
    expect(files[0]).toMatchObject({ path: 'logo.png', binary: true, hunks: [] })
  })

  it('does not mistake diff syntax inside a hunk for the next file', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/notes.md b/notes.md',
        '--- a/notes.md',
        '+++ b/notes.md',
        '@@ -1,3 +1,4 @@',
        '+diff --git a/fake b/fake',
        '+--- a/fake',
        '+++++ b/fake',
        '+@@ -1 +1 @@',
        ''
      ].join('\n')
    )

    // Every one of those lines is signed, so every one of them is content. A
    // parser that matched on the text rather than on the sign would report
    // five files here and paint none of them right.
    expect(files).toHaveLength(1)
    expect(files[0]?.hunks[0]?.lines.map((line) => line.text)).toEqual([
      'diff --git a/fake b/fake',
      '--- a/fake',
      '++++ b/fake',
      '@@ -1 +1 @@'
    ])
  })

  it('unquotes the C-quoted path git writes for a non-ASCII name', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git "a/docs/\\303\\251clair.md" "b/docs/\\303\\251clair.md"',
        'new file mode 100644',
        '--- /dev/null',
        '+++ "b/docs/\\303\\251clair.md"',
        '@@ -0,0 +1 @@',
        '+one',
        ''
      ].join('\n')
    )

    // Octal escapes over the UTF-8 bytes, decoded together rather than one at
    // a time: those two escapes are one character.
    expect(files[0]?.path).toBe('docs/éclair.md')
  })

  it('counts every line but keeps only as many as it was asked to', () => {
    const body = Array.from({ length: 10 }, (_, at) => `+line ${String(at + 1)}`)
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/big.txt b/big.txt',
        '--- a/big.txt',
        '+++ b/big.txt',
        '@@ -0,0 +1,10 @@',
        ...body,
        ''
      ].join('\n'),
      { maxLinesPerFile: 4 }
    )

    expect(files[0]?.hunks[0]?.lines).toHaveLength(4)
    expect(files[0]?.droppedLines).toBe(6)
    // The counts are of the whole patch and not of what survived the cap: a
    // file that says +4 where GitHub says +10 is a file lying about its size.
    expect(files[0]?.additions).toBe(10)
  })

  it('reports a merge diff as a file with no patch rather than a shifted one', () => {
    const { files } = parseUnifiedDiff(
      [
        'diff --git a/merged.txt b/merged.txt',
        '--- a/merged.txt',
        '+++ b/merged.txt',
        '@@@ -1,2 -1,2 +1,3 @@@',
        '++both sides changed this',
        ''
      ].join('\n')
    )

    // Two sign columns, so every line is offset by one character from what an
    // ordinary hunk would read. Showing nothing is the honest answer.
    expect(files[0]?.hunks).toEqual([])
  })

  it('carries the truncation flag it was handed', () => {
    expect(parseUnifiedDiff('', { truncated: true }).truncated).toBe(true)
    expect(parseUnifiedDiff('').files).toEqual([])
  })
})

describe('the ignore list', () => {
  describe('isRepoSlug', () => {
    it('takes exactly two non-empty segments', () => {
      expect(isRepoSlug('acme/widget')).toBe(true)
      expect(isRepoSlug('a.b-c_d/E1')).toBe(true)
    })

    it('refuses anything a parsed remote would never produce', () => {
      for (const value of [
        'acme',
        'acme/',
        '/widget',
        'acme/widget/extra',
        'github.com/acme/widget',
        'https://github.com/acme/widget',
        'acme widget/x',
        ' acme/widget',
        'acme/widget ',
        ''
      ]) {
        expect(isRepoSlug(value)).toBe(false)
      }
    })
  })

  describe('isRepoIgnored', () => {
    it('matches whatever casing the remote was written in', () => {
      // The case that makes this worth a function: GitHub's own names are
      // case-insensitive, so a remote cloned as `Acme/Widget` and one cloned as
      // `acme/widget` are one repository - and an ignore list that only matched
      // the spelling the user happened to click would come back on after a
      // re-clone.
      expect(isRepoIgnored(['acme/widget'], 'Acme/Widget')).toBe(true)
      expect(isRepoIgnored(['Acme/Widget'], 'acme/widget')).toBe(true)
    })

    it('does not match a different repository or a directory with no origin', () => {
      expect(isRepoIgnored(['acme/widget'], 'acme/widget-two')).toBe(false)
      expect(isRepoIgnored(['acme/widget'], 'other/widget')).toBe(false)
      expect(isRepoIgnored([], 'acme/widget')).toBe(false)
      expect(isRepoIgnored(['acme/widget'], null)).toBe(false)
    })
  })

  describe('withRepoIgnored', () => {
    it('adds and removes, sorted, so the value does not depend on click order', () => {
      expect(withRepoIgnored([], 'b/two', true)).toEqual(['b/two'])
      expect(withRepoIgnored(['b/two'], 'a/one', true)).toEqual(['a/one', 'b/two'])
      expect(withRepoIgnored(['a/one', 'b/two'], 'a/one', false)).toEqual(['b/two'])
    })

    it('never leaves a second spelling of the same repository behind', () => {
      // Untick a row the list holds under another casing and the entry has to
      // go, or the box springs back on the next snapshot with nothing on screen
      // explaining why.
      expect(withRepoIgnored(['Acme/Widget'], 'acme/widget', false)).toEqual([])
      // And ticking one already held replaces it rather than adding a twin -
      // two entries for one repository is a value the validator refuses.
      expect(withRepoIgnored(['Acme/Widget'], 'acme/widget', true)).toEqual(['acme/widget'])
    })

    it('leaves the list it was given alone', () => {
      const held = ['a/one']
      expect(withRepoIgnored(held, 'b/two', true)).toEqual(['a/one', 'b/two'])
      expect(held).toEqual(['a/one'])
    })
  })
})
