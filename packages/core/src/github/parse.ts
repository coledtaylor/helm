import type {
  PullChecks,
  PullComment,
  PullCommit,
  PullConversationEntry,
  PullDetail,
  PullFile,
  PullReview,
  PullReviewDecision,
  PullSummary
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

/**
 * Who wrote something, and whether "who" is a program.
 *
 * Two signals because gh reports the flag only for some accounts: the app
 * installations it lists as `app/dependabot` carry `is_bot: true`, and the
 * prefix is what identifies them when it does not.
 */
function personFrom(value: unknown): { login: string; isBot: boolean } {
  const author = asRecord(value)
  const login = asString(author?.['login'])
  return { login, isBot: author?.['is_bot'] === true || login.startsWith('app/') }
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

/**
 * Reviews and comments, in the order they happened.
 *
 * A stable sort with an explicit tie-break rather than a bare subtraction on
 * the timestamps: a review submitted in the same second as the comment that
 * triggered it is common, and an order that depended on the sort's internals
 * would put them either way round between two identical fetches. Entries with
 * no timestamp sink to the end, where they cannot claim a position in a
 * chronology they are not part of.
 */
export function pullConversation(detail: PullDetail): PullConversationEntry[] {
  const entries: PullConversationEntry[] = [
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

function preview(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${JSON.stringify(value)}`
}
