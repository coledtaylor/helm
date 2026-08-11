import type { PullReviewDecision, PullSummary } from './types'

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

/** The fields `pr list` is asked for; the check drivers assert on this string. */
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

/** One entry of the `pr list` array, or null when it has no number. */
function pullFrom(entry: unknown): PullSummary | null {
  const row = asRecord(entry)
  if (row === null) return null
  const number = row['number']
  if (typeof number !== 'number' || !Number.isInteger(number)) return null

  const author = asRecord(row['author'])
  const login = asString(author?.['login'])
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
    // Two signals because gh reports the flag only for some accounts: the app
    // installations it lists as `app/dependabot` carry `is_bot: true`, and the
    // prefix is what identifies them when it does not.
    authorIsBot: author?.['is_bot'] === true || login.startsWith('app/'),
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
