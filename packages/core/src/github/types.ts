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

// A type-only import of a name this module's own re-exporter also owns. It is
// erased before anything runs, so the cycle exists for the typechecker alone -
// and the alternative, spelling a review launch's effort as a bare `string`,
// would be a field that no longer agrees with the flag it becomes.
import type { EffortLevel } from '../types'

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
  /**
   * The check runs, reduced - or null when the rollup could not be read.
   *
   * On the summary and not only on the detail because "is this one green" is
   * the question a list of pull requests is read to answer. Null and zeroes
   * mean different things here exactly as they do on `PullDetail`: no checks
   * configured is `{total: 0}`, and a rollup Helm could not make sense of is
   * null and paints nothing.
   */
  checks: PullChecks | null
  /** Label names only. Colours are GitHub's palette and this one is Helm's. */
  labels: string[]
}

/**
 * One issue-level comment on a pull request.
 *
 * Issue-level is the whole of what `gh --json comments` can see: the comments
 * written in the conversation tab. Comments attached to a line of the diff live
 * on a review thread, which the JSON surface does not expose at all - those
 * come from a second fetch, `gh api graphql` over `pullRequest.reviewThreads`,
 * and arrive as `PullReviewThread`. The split is GitHub's rather than Helm's,
 * and it is recorded here because the two lists have to be merged into one
 * chronology by whatever paints them (`pullConversation` does it).
 */
export interface PullComment {
  /** GitHub's node id. Identity for a list key, never parsed. */
  id: string
  author: string
  authorIsBot: boolean
  /**
   * `MEMBER`, `CONTRIBUTOR`, `OWNER`, `NONE`, ... - how GitHub relates the
   * author to the repository, which is the one thing a reader wants beside a
   * name they do not recognise.
   */
  association: string
  /** Markdown as written. Rendering happens in the host, never here. */
  body: string
  createdAt: number | null
  url: string
}

/**
 * One review, meaning its **summary** body and verdict.
 *
 * The same split as `PullComment` and from the same cause: a review's inline
 * notes are diff-thread comments and arrive separately, as `PullReviewThread`,
 * so what is here is only the text written in the box above them. A review that
 * was nothing but inline notes therefore has an empty body, which is why an
 * entry with no body is still shown - the verdict is the information, and the
 * notes themselves are in the threads beside it.
 */
export interface PullReview {
  id: string
  author: string
  authorIsBot: boolean
  association: string
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, `PENDING`. */
  state: string
  body: string
  submittedAt: number | null
}

/**
 * One comment on a review thread - a note left against a line of the diff.
 *
 * Deliberately not `PullComment`, though the fields overlap almost entirely.
 * They come from different fetches with different vocabularies - `gh --json`
 * for one, GraphQL for the other - and the one field that differs is the one
 * that matters: an issue comment has nowhere to be, and this one is *at* a
 * place in a file. Folding them into one type would put a `diffHunk` on the
 * comments that have never had one.
 */
export interface PullThreadComment {
  /** GitHub's node id. Identity for a list key, never parsed. */
  id: string
  author: string
  authorIsBot: boolean
  /** `MEMBER`, `CONTRIBUTOR`, `OWNER`, `NONE`, ... as on `PullComment`. */
  association: string
  /** Markdown as written. Rendering happens in the host, never here. */
  body: string
  createdAt: number | null
  /** The `#discussion_r...` permalink. */
  url: string
}

/**
 * One conversation against a line of the diff, comments and all.
 *
 * A **thread** and not n loose comments, because that is what it is on GitHub
 * and what it has to read as here: a note and its replies are one exchange
 * about one line, and a conversation that listed them as five top-level entries
 * would be five people apparently talking past each other.
 *
 * Reached with `gh api graphql` over `pullRequest.reviewThreads` rather than
 * with the REST `pulls/{n}/comments` endpoint. REST gives `in_reply_to_id`,
 * which is enough to rebuild the threading, and carries **neither `isResolved`
 * nor `isOutdated`** - and a resolved thread painted identically to an open one
 * is a worse answer than no threads at all, because it reads as an objection
 * nobody ever dealt with. Still `gh`, so no token is handled here either.
 */
