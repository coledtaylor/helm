import type {
  PullChecks,
  PullComment,
  PullCommit,
  PullConversationItem,
  PullDetail,
  PullFile,
  PullReview,
  PullReviewDecision,
  PullReviewThread,
  PullSummary,
  PullThreadComment
} from './types'

/**
 * Turning what `gh` printed into what Helm holds.
 *
 * Kept apart from the spawn for the reason `discovery/git.ts` gives: the bugs
 * live in the parse, and a parse that needs a subprocess to exercise it is a
 * parse nothing tests against a malformed answer.
 *
 * The reading is deliberately lopsided. A payload that is not a JSON array is
 * an error and says so - it means `gh` printed something other than the answer,
 * and swallowing that would show an empty list where there is a problem. A
 * single *entry* that is missing a field is tolerated field by field, because
 * GitHub adds and removes them and one odd pull request must not blank a
 * repository's whole list. The one field with no sensible default is `number`:
 * it is the identity of the row, so an entry without one is dropped.
 */

/**
 * The fields `pr list` is asked for; the check drivers assert on this string.
 *
 * `statusCheckRollup` is on the **list** and not only the detail, which is a
 * deliberate cost: it is the field that turns a list of pull requests into a
 * list you can triage, and asking for it per-row is what lets the pane say
 * which branch is green without opening anything. It costs payload rather than
 * requests - the rollups come back inside the one query the poll already makes -
 * and it is reduced to three numbers here rather than carried whole.
 */
export const PR_LIST_FIELDS = [
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
].join(',')

/** How many pull requests a single repository may contribute. */
export const PR_LIST_LIMIT = 50

const REVIEW_DECISIONS = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** An RFC 3339 timestamp as epoch ms, or null when it is not one. */
function asMoment(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : at
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function reviewDecision(value: unknown): PullReviewDecision {
  const found = REVIEW_DECISIONS.find((decision) => decision === value)
  // `gh` prints `""` for a repository with no review requirement, which is a
  // different fact from "required and not yet reviewed" - both become null
  // here, and the pane paints a chip for neither.
  return found ?? null
}

/** An integer as GitHub prints it, or null when there is not one. */
function asLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/**
 * Who wrote something, and whether "who" is a program.
 *
 * Three signals, because the two fetches on this surface describe a bot in two
 * different vocabularies and neither is complete. `gh --json` reports
 * `is_bot: true` for the app installations it lists as `app/dependabot`, and
 * the prefix is what identifies them when it does not; GraphQL has no such flag
 * and answers with an `Actor` whose `__typename` is `Bot`. All three are read
 * here rather than in two near-identical functions, because the question -
 * "is this a person" - is one question.
 */
function personFrom(value: unknown): { login: string; isBot: boolean } {
  const author = asRecord(value)
  const login = asString(author?.['login'])
  return {
    login,
    isBot:
      author?.['is_bot'] === true || author?.['__typename'] === 'Bot' || login.startsWith('app/')
  }
}

/** One entry of the `pr list` array, or null when it has no number. */
function pullFrom(entry: unknown): PullSummary | null {
  const row = asRecord(entry)
  if (row === null) return null
  const number = row['number']
  if (typeof number !== 'number' || !Number.isInteger(number)) return null

  const author = personFrom(row['author'])
  const login = author.login
  const labels = Array.isArray(row['labels'])
    ? row['labels']
        .map((label) => asString(asRecord(label)?.['name']))
        .filter((name) => name !== '')
    : []

  return {
    number,
    title: asString(row['title']),
    url: asString(row['url']),
    author: login,
    authorIsBot: author.isBot,
    state: asString(row['state']),
    isDraft: row['isDraft'] === true,
    headRefName: asString(row['headRefName']),
    baseRefName: asString(row['baseRefName']),
    createdAt: asMoment(row['createdAt']),
    updatedAt: asMoment(row['updatedAt']),
    additions: asNumber(row['additions']),
    deletions: asNumber(row['deletions']),
    changedFiles: asNumber(row['changedFiles']),
    reviewDecision: reviewDecision(row['reviewDecision']),
    // The same reduction the detail makes, and null by the same rule: a list
    // that could not read a rollup paints no tick rather than a green one.
    checks: reduceChecks(row['statusCheckRollup']),
    labels
  }
}

/**
 * `gh pr list --json ...` output, as rows.
 *
 * Ordered newest-activity-first here rather than by whoever reads it, so the
 * list, the cache and the count all agree without three of them sorting.
 */
export function parsePullList(stdout: string): PullSummary[] {
  const trimmed = stdout.trim()
  // An empty answer is not an error: `gh` prints nothing at all when a
  // repository has no matching pull requests under some shells' redirection.
  if (trimmed === '') return []

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    throw new Error(`gh printed something that is not JSON: ${preview(trimmed)}`)
  }
  if (!Array.isArray(payload)) {
    throw new Error(`gh printed ${describe(payload)} where a list of pull requests was expected`)
  }

  const pulls: PullSummary[] = []
  for (const entry of payload) {
    const pull = pullFrom(entry)
    if (pull !== null) pulls.push(pull)
  }
  pulls.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return pulls
}

