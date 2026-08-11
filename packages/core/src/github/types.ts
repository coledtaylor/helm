/**
 * The shapes the pull-request surface is made of.
 *
 * GitHub.com only, deliberately: there is no provider abstraction here and no
 * room reserved for one. A second forge would need a different fetch mechanism
 * (this one is `gh`), a different auth story and a different set of fields, and
 * an interface guessed in advance would be wrong about all three.
 *
 * Pure by construction, like the rest of what `core/src/types.ts` re-exports:
 * the renderer imports these, so nothing here may reach `node:`.
 */

/** A `github.com` remote, resolved to what `gh --repo` takes. */
export interface RepoRemote {
  /** The remote URL exactly as git reported it. */
  url: string
  owner: string
  name: string
  /** `owner/name`. */
  slug: string
}

/**
 * GitHub's answer to "has this been reviewed", as `gh pr list` reports it.
 *
 * Null is a real value and not a missing one: a repository with no review
 * requirement returns null for every PR, which is a different fact from
 * "review required and nobody has looked yet".
 */
export type PullReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null

/** One open pull request, as the list view needs it. */
export interface PullSummary {
  number: number
  title: string
  url: string
  /** Login, because that is what identifies a person on a PR list. */
  author: string
  /** Bots open a lot of pull requests, and a list that cannot say so reads wrong. */
  authorIsBot: boolean
  /** `OPEN`, `MERGED`, `CLOSED` - upper case, as GitHub spells it. */
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  /**
   * Epoch milliseconds, or null when the timestamp could not be parsed.
   *
   * Nullable rather than zero-defaulted: an age caption computed from the epoch
   * would read "56y" and look like data rather than like a gap.
   */
  createdAt: number | null
  updatedAt: number | null
  additions: number
  deletions: number
  changedFiles: number
  reviewDecision: PullReviewDecision
  /** Label names only. Colours are GitHub's palette and this one is Helm's. */
  labels: string[]
}

/** Why the PR surface cannot fetch anything right now. */
export type GhProblemKind =
  /** No `gh` on this machine. */
  | 'missing'
  /** There is a `gh`, and it is not signed in. */
  | 'unauthenticated'
  /** It is there and signed in, and the last pass still failed. */
  | 'failed'

export interface GhProblem {
  kind: GhProblemKind
  /** A whole sentence, shown to the user as it is. */
  message: string
}

/**
 * What Helm found out about the `gh` CLI.
 *
 * Carries no credential and never will - the same rule the Claude CLI follows.
 * `authenticated` is decided from `gh auth status`'s **exit code**, and nothing
 * here opens gh's token store, its hosts file or the keyring behind it. The
 * whole remedy for `unauthenticated` is a sentence telling the user to run
 * `gh auth login` themselves.
 */
export interface GhStatus {
  /** The executable, or null when there is not one. */
  path: string | null
  /** `setting` when the user picked it, `discovered` when Helm found it. */
  source: 'setting' | 'discovered' | null
  /** First line of `gh --version`. */
  version: string | null
  authenticated: boolean
  problem: GhProblem | null
}

/** One discovered project, and the pull requests its origin remote has. */
export interface PullRepo {
  /** The project directory. The identity of a row, as everywhere else. */
  path: string
  /** Last path segment, for a list with no room for the rest. */
  name: string
  /** `git remote get-url origin`, or null when there is no origin. */
  url: string | null
  /** `owner/name`, or null when the origin is not a github.com remote. */
  slug: string | null
  /** When the last **successful** fetch landed. Epoch ms; null means never. */
  fetchedAtMs: number | null
  /** What went wrong on the last attempt, or null. Cached rows survive it. */
  error: string | null
  /** Open pull requests, most recently updated first. */
  pulls: PullSummary[]
}

/**
 * Everything the Pulls pane paints, cache included.
 *
 * Degradation here is **stale-with-age**, not degrade-to-nothing - which is the
 * opposite of the usage figures, and the difference is what the number means. A
 * plan-limit percentage from two hours ago is a wrong number; a pull request
 * that was open two hours ago is a fact about two hours ago, and captioning it
 * with its age is honest. So the age caption is not optional: `fetchedAtMs` is
 * on the snapshot precisely so no surface can paint the list without it.
 */
export interface PullsSnapshot {
  /** Repos with a github.com origin. Repos without one are counted, not listed. */
  repos: PullRepo[]
  /** Open pull requests across every repo. */
  open: number
  /** Discovered projects considered, whether or not they turned out to be GitHub. */
  checked: number
  gh: GhStatus
  /**
   * The **oldest** successful fetch among the repos on screen, which is what
   * the age caption reports. The oldest rather than the newest: a caption has
   * to describe the staleness of the whole list, and one repo refreshed a
   * moment ago does not make the other eleven current.
   */
  fetchedAtMs: number | null
  /** True while a pass is in flight, so the refresh control can say so. */
  fetching: boolean
}

/**
 * The polling interval, in minutes.
 *
 * The floor is not taste. Every pass is one `gh` process per distinct remote
 * against GitHub's API on the user's own token, and a one-minute sweep over a
 * dozen repositories is a rate limit waiting to happen. Zero is off entirely -
 * manual and focus refreshes still work - and it is deliberately outside the
 * range rather than a magic small number inside it.
 */
export const PR_POLL_MINUTES = { min: 5, max: 1440, default: 5, off: 0 } as const