export interface PullReviewThread {
  id: string
  /** The head-side path the thread is anchored to. */
  path: string
  /**
   * The line in the head file, or null when the thread no longer has one.
   *
   * Null is the normal state of an outdated thread: the lines it was written
   * against have moved or gone, GitHub stops claiming a current position, and
   * `originalLine` is then the only honest number to show.
   */
  line: number | null
  /** The line as it was when the first comment was written. */
  originalLine: number | null
  /**
   * The `@@` run the first comment was left against, as GitHub wrote it.
   *
   * Verbatim text and painted as text, never as HTML - the same rule the Files
   * view follows, and for the same reason: this is a fragment of somebody's
   * branch, and no part of a branch may be markup on this surface.
   */
  diffHunk: string
  isResolved: boolean
  /** The diff has moved on since it was written. */
  isOutdated: boolean
  /** In the order they were written; the first is the note and the rest replies. */
  comments: PullThreadComment[]
}

/** One commit on the branch, as the Commits view lists it. */
export interface PullCommit {
  /** The full sha. Abbreviated where it is painted, never stored short. */
  oid: string
  messageHeadline: string
  /**
   * The first author's login, falling back to the name git recorded. A commit
   * can have several - a co-authored one does - and the list has room for the
   * one that identifies it.
   */
  author: string
  /** Extra authors beyond the first, so a co-authored commit can say so. */
  coAuthors: number
  committedAt: number | null
}

/** One changed file: what it is and how much of it moved. */
export interface PullFile {
  path: string
  additions: number
  deletions: number
}

/**
 * What happened to a file, as the patch's own headers say it.
 *
 * Read from the diff rather than inferred from the counts, and the difference
 * is real: a file whose every line changed has no deletions of its own in
 * GitHub's JSON when it was added, and a rename with no edits has neither. The
 * headers say `new file mode`, `deleted file mode` and `rename from` outright.
 */
export type PullFileStatus = 'added' | 'removed' | 'modified' | 'renamed'

/** One line of a hunk, with the two line numbers it sits at. */
export interface PullDiffLine {
  kind: 'add' | 'del' | 'context'
  /** Its number in the base file; null on an added line. */
  oldLine: number | null
  /** Its number in the head file; null on a removed line. */
  newLine: number | null
  /** The text with the leading sign removed - the gutter paints that. */
  text: string
}

/** One `@@` run of changes, header included. */
export interface PullDiffHunk {
  /**
   * The `@@ -0,0 +1,3 @@` line as git wrote it, trailing section heading and
   * all. Kept verbatim rather than recomposed from the numbers: git puts the
   * enclosing function on the end of it, which is the most useful thing on the
   * row and nothing here could reconstruct.
   */
  header: string
  lines: PullDiffLine[]
}

/** One file's patch. */
export interface PullFileDiff {
  /** The head-side path; for a delete, the path it had. */
  path: string
  /** Where a rename came from, or null. */
  oldPath: string | null
  status: PullFileStatus
  /** Counted from the lines actually parsed, not from GitHub's JSON. */
  additions: number
  deletions: number
  hunks: PullDiffHunk[]
  /** True when git said the two sides differ and declined to say how. */
  binary: boolean
  /**
   * Lines dropped to keep one file's payload bounded; 0 when the whole patch
   * is here. Counted rather than merely flagged, so the pane can say how much
   * it is not showing instead of hinting that something is missing.
   */
  droppedLines: number
}

/** A whole `gh pr diff`, parsed. */
export interface PullDiff {
  files: PullFileDiff[]
  /** True when the patch was cut short before it reached the parser. */
  truncated: boolean
}

/**
 * A patch as fetched, and whether it is the whole of one.
 *
 * Two fields rather than a bare string because the second one cannot be
 * recovered later: a patch cut at the byte ceiling is a perfectly well-formed
 * diff, and nothing about the text that reaches the cache says it used to be
 * longer. This is the shape the cache holds, so a pull request opened from the
 * cache a week later still knows to say so.
 */
export interface PullPatch {
  /** The patch as git wrote it, possibly cut at a line boundary. */
  text: string
  truncated: boolean
}

/**
 * The check runs, reduced to three numbers.
 *
 * Three numbers and not the list, because `statusCheckRollup` is a
 * heterogeneous GraphQL union - a `CheckRun` has `status`/`conclusion`, a
 * legacy `StatusContext` has `state`, and GitHub adds members to unions - and a
 * surface that rendered each entry would have to be right about every shape.
 * Counting is a claim this can actually keep.
 */
export interface PullChecks {
  total: number
  failing: number
  pending: number
}