// ---------------------------------------------------------------------------
// The detail
// ---------------------------------------------------------------------------

/**
 * The fields `pr view` is asked for; the check drivers assert on this string.
 *
 * `files` is paths and counts and nothing else - there is no patch in here, and
 * that is still deliberate now that the Files view paints one. The patch comes
 * from `gh pr diff` instead, which is a separate call with a separate cache
 * column and a byte ceiling on it: folding it in here would put megabytes of
 * text inside the JSON payload that the header's counts and the whole
 * conversation also arrive in, and cache the two together with no way to cap one
 * without capping the other.
 */
export const PR_VIEW_FIELDS = [
  'body',
  'comments',
  'reviews',
  'commits',
  'files',
  'statusCheckRollup',
  'mergeStateStatus'
].join(',')

/** `COMPLETED` runs whose conclusion is one of these have failed. */
const FAILED_CONCLUSIONS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE'
])

/** Legacy commit-status states, which are a different vocabulary entirely. */
const FAILED_STATES = new Set(['FAILURE', 'ERROR'])
const PENDING_STATES = new Set(['PENDING', 'EXPECTED'])

/**
 * `statusCheckRollup`, reduced to a count that can be believed.
 *
 * The array is a GraphQL union and its members do not agree on anything. A
 * `CheckRun` is finished when `status` is `COMPLETED` and its verdict is in
 * `conclusion`; a `StatusContext` has no status at all and its verdict is in
 * `state`, spelled differently. So each entry is read for whichever of the two
 * vocabularies it turns out to speak, and an entry that speaks neither is
 * counted in `total` and left out of both verdicts - present, and not claimed
 * to have passed.
 *
 * Returns **null** rather than zeroes when the payload is not an array at all.
 * That is the whole degradation rule for this figure: the pane paints no checks
 * summary for null, because "0 checks" and "Helm could not read the checks" are
 * different facts and only one of them is safe to show as a green tick.
 */
export function reduceChecks(value: unknown): PullChecks | null {
  if (!Array.isArray(value)) return null

  let total = 0
  let failing = 0
  let pending = 0
  for (const entry of value) {
    const check = asRecord(entry)
    if (check === null) continue
    total += 1

    const status = asString(check['status']).toUpperCase()
    const conclusion = asString(check['conclusion']).toUpperCase()
    const state = asString(check['state']).toUpperCase()

    if (status !== '') {
      // A check run. `COMPLETED` is the only status with a verdict; everything
      // else - QUEUED, IN_PROGRESS, WAITING, REQUESTED, PENDING - is still to
      // come, and listing them exhaustively would be a list GitHub can extend.
      if (status === 'COMPLETED') {
        if (FAILED_CONCLUSIONS.has(conclusion)) failing += 1
      } else {
        pending += 1
      }
      continue
    }
    if (state !== '') {
      if (FAILED_STATES.has(state)) failing += 1
      else if (PENDING_STATES.has(state)) pending += 1
      continue
    }
    // Neither vocabulary. Counted, and claimed nothing about.
  }
  return { total, failing, pending }
}