/**
 * Everything behind a pull request, as one fetch of `gh pr view` returns it.
 *
 * Cached whole in `pull_requests.detail` and re-fetched only when asked, which
 * is why nothing rendered is in here: HTML belongs to the version of the
 * renderer that made it, and a cache holding it would paint last month's
 * markdown pipeline for as long as the pull request stayed open.
 */
export interface PullDetail {
  /** The description, as markdown. Empty is a real answer - many PRs have none. */
  body: string
  comments: PullComment[]
  reviews: PullReview[]
  commits: PullCommit[]
  files: PullFile[]
  /**
   * The diff-line conversations, or **undefined when they were never fetched**.
   *
   * The optionality is the whole point and is not tidiness. Threads arrive from
   * a second call that did not exist when this cache was first written, so
   * every row cached by an earlier Helm has no key here at all - and `[]` on
   * that row would be Helm stating, about a pull request it has never asked the
   * question of, that nobody wrote anything on the diff. `undefined` is "not
   * fetched" and paints a sentence saying so; `[]` is "asked, and there are
   * none" and paints nothing. **The two may never collapse into each other.**
   *
   * The distinction survives the cache by construction: `JSON.stringify` drops
   * an undefined value, so a detail written without threads round-trips as an
   * object with no such key. Reading one back goes through
   * `heldReviewThreads`, which is where the rule is enforced once.
   */
  reviewThreads?: PullReviewThread[]
  /**
   * When `reviewThreads` was last fetched. Epoch ms; undefined when never.
   *
   * Its own moment rather than `detailFetchedAt`, because the two really do
   * come apart: a refresh whose thread query failed keeps the threads it had -
   * this surface degrades stale-with-age, not to nothing - while everything
   * else on the tab is a second old. One timestamp for both would caption the
   * old threads with the new fetch's age, which is the caption being wrong in
   * the one case it exists for.
   */
  reviewThreadsFetchedAt?: number | null
  /**
   * Null when the rollup could not be read at all.
   *
   * Null rather than zeroes, and the distinction is the point: `{total: 0}`
   * means GitHub reported no checks, and null means Helm could not tell. A
   * surface paints nothing for null, because a wrong checks summary is worse
   * than an absent one.
   */
  checks: PullChecks | null
  /** `CLEAN`, `BLOCKED`, `DIRTY`, `BEHIND`, ... or '' when it was not reported. */
  mergeStateStatus: string
}

/**
 * A comment and a review, flattened into the one thing they are on screen.
 *
 * GitHub returns three lists and shows one conversation, and the merge is by
 * time: a review left between two comments happened between them, and three
 * separate stacks sorted only within themselves would be three chronologies
 * that disagree. `kind` survives the merge because a review carries a verdict
 * and a comment does not.
 */
export interface PullConversationEntry {
  kind: 'comment' | 'review'
  id: string
  author: string
  authorIsBot: boolean
  association: string
  /** A review's verdict; `''` for a comment. */
  state: string
  /** Epoch ms, or null when the timestamp would not parse. */
  at: number | null
  body: string
  /** The comment's permalink; `''` for a review, which gh does not give one. */
  url: string
}

/**
 * A review thread taking its place in that chronology.
 *
 * Its own member of the union rather than n `PullConversationEntry`s, because
 * the thread is the entity: it has one position in time - its first comment's -
 * one file and line, one hunk, and one resolved state that belongs to the whole
 * exchange rather than to any comment in it. Flattening it would lose all four.
 */
export interface PullThreadEntry extends Omit<PullReviewThread, 'id'> {
  kind: 'thread'
  id: string
  /**
   * The **first** comment's moment, which is when this exchange started.
   *
   * The first and not the last: a thread opened on Monday and replied to on
   * Friday is a Monday remark, and sorting by the reply would move a week of
   * conversation to the bottom of the page every time somebody answered it.
   */
  at: number | null
}

/** Everything the Conversation view paints, in one time order. */
export type PullConversationItem = PullConversationEntry | PullThreadEntry

/** A conversation entry whose markdown the host has already rendered. */
export interface RenderedPullEntry extends PullConversationEntry {
  /** Sanitised HTML, or `''` when the entry had no body. */
  html: string
}

/** One thread comment, rendered. */
export interface RenderedThreadComment extends PullThreadComment {
  /** Sanitised HTML, or `''` when the comment had no body. */
  html: string
}

/** A thread whose every comment the host has already rendered. */
export interface RenderedPullThread extends Omit<PullThreadEntry, 'comments'> {
  comments: RenderedThreadComment[]
}