function commentFrom(entry: unknown): PullComment | null {
  const row = asRecord(entry)
  if (row === null) return null
  const author = personFrom(row['author'])
  return {
    id: asString(row['id']),
    author: author.login,
    authorIsBot: author.isBot,
    association: asString(row['authorAssociation']),
    body: asString(row['body']),
    createdAt: asMoment(row['createdAt']),
    url: asString(row['url'])
  }
}

function reviewFrom(entry: unknown): PullReview | null {
  const row = asRecord(entry)
  if (row === null) return null
  const author = personFrom(row['author'])
  return {
    id: asString(row['id']),
    author: author.login,
    authorIsBot: author.isBot,
    association: asString(row['authorAssociation']),
    state: asString(row['state']).toUpperCase(),
    body: asString(row['body']),
    submittedAt: asMoment(row['submittedAt'])
  }
}

/**
 * One commit. A co-authored commit has several authors and one identity.
 *
 * The login is preferred over the name because it is what the rest of this
 * surface identifies people by, and the name is the fallback for a commit whose
 * email GitHub could not tie to an account - which is normal for a mirrored or
 * imported history and must not leave the column blank.
 */
function commitFrom(entry: unknown): PullCommit | null {
  const row = asRecord(entry)
  if (row === null) return null
  const oid = asString(row['oid'])
  // The sha is the identity of a commit row, so an entry without one is not a
  // commit this can show - same call `pullFrom` makes about `number`.
  if (oid === '') return null

  const authors = Array.isArray(row['authors']) ? row['authors'] : []
  const first = asRecord(authors[0])
  const login = asString(first?.['login'])
  const name = asString(first?.['name'])

  return {
    oid,
    messageHeadline: asString(row['messageHeadline']),
    author: login !== '' ? login : name,
    coAuthors: Math.max(0, authors.length - 1),
    committedAt: asMoment(row['committedDate']) ?? asMoment(row['authoredDate'])
  }
}

function fileFrom(entry: unknown): PullFile | null {
  const row = asRecord(entry)
  if (row === null) return null
  const path = asString(row['path'])
  if (path === '') return null
  return {
    path,
    additions: asNumber(row['additions']),
    deletions: asNumber(row['deletions'])
  }
}

/**
 * `gh pr view --json ...` output, as a detail.
 *
 * Lopsided the same way `parsePullList` is, and for the same reason: a payload
 * that is not a JSON object means gh printed something other than the answer
 * and must be reported, while a missing *field* inside it is tolerated. The
 * lists are the fields most likely to be absent - a repository with checks
 * disabled has no `statusCheckRollup` at all - and each one absent means an
 * empty view rather than an empty pull request.
 */
export function parsePullDetail(stdout: string): PullDetail {
  const trimmed = stdout.trim()
  if (trimmed === '') throw new Error('gh printed nothing where a pull request was expected')

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    throw new Error(`gh printed something that is not JSON: ${preview(trimmed)}`)
  }
  const row = asRecord(payload)
  if (row === null) {
    throw new Error(`gh printed ${describe(payload)} where a pull request was expected`)
  }

  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

  return {
    body: asString(row['body']),
    comments: list(row['comments'])
      .map(commentFrom)
      .filter((comment): comment is PullComment => comment !== null),
    reviews: list(row['reviews'])
      .map(reviewFrom)
      .filter((review): review is PullReview => review !== null),
    commits: list(row['commits'])
      .map(commitFrom)
      .filter((commit): commit is PullCommit => commit !== null),
    files: list(row['files'])
      .map(fileFrom)
      .filter((file): file is PullFile => file !== null),
    checks: reduceChecks(row['statusCheckRollup']),
    mergeStateStatus: asString(row['mergeStateStatus']).toUpperCase()
  }
}

// ---------------------------------------------------------------------------
// Review threads
// ---------------------------------------------------------------------------

/**
 * The GraphQL query behind the diff-line comments; the check driver asserts on
 * it the way it asserts on `PR_VIEW_FIELDS`.
 *
 * `gh api graphql` and not the REST `pulls/{n}/comments` endpoint, and not
 * `gh pr view --json` either, which cannot see these at all. REST would give
 * `in_reply_to_id` - enough to rebuild the threading - and carries **neither
 * `isResolved` nor `isOutdated`**, so a resolved objection would paint
 * identically to a live one. Reading the resolution wrong is worse than not
 * reading the threads.
 *
 * Both connections are paged and both `first:` are deliberately below GitHub's
 * limit of 100: 50 x 50 is 2,500 nodes a page, which is a request that always
 * comes back, and the loop in `fetchReviewThreads` walks the rest. A query
 * asking for `first: 100` twice over is 10,000 nodes and the first pull request
 * with a long review is the one it fails on.
 *
 * `diffHunk` is a field of the **comment**, not of the thread - GitHub has no
 * thread-level one - so the thread's hunk is its first comment's.
 *
 * **One line, and that is load-bearing rather than a formatting choice.** On
 * Windows a `gh` installed by scoop or npm is a batch file, so `resolveGhCommand`
 * routes it through `cmd.exe /c` - and cmd ends its command line at the first
 * newline, whatever quoting is around it. A pretty-printed query passed that way
 * arrives truncated at `query($owner: String!, ...` with every `-f` after it
 * gone, and the failure is silent: the request is still made, just without its
 * variables. Measured against a `.cmd` shim on 2.86 - the multi-line form
 * answered an empty page and exited 0. Nothing here may contain a newline, and
 * nothing may contain `&`, `|`, `<`, `>`, `^` or `%` either, for the same
 * reason and the same shim.
 */
export const PR_THREADS_QUERY =
  'query($owner: String!, $name: String!, $number: Int!, $cursor: String) { ' +
  'repository(owner: $owner, name: $name) { pullRequest(number: $number) { ' +
  'reviewThreads(first: 50, after: $cursor) { ' +
  'pageInfo { hasNextPage endCursor } ' +
  'nodes { id path line originalLine isResolved isOutdated ' +
  'comments(first: 50) { pageInfo { hasNextPage endCursor } ' +
  'nodes { id author { login __typename } authorAssociation body createdAt url diffHunk } } } } } } }'

/**
 * The continuation for one thread whose replies did not fit in a page.
 *
 * By node id rather than by re-walking the pull request, because the thread is
 * already identified and asking for the pull request again to reach reply 51 of
 * one thread would re-fetch every other thread beside it.
 *
 * One line, for the reason above.
 */
export const PR_THREAD_COMMENTS_QUERY =
  'query($id: ID!, $cursor: String) { node(id: $id) { ' +
  '... on PullRequestReviewThread { comments(first: 50, after: $cursor) { ' +
  'pageInfo { hasNextPage endCursor } ' +
  'nodes { id author { login __typename } authorAssociation body createdAt url diffHunk } } } } }'

/** Where a connection got to: whether there is more, and the cursor for it. */
export interface PageCursor {
  hasNextPage: boolean
  endCursor: string | null
}

/** One thread off a page, with its own comments' cursor beside it. */
export interface ParsedReviewThread {
  thread: PullReviewThread
  /** The thread's own `comments` connection, for the continuation query. */
  comments: PageCursor
}

/** One page of `reviewThreads`. */
export interface ReviewThreadPage {
  threads: ParsedReviewThread[]
  page: PageCursor
}

/** One page of a single thread's comments. */
export interface ThreadCommentPage {
  comments: PullThreadComment[]
  page: PageCursor
}