/**
 * One item of the rendered conversation, discriminated by `kind`.
 *
 * The union is resolved in **main**, not in the window: the chronology is a
 * fact about the pull request and the pane's job is to paint it. A renderer
 * handed three arrays and told to interleave them would be a second copy of the
 * ordering rule, in the place least able to be unit-tested.
 */
export type RenderedPullItem = RenderedPullEntry | RenderedPullThread

/**
 * A changed file with its patch attached, as the Files view paints it.
 *
 * The counts are **GitHub's**, out of `pr view --json files`, and the hunks are
 * the patch's - which is deliberate rather than redundant. The two can disagree:
 * a patch capped at `MAX_DIFF_BYTES` or a file git declined to describe still
 * has honest counts on its header row, and a Files view that added up its own
 * visible lines instead would quietly under-report the size of exactly the pull
 * requests too big to show.
 */
export interface PullFileView extends PullFile {
  /** `modified` when there was no patch to read a header out of. */
  status: PullFileStatus
  /** Where a rename came from, or null. */
  oldPath: string | null
  /** Empty when the patch is missing, binary, or was never fetched. */
  hunks: PullDiffHunk[]
  binary: boolean
  droppedLines: number
}

/**
 * What the detail tab is painted from.
 *
 * The summary travels with it rather than being looked up beside it: the header
 * shows both - a title and a state from the list fetch, a file count and a
 * checks roll-up from the detail one - and a tab that assembled them from two
 * sources could show a title for a pull request whose detail had moved on.
 */
export interface PullDetailView {
  /** `owner/name`, so the pane can link out and name where this came from. */
  slug: string
  /** The project directory the tab was opened from. Identity of the tab. */
  repoPath: string
  summary: PullSummary
  detail: PullDetail
  /** The description rendered; `''` when there is none to render. */
  bodyHtml: string
  /** Reviews, comments and diff-line threads in one time order. */
  conversation: RenderedPullItem[]
  /**
   * Why the conversation is missing its diff-line threads, or has old ones, as
   * a sentence - and null when it is showing the threads GitHub has.
   *
   * A sentence rather than a flag, exactly like `diffNote`, because the three
   * reasons are not the same shape: a pull request cached before Helm fetched
   * threads at all, a thread query that failed just now on a tab that has older
   * threads to fall back on, and one that failed with nothing behind it. A view
   * that showed no threads and said nothing would read as a pull request nobody
   * annotated - which is the bug this whole fetch exists to fix, put back one
   * level up.
   */
  threadsNote: string | null
  /**
   * When the threads on screen were fetched. Epoch ms; null when never.
   *
   * Carried as a moment rather than baked into `threadsNote`, because the age
   * beside that sentence has to keep counting: every caption on this surface is
   * computed in the pane off a live clock, and one rendered in the main process
   * stops being true the second after it is sent.
   */
  threadsFetchedAtMs: number | null
  /** The changed files, each carrying whatever patch was fetched for it. */
  files: PullFileView[]
  /**
   * Why the Files view is showing less than the whole patch, as a sentence, or
   * null when it is showing all of it.
   *
   * A sentence rather than a flag because the reasons are not the same shape -
   * a patch capped at a byte ceiling, a `gh pr diff` that failed, a pull request
   * cached by a Helm that never fetched one - and a Files view that silently
   * listed paths with no diffs under them would look like a pull request that
   * changed nothing.
   */
  diffNote: string | null
  /** When the **detail** was fetched. Epoch ms; null when it is not known. */
  fetchedAtMs: number | null
  /** True when this answer came out of the cache and ran no `gh` at all. */
  cached: boolean
}

/**
 * Why the PR surface cannot fetch anything right now.
 *
 * Every one of these is a statement about the **machine**, not about one
 * repository, and only a full sweep in which nothing succeeded may raise one.
 * A repository that failed on its own carries its reason on its own row - see
 * `PullRepo.error` - because a single 404 is not a fact about GitHub.
 */