function pageCursorFrom(value: unknown): PageCursor {
  const info = asRecord(value)
  const cursor = info?.['endCursor']
  return {
    hasNextPage: info?.['hasNextPage'] === true,
    endCursor: typeof cursor === 'string' && cursor !== '' ? cursor : null
  }
}

function threadCommentFrom(entry: unknown): PullThreadComment | null {
  const row = asRecord(entry)
  if (row === null) return null
  const author = personFrom(row['author'])
  return {
    id: asString(row['id']),
    author: author.login,
    authorIsBot: author.isBot,
    association: asString(row['authorAssociation']),
    body: asString(row['body']),
    createdAt: asMoment(row['createdAt']),
    url: asString(row['url'])
  }
}

/**
 * The `data` of a GraphQL answer, or a thrown sentence saying what came back.
 *
 * `gh api graphql` exits non-zero and prints its complaint on stderr for a
 * query GitHub refused, so the caller usually never reaches here - but a
 * *partial* answer is a real shape: GitHub returns `data` with nulls in it and
 * an `errors` array beside it, and gh has been observed printing both. An
 * `errors` array with no data is a failed fetch and is thrown; the surface
 * above then keeps whatever threads it had rather than replacing them with the
 * half GitHub was willing to give.
 */
function graphqlData(stdout: string, wanted: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  if (trimmed === '') throw new Error(`gh printed nothing where ${wanted} was expected`)

  let payload: unknown
  try {
    payload = JSON.parse(trimmed)
  } catch {
    throw new Error(`gh printed something that is not JSON: ${preview(trimmed)}`)
  }
  const row = asRecord(payload)
  if (row === null) throw new Error(`gh printed ${describe(payload)} where ${wanted} was expected`)

  const data = asRecord(row['data'])
  if (data === null) {
    const errors = Array.isArray(row['errors']) ? row['errors'] : []
    const first = asString(asRecord(errors[0])?.['message'])
    throw new Error(first !== '' ? first : `gh printed no data where ${wanted} was expected`)
  }
  return data
}

/**
 * One page of review threads, as `PR_THREADS_QUERY` answers it.
 *
 * Lopsided the same way the other two parsers are: a payload with no
 * `reviewThreads` connection in it means the query did not run, and is thrown
 * rather than read as a pull request with no threads - which is the whole
 * `undefined` versus `[]` distinction, made at the point the answer arrives. A
 * missing *field* inside a thread is tolerated field by field.
 *
 * A thread with **no comments** is dropped. GitHub keeps such a thread when
 * every comment in it has been deleted, and it has no author, no body, no
 * moment to sit at in the chronology and nothing to say - a card with a file
 * name on it and nothing under it.
 */
export function parseReviewThreadPage(stdout: string): ReviewThreadPage {
  const data = graphqlData(stdout, 'a page of review threads')
  const pull = asRecord(asRecord(data['repository'])?.['pullRequest'])
  const connection = asRecord(pull?.['reviewThreads'])
  if (connection === null) {
    throw new Error('gh answered with no review threads connection on the pull request')
  }

  const threads: ParsedReviewThread[] = []
  for (const entry of Array.isArray(connection['nodes']) ? connection['nodes'] : []) {
    const row = asRecord(entry)
    if (row === null) continue
    const id = asString(row['id'])
    // The identity of the thread, and the key the continuation query needs.
    // Same call `pullFrom` makes about `number`.
    if (id === '') continue

    const comments = asRecord(row['comments'])
    const nodes: unknown[] = Array.isArray(comments?.['nodes']) ? comments['nodes'] : []
    const parsed = nodes
      .map(threadCommentFrom)
      .filter((comment): comment is PullThreadComment => comment !== null)
    if (parsed.length === 0) continue

    threads.push({
      thread: {
        id,
        path: asString(row['path']),
        line: asLine(row['line']),
        originalLine: asLine(row['originalLine']),
        // GitHub has no thread-level hunk; the first comment carries the one
        // the thread was written against.
        diffHunk: asString(asRecord(nodes[0])?.['diffHunk']),
        isResolved: row['isResolved'] === true,
        isOutdated: row['isOutdated'] === true,
        comments: parsed
      },
      comments: pageCursorFrom(comments?.['pageInfo'])
    })
  }

  return { threads, page: pageCursorFrom(connection['pageInfo']) }
}

/** One page of a single thread's comments, as `PR_THREAD_COMMENTS_QUERY` answers it. */
export function parseThreadCommentPage(stdout: string): ThreadCommentPage {
  const data = graphqlData(stdout, "a page of a thread's comments")
  const connection = asRecord(asRecord(data['node'])?.['comments'])
  if (connection === null) {
    throw new Error('gh answered with no comments connection on the review thread')
  }
  return {
    comments: (Array.isArray(connection['nodes']) ? connection['nodes'] : [])
      .map(threadCommentFrom)
      .filter((comment): comment is PullThreadComment => comment !== null),
    page: pageCursorFrom(connection['pageInfo'])
  }
}

/**
 * The threads a cached detail is holding, or undefined for "never fetched".
 *
 * **The single rule this feature turns on**, in one function so it cannot be
 * spelled two ways. A row cached before threads existed has no key; a row
 * written by a Helm whose thread fetch failed on a pull request that had never
 * had one has none either. Both are `undefined`, and `undefined` paints "not
 * fetched". Only an array that actually came back from GitHub is `[]`, and `[]`
 * paints nothing at all, because it means the question was asked and the answer
 * was none.
 *
 * Anything else in that column - a null written by hand, a shape from a version
 * that spelled this differently - collapses to `undefined` rather than to `[]`.
 * That is the safe direction: the cost of the wrong answer is a sentence
 * telling somebody to refresh, against a pull request silently reported as one
 * nobody annotated.
 */