export type GhProblemKind =
  /** No `gh` on this machine. */
  | 'missing'
  /** There is a `gh`, GitHub answered, and it would not take the token. */
  | 'unauthenticated'
  /**
   * GitHub could not be reached at all - DNS, TCP, TLS, a proxy, a timeout.
   *
   * Kept apart from `unauthenticated` because the remedies are opposites and
   * the wrong one is expensive: `gh auth status` exits 1 and blames the token
   * when it merely has no route to github.com, so a surface that folded these
   * together told people to re-authenticate a login that was never broken.
   * Nothing on this branch may mention `gh auth login`.
   */
  | 'offline'
  /** It is there and reachable, and the last full sweep still failed. */
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
 * Nothing here opens gh's token store, its hosts file or the keyring behind it,
 * and the whole remedy for `unauthenticated` is a sentence telling the user to
 * run `gh auth login` themselves.
 *
 * `authenticated` is a **report, not a gate**. It starts as `gh auth status`'s
 * exit code, which is the only signal available before anything has been
 * fetched, and is corrected by the fetches themselves: a `pr list` that came
 * back proves the token works whatever `auth status` thought, and one refused
 * with a 401 proves it does not. Nothing may refuse to fetch because this field
 * is false - that is precisely how one dropped connection used to latch the
 * whole surface off until the app was restarted, since the only thing that
 * could have corrected the reading was the fetch it was suppressing.
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

/**
 * A repository the ignore list is keeping off the surface.
 *
 * Keyed by **slug** rather than by path, like the setting itself, so one entry
 * covers every checkout of the same repository - and the fetch, which is one
 * `gh` per distinct slug, is skipped once rather than per directory.
 */
export interface IgnoredRepo {
  /** `owner/name`, as `prIgnoredRepos` holds it. */
  slug: string
  /** A discovered checkout's folder name, or the slug's own half when none. */
  name: string
  /**
   * Whether a scanned project actually maps to this slug right now.
   *
   * The pane lists only the present ones - an ignored slug with no checkout on
   * this machine is hiding nothing, so naming it there would be noise. Settings
   * lists all of them, because an entry nothing maps to still has to be
   * removable.
   */
  present: boolean
  /**
   * Every scanned project that maps to this slug. Empty when `present` is false.
   *
   * Carried as well as `name`, because a surface scoped to **one** directory
   * cannot use a slug: a project pane asking "are my pull requests being
   * hidden" has a path and nothing else, and the ignore list is structurally
   * absent from `repos`. Without this the setting would hide itself on that
   * pane - the one thing the Pulls pane's Ignored section exists to prevent -
   * by making an ignored repository indistinguishable from a folder with no
   * github.com origin.
   */
  paths: string[]
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
  /**
   * Repos with a github.com origin. Repos without one are counted, not listed,
   * and ignored ones are in `ignored` rather than here.
   *
   * Structurally absent rather than flagged, deliberately: `open`,
   * `fetchedAtMs` and every count a surface derives are computed off this
   * array, so an ignored repository carried here behind a boolean would be one
   * forgotten filter away from being counted in a total it is not shown in.
   */
  repos: PullRepo[]
  /** What `prIgnoredRepos` is keeping off `repos`, so a pane can say so. */
  ignored: IgnoredRepo[]
  /** Open pull requests across every repo. */
  open: number
  /** Discovered projects considered, whether or not they turned out to be GitHub. */
  checked: number
  /**
   * How many of `checked` Helm has not read an origin remote for yet.
   *
   * The difference between "this machine has no GitHub repositories on it" and
   * "nobody has looked at them yet", which the surface has no other way to
   * express: a project with no row in `pr_repos` is indistinguishable from one
   * whose remote turned out not to be GitHub, and on a fresh install every
   * project is in that state for as long as the first sweep takes. Reporting
   * that as the former states a fact about somebody's disk that nothing has
   * checked.
   */
  unmapped: number
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

/**
 * How long a pull request may sit untouched before the Pulls pane files it
 * under STALE rather than ACTIVE, in days.
 *
 * **Two, and the default is a claim about a working day rather than about pull
 * requests.** A pull request touched today or yesterday is work in flight, and
 * the question this pane is read to answer - which of these needs attention -
 * is answered by that set. One that has survived a whole working day with
 * nothing happening to it has stopped being in flight and become something to
 * come back to, which is a different kind of row and belongs in a different
 * bucket. The two neighbouring values are both worse for a reason that can be
 * stated: at 1 every pull request opened on a Friday afternoon is stale by
 * Monday morning, so the split would be wrong about the most ordinary week
 * there is; at 7 almost nothing reaches the stale half and the split buys
 * nothing. It is a setting rather than a constant because the right answer is a
 * judgement about the user's own working rhythm - see `prStaleDays`.
 *
 * The ceiling is ninety days rather than unbounded: past a quarter, "untouched
 * for this long" has stopped being a statement about attention and the pane
 * would be sorting by archaeology. The floor is one day because the unit is
 * days, and an hours-granularity cutoff is a different setting than this one.
 *
 * **`0` is off and sits outside the range, not at the bottom of it** - the same
 * shape and the same argument as `PR_POLL_MINUTES`: a cutoff and *no cutoff at
 * all* are different states. Off means the Open section reverts to the single
 * flat list it was before this split existed, which is also the state that
 * makes the whole feature's no-regression claim trivially checkable.
 */
export const PR_STALE_DAYS = { min: 1, max: 90, default: 2, off: 0 } as const

/**
 * How many repositories the ignore list may name.
 *
 * A ceiling on a setting that is written whole on every toggle rather than a
 * statement about how many anybody has. It exists because the value is JSON in
 * one row and an unbounded array there is an unbounded write.
 */
export const PR_IGNORED_REPOS_MAX = 500

/**
 * `owner/name`, the only shape the ignore list holds.
 *
 * Anchored and deliberately narrow: this is compared against
 * `parseGitHubRemote`'s output, which is exactly two segments with no slashes,
 * no whitespace and no trailing `.git` in either of them.
 */
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/

export function isRepoSlug(value: string): boolean {
  return SLUG_PATTERN.test(value)
}

/**
 * Whether this repository's pull requests are being skipped.
 *
 * Case-insensitive, because GitHub's own names are: a remote written
 * `github.com/Owner/Repo` and one written `github.com/owner/repo` are the same
 * repository, and an ignore list that only matched the casing the user happened
 * to click would come back on after somebody re-cloned. Null - a directory with
 * no github.com origin - is never ignored: it is not on this surface anyway.
 */
export function isRepoIgnored(ignored: readonly string[], slug: string | null): boolean {
  if (slug === null) return false
  const wanted = slug.toLowerCase()
  return ignored.some((entry) => entry.toLowerCase() === wanted)
}

/**
 * The ignore list with one repository switched on or off.
 *
 * The whole list every time, because that is how the setting is written, and
 * the matching is the case-insensitive one above - so toggling `Owner/Repo`
 * when the list holds `owner/repo` removes the entry rather than adding a
 * second spelling of it. Sorted, so two machines that ignored the same
 * repositories in a different order hold the same value.
 */
export function withRepoIgnored(
  ignored: readonly string[],
  slug: string,
  on: boolean
): string[] {
  const wanted = slug.toLowerCase()
  const without = ignored.filter((entry) => entry.toLowerCase() !== wanted)
  const next = on ? [...without, slug] : without
  return next.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/**
 * What a review launch does to the working tree, if anything.
 *
 * `none` is the default and reviews from the pull request's refs: `gh` reads
 * the diff, the commits and the conversation over the network, so nothing has
 * to be fetched into the checkout and nothing anybody is halfway through gets
 * moved. `checkout` runs `gh pr checkout` first, for the review that wants to
 * run the tests - and it is refused outright on a dirty tree rather than
 * stashing, because a tool that moves somebody's uncommitted work is a tool
 * they stop trusting.
 *
 * An enum of two rather than a boolean, because the third value is already
 * known: a worktree mode would review a branch without disturbing the checkout
 * at all. It is deferred - junctions, the shim sweep and worktrees interact -
 * and this leaves the room for it.
 */
export const PR_CHECKOUT_MODES = ['none', 'checkout'] as const

export type PrCheckoutMode = (typeof PR_CHECKOUT_MODES)[number]

/**
 * What a review launch composed, once it has.
 *
 * `prompt` travels back rather than being re-derived in the window: it is what
 * the session was actually started with, and a pane that recomposed it from the
 * template would be reporting its own arithmetic instead of the launch's.
 */
export interface LaunchedReviewPlan {
  /** The repository directory the session runs in. */
  repoPath: string
  /** `owner/name`, for the tab's label. */
  slug: string
  number: number
  /** The trailing positional argument, already rendered. */
  prompt: string
  /**
   * The model and effort the session was started with, or null for the CLI's
   * own default. Out of settings, read in main at launch time - here so the
   * pane can report what actually ran rather than re-reading the settings it
   * previewed from, which is the same reason `prompt` travels back.
   */
  model: string | null
  effort: EffortLevel | null
  /** The branch `gh pr checkout` moved the tree to, or null when it did not run. */
  checkedOut: string | null
  /** Non-fatal notes: an overlay that was not there, a checkout that reported. */
  warnings: string[]
}