export function heldReviewThreads(
  detail: PullDetail | null | undefined
): PullReviewThread[] | undefined {
  const held = detail?.reviewThreads
  return Array.isArray(held) ? held : undefined
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

/**
 * Reviews, comments and diff-line threads, in the order they happened.
 *
 * A stable sort with an explicit tie-break rather than a bare subtraction on
 * the timestamps: a review submitted in the same second as the comment that
 * triggered it is common, and an order that depended on the sort's internals
 * would put them either way round between two identical fetches. Entries with
 * no timestamp sink to the end, where they cannot claim a position in a
 * chronology they are not part of.
 *
 * A thread enters that order at its **first** comment, which is when the
 * exchange started - see `PullThreadEntry`. Threads that were never fetched
 * contribute nothing here at all rather than an empty run of entries; the
 * sentence explaining that is the view's, because it is a statement about the
 * fetch and not about the pull request.
 */
export function pullConversation(detail: PullDetail): PullConversationItem[] {
  const entries: PullConversationItem[] = [
    ...detail.comments.map((comment) => ({
      kind: 'comment' as const,
      id: comment.id,
      author: comment.author,
      authorIsBot: comment.authorIsBot,
      association: comment.association,
      state: '',
      at: comment.createdAt,
      body: comment.body,
      url: comment.url
    })),
    ...detail.reviews.map((review) => ({
      kind: 'review' as const,
      id: review.id,
      author: review.author,
      authorIsBot: review.authorIsBot,
      association: review.association,
      state: review.state,
      at: review.submittedAt,
      body: review.body,
      url: ''
    })),
    ...(heldReviewThreads(detail) ?? []).map((thread) => ({
      ...thread,
      kind: 'thread' as const,
      at: thread.comments[0]?.createdAt ?? null
    }))
  ]

  return entries.sort((a, b) => {
    if (a.at === null || b.at === null) {
      if (a.at === b.at) return a.id.localeCompare(b.id)
      return a.at === null ? 1 : -1
    }
    return a.at - b.at || a.id.localeCompare(b.id)
  })
}

/** First line of `gh --version`, which is the one carrying the number. */
export function parseGhVersion(stdout: string): string | null {
  const first = stdout.split('\n')[0]?.trim() ?? ''
  return first === '' ? null : first
}

export interface GhAuthReading {
  authenticated: boolean
  /** What gh said about not being signed in, trimmed to one line. */
  message: string | null
}

/**
 * Whether `gh` is signed in, decided from its exit code.
 *
 * The exit code and nothing else: `gh auth status` exits 0 when it has a usable
 * token for a host and 1 when it does not. Helm never opens `hosts.yml`, the
 * keyring, or `GH_TOKEN` - the same rule that governs Claude's credentials,
 * for the same reason. The text is read only to have something to show, and
 * both streams are consulted because gh has moved this output between them.
 */
export function parseGhAuth(result: {
  exitCode: number | null
  stdout: string
  stderr: string
}): GhAuthReading {
  if (result.exitCode === 0) return { authenticated: true, message: null }
  const said = `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  return { authenticated: false, message: said ?? null }
}

/** What a failed `gh` call turned out to be about. */
export type GhFailureKind =
  /** GitHub could not be reached at all: DNS, TCP, TLS, a proxy, a timeout. */
  | 'offline'
  /** GitHub was reached and refused the token. */
  | 'auth'
  /** Anything else, which is a fact about one repository rather than the machine. */
  | 'other'

/**
 * Markers that mean the request never got an answer from GitHub.
 *
 * Go's networking vocabulary, because that is what `gh` is written in, plus
 * Node's own `errno` spellings for the cases where the failure happens before
 * gh does - a spawn that timed out reports through `execFile`, not through
 * stderr. Substrings rather than patterns: these strings are stable across gh
 * releases in a way the surrounding sentence is not.
 */
const OFFLINE_MARKERS = [
  'dial tcp',
  'connectex',
  'proxyconnect',
  'no such host',
  'network is unreachable',
  'connection refused',
  'connection reset',
  'actively refused',
  'temporary failure in name resolution',
  'server misbehaving',
  'i/o timeout',
  'client.timeout',
  'context deadline exceeded',
  'handshake',
  'tls:',
  'x509:',
  'certificate',
  'etimedout',
  'econnrefused',
  'econnreset',
  'enotfound',
  'eai_again'
]

/** Markers that mean GitHub answered and would not accept the token. */
const AUTH_MARKERS = [
  'http 401',
  '401 unauthorized',
  'bad credentials',
  'requires authentication',
  'authentication required',
  'not logged into',
  'gh auth login'
]

/**
 * Why a `gh` call failed, as far as it can be told from what gh printed.
 *
 * This exists because `gh auth status` **cannot** tell these apart and says so
 * in the most misleading way available: with no route to github.com it exits 1,
 * reports "The token in keyring is invalid", and tells the user to run
 * `gh auth login` - for a token that is perfectly good. Reading that exit code
 * as a verdict is what made a dropped connection look like a signed-out
 * machine. A **fetch** failure does carry the distinction, so the fetch is what
 * Helm classifies and `gh auth status` is only ever asked when there is no
 * fetch to learn from.
 *
 * Connectivity is tested first and deliberately: a machine that cannot reach
 * GitHub often cannot reach it *while* holding a token gh is unsure about, and
 * of the two readings only "you are offline" is safe to act on. Telling someone
 * to re-authenticate because their wifi dropped costs them a working login.
 *
 * `403` is **not** an auth marker. GitHub spends it on rate limits and on
 * per-repository permission alike, and neither is a statement about the
 * machine's sign-in - both belong on the repository's own row.
 */
export function classifyGhFailure(message: string): GhFailureKind {
  const said = message.toLowerCase()
  if (OFFLINE_MARKERS.some((marker) => said.includes(marker))) return 'offline'
  if (AUTH_MARKERS.some((marker) => said.includes(marker))) return 'auth'
  return 'other'
}

function preview(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${JSON.stringify(value)}`
}
