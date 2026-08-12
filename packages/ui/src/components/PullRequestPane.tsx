import type { JSX, ReactNode } from 'react'
import { Fragment, useEffect, useState } from 'react'
import { MAX_FILE_LINES } from '@helm/core/types'
import type {
  PullDetailView,
  PullDiffHunk,
  PullFileStatus,
  PullFileView,
  RenderedPullEntry
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatMoment } from '../lib/time'
import {
  CaretIcon,
  CheckIcon,
  CloseIcon,
  LinkIcon,
  PullRequestIcon,
  RefreshIcon,
  TerminalIcon,
  WarnIcon
} from './icons'
import { fetchedCaption } from './PullsPane'

/**
 * One pull request, in its own workspace tab.
 *
 * Laid out as GitHub's own page is - a header of facts, then Conversation,
 * Commits and Files behind a segmented control - because that is the shape
 * anybody opening this already knows, and a rearrangement of it would be a new
 * thing to learn for no gain.
 *
 * **One island**, not three (DESIGN.md 3 and 7). The header, the view and the
 * review row are sections of a single surface separated by `.island-rule`s
 * rather than three panes with gutters between them: they are one page about
 * one pull request, and three floating slabs made the header read as a summary
 * card sitting above some other pane's contents. The 8px gutters bought nothing
 * and cost two of them out of the reading width.
 *
 * Two limits are visible here and are worth knowing before reading the
 * conversation as complete. `gh --json` exposes issue-level comments and the
 * summary body of each review; the notes people leave on individual lines of
 * the diff are review-thread comments and do not appear in it at all. And a
 * review submitted with no summary shows as a verdict with no text, because
 * that is exactly what it is.
 *
 * Markdown arrives already rendered. The pipeline - remark, rehype, GitHub's
 * sanitize schema, shiki - runs in the main process, so what lands here is HTML
 * this pane injects and never evaluates. Same arrangement as the content
 * viewer, and for the same two reasons: the grammars are megabytes the browser
 * bundle must not carry, and one sanitiser on one side of the wire is easier to
 * be sure of than two. The **diff** is the exception and deliberately so - it
 * arrives as parsed rows and is painted as text, never as HTML, so no part of
 * somebody's branch can be markup on this surface.
 */

export type PullView = 'conversation' | 'commits' | 'files'

const VIEWS: Array<{ id: PullView; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'commits', label: 'Commits' },
  { id: 'files', label: 'Files' }
]

/**
 * What a review launch turned out to be, for the pane to report afterwards.
 *
 * The prompt in here is **main's**, out of the launch's answer, not the preview
 * this pane rendered from the template - so the line under the button reports
 * what actually happened rather than re-stating its own guess.
 */
export interface LaunchedReviewNote {
  /** The session's name, as the tab strip labels it. */
  session: string
  /** The trailing positional the session was started with. */
  prompt: string
  /** The branch `gh pr checkout` moved the tree to, or null when it did not run. */
  checkedOut: string | null
  warnings: string[]
}

export interface PullRequestPaneProps {
  /** The pull request, rendered. Null until the first answer arrives. */
  view: PullDetailView | null
  loading: boolean
  /** A rejected `pr:detail`, shown as the sentence it is. */
  error?: string | null | undefined
  /** Fetches this pull request again, cache and all. */
  onRefresh: () => void
  refreshing: boolean
  /** Hands a URL to the OS browser. */
  onOpenExternal: (url: string) => void
  /** Docked beside a session split: the same pane with fewer columns. */
  compact?: boolean | undefined

  /**
   * Starts the review. Takes nothing: which pull request and what prompt are
   * both the main process's to decide (`pr:review`), and a pane that passed
   * either of them would be a pane whose copy could disagree with the stored
   * setting.
   */
  onReview: () => void
  reviewing: boolean
  /**
   * The prompt the button would run, rendered here from the template purely to
   * say so. A preview - it never travels anywhere.
   */
  reviewPrompt: string
  /** Whether `prCheckout` is on, which the disclosure sentence has to admit. */
  reviewCheckout: boolean
  /**
   * `prReviewModel` and `prReviewEffort`. Null for either means the launch
   * passes no flag for it, and the sentence then says nothing about it - naming
   * "the default" would be Helm claiming to know what the CLI will pick.
   */
  reviewModel?: string | null | undefined
  reviewEffort?: string | null | undefined
  /** A rejected `pr:review` - no gh, a dirty tree, no CLI. Dismissible. */
  reviewError?: string | null | undefined
  onDismissReviewError: () => void
  /** The last launch from this tab, or null if there has not been one. */
  reviewed?: LaunchedReviewNote | null | undefined
}

/**
 * What state a pull request is in, and the tone that says so.
 *
 * Hairline outlines in Helm's own semantic tones, never GitHub's solid green
 * and purple fills - the accent never floods and neither does anything else
 * here (DESIGN.md 1 and 4, and the PR-state note in 5). The mapping is recorded
 * in DESIGN.md so it cannot drift: open is a live thing (success), a draft is
 * not yet a claim about anything (neutral), merged is the outcome this app
 * treats as the accent moment, and closed-unmerged is the one negative outcome.
 */
const STATE_TONE = {
  open: 'border-success/40 text-success',
  draft: 'border-border-strong text-fg-muted',
  merged: 'border-accent/40 text-accent-text',
  closed: 'border-danger/40 text-danger'
} as const

type PullState = keyof typeof STATE_TONE

export function pullState(summary: { state: string; isDraft: boolean }): PullState {
  const state = summary.state.toUpperCase()
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  // Draft is checked after the closed states on purpose: a draft that was
  // closed is closed, and the draft flag stays set on it.
  return summary.isDraft ? 'draft' : 'open'
}

/**
 * GitHub's review decision, in words rather than as a chip.
 *
 * A word on the facts line and not a pill, because on this pane it sits beside
 * the checks tally and means the same *kind* of thing - a verdict on the branch
 * - while the pill beside the title is reserved for what the pull request *is*.
 * Two outlined pills in one header would read as two states.
 */
const DECISION_WORD: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'approved', className: 'text-success' },
  CHANGES_REQUESTED: { label: 'changes requested', className: 'text-danger' },
  REVIEW_REQUIRED: { label: 'review pending', className: 'text-warn' }
}

/** The clock the age captions run on. Same reason `PullsPane` has one. */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

export function PullRequestPane({
  view,
  loading,
  error = null,
  onRefresh,
  refreshing,
  onOpenExternal,
  compact = false,
  onReview,
  reviewing,
  reviewPrompt,
  reviewCheckout,
  reviewModel = null,
  reviewEffort = null,
  reviewError = null,
  onDismissReviewError,
  reviewed = null
}: PullRequestPaneProps): JSX.Element {
  const [shown, setShown] = useState<PullView>('conversation')
  const now = useNow()

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-island border border-border bg-surface">
      <Header
        view={view}
        now={now}
        shown={shown}
        onShow={setShown}
        onRefresh={onRefresh}
        refreshing={refreshing}
        onOpenExternal={onOpenExternal}
        compact={compact}
      />

      <Rule />

      <div data-pr-view-body={shown} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {error !== null && error !== undefined && (
          <p
            data-pr-error
            className="m-2 shrink-0 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] leading-[1.55] text-danger"
          >
            {error}
          </p>
        )}

        {view === null ? (
          <p className="px-4 py-6 text-[12px] text-fg-subtle">
            {loading || error === null ? 'Reading…' : 'Nothing to show.'}
          </p>
        ) : shown === 'conversation' ? (
          <Conversation view={view} now={now} compact={compact} onOpenExternal={onOpenExternal} />
        ) : shown === 'commits' ? (
          <Commits view={view} now={now} compact={compact} />
        ) : (
          <Files view={view} compact={compact} onOpenExternal={onOpenExternal} />
        )}
      </div>

      <Rule />

      <ReviewRow
        cwd={view?.repoPath ?? null}
        onReview={onReview}
        reviewing={reviewing}
        prompt={reviewPrompt}
        checkout={reviewCheckout}
        model={reviewModel}
        effort={reviewEffort}
        error={reviewError}
        onDismissError={onDismissReviewError}
        reviewed={reviewed}
        compact={compact}
      />
    </section>
  )
}

/** A divider between two sections of the island. DESIGN.md 3. */
function Rule(): JSX.Element {
  return <div aria-hidden className="island-rule shrink-0" />
}

// ---------------------------------------------------------------------------
// The review row
// ---------------------------------------------------------------------------

/**
 * The one thing this pane does rather than shows.
 *
 * Its own section at the foot of the island, not a button in the header,
 * because it is the only control here that starts a process - and a control
 * that spends money and opens a terminal does not belong in a row of view
 * switchers and refresh arrows.
 *
 * The sentence beside it is the house disclosure and it is not decoration. Helm
 * launches a CLI with an argv the user did not type, so the pane says the
 * program, the working directory and the exact opening prompt **before** the
 * button is pressed - which is also the only place a mistyped `{plceholder}` in
 * the template is visible, since `renderPullPrompt` deliberately leaves an
 * unknown one as written.
 *
 * What it does not do is read anything back. The review is an ordinary session
 * in an ordinary tab from the moment it starts; Helm parses none of its output,
 * and this row's last word on the subject is the name of the tab it went to.
 */
function ReviewRow({
  cwd,
  onReview,
  reviewing,
  prompt,
  checkout,
  model,
  effort,
  error,
  onDismissError,
  reviewed,
  compact
}: {
  cwd: string | null
  onReview: () => void
  reviewing: boolean
  prompt: string
  checkout: boolean
  model: string | null | undefined
  effort: string | null | undefined
  error: string | null | undefined
  onDismissError: () => void
  reviewed: LaunchedReviewNote | null | undefined
  compact: boolean
}): JSX.Element {
  // Nothing to review until the pull request has arrived: the working directory
  // and the prompt are both read off it, and a button that launched before then
  // would launch on a guess.
  const ready = cwd !== null && prompt !== ''

  return (
    <section data-pr-review-island className="shrink-0 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          data-pr-review
          onClick={onReview}
          disabled={!ready || reviewing}
          className={cn(
            // Outlined in the accent and tinted only on hover - the accent
            // never floods a surface in this system (DESIGN.md 4).
            'flex shrink-0 items-center gap-2 rounded-well border border-accent px-3.5 py-1.5',
            'text-[12px] font-medium text-accent-text transition-colors',
            !ready || reviewing
              ? 'cursor-default opacity-60'
              : 'hover:bg-accent-soft active:bg-active'
          )}
        >
          <TerminalIcon width={14} height={14} />
          {reviewing ? 'Starting…' : 'Review with Claude'}
        </button>

        <p
          data-pr-review-disclosure
          className="min-w-0 flex-1 text-[11px] leading-[1.6] text-fg-subtle"
        >
          {ready ? (
            <>
              Runs <Code>claude</Code> in <Code title={cwd}>{compact ? shortPath(cwd) : cwd}</Code>{' '}
              with the opening prompt <Code>{prompt}</Code>.
              {/* Named only when they are really passed. "on the default model"
                  would be Helm claiming to know which one the CLI will pick,
                  and the flag it does not send is exactly the flag it must not
                  describe. */}
              {(model ?? null) !== null && (
                <>
                  {' '}
                  <span data-pr-review-model={model}>
                    On <Code>{`--model ${String(model)}`}</Code>.
                  </span>
                </>
              )}
              {(effort ?? null) !== null && (
                <>
                  {' '}
                  <span data-pr-review-effort={effort}>
                    At <Code>{`--effort ${String(effort)}`}</Code>.
                  </span>
                </>
              )}
              {checkout && (
                <>
                  {' '}
                  <span data-pr-review-checkout>
                    Checks the branch out first with <Code>gh pr checkout</Code>, which is refused
                    if the tree has uncommitted changes.
                  </span>
                </>
              )}
            </>
          ) : (
            'Reading the pull request…'
          )}
        </p>
      </div>

      {/* Dismissible, and it stays until it is: a launch that failed is the one
          thing on this pane the user has to read, and a toast that faded would
          take the sentence explaining a dirty tree with it. */}
      {error !== null && error !== undefined && (
        <p
          data-pr-review-error
          role="alert"
          className="mt-2.5 flex items-start gap-2 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] leading-[1.55] text-danger"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            data-pr-review-dismiss
            onClick={onDismissError}
            aria-label="Dismiss"
            title="Dismiss"
            className="-my-0.5 grid size-5 shrink-0 place-items-center rounded text-danger/70 transition-colors hover:bg-danger/10 hover:text-danger"
          >
            <CloseIcon width={9} height={9} />
          </button>
        </p>
      )}

      {reviewed !== null && reviewed !== undefined && (
        <p
          data-pr-reviewed={reviewed.session}
          className="mt-2 text-[11px] leading-[1.6] text-fg-muted"
        >
          Started <Code>{reviewed.session}</Code>
          {reviewed.checkedOut !== null && (
            <span data-pr-reviewed-branch={reviewed.checkedOut}>
              {' '}
              on <Code>{reviewed.checkedOut}</Code>
            </span>
          )}
          . It is a session tab like any other now - Helm does not read what it says.
          {reviewed.warnings.map((warning) => (
            <span key={warning} className="block text-warn">
              {warning}
            </span>
          ))}
        </p>
      )}
    </section>
  )
}

/** Machine data inside a sentence: mono, and selectable so it can be copied. */
function Code({ children, title }: { children: string; title?: string }): JSX.Element {
  return (
    <code title={title} className="font-mono text-[10.5px] break-all text-fg-muted select-text">
      {children}
    </code>
  )
}

/** `…\repos\helm` - enough of a path to recognise, for a docked pane. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '')
  if (parts.length <= 2) return path
  return `…\\${parts.slice(-2).join('\\')}`
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/**
 * Three lines: what this is, the machine data about it, and how old it all is.
 *
 * The second line is mono wherever the value is machine data - a branch pair, a
 * diff size, a file count, a check tally (DESIGN.md 2). The author is a name, so
 * it is not; the review decision is a verdict in words, so it is not either.
 */
function Header({
  view,
  now,
  shown,
  onShow,
  onRefresh,
  refreshing,
  onOpenExternal,
  compact
}: {
  view: PullDetailView | null
  now: number
  shown: PullView
  onShow: (view: PullView) => void
  onRefresh: () => void
  refreshing: boolean
  onOpenExternal: (url: string) => void
  compact: boolean
}): JSX.Element {
  const summary = view?.summary ?? null
  const state = summary === null ? null : pullState(summary)
  const checks = view?.detail.checks ?? null
  const age = summary?.updatedAt == null ? null : formatAge(summary.updatedAt, now)
  const decision =
    summary?.reviewDecision == null ? undefined : DECISION_WORD[summary.reviewDecision]

  return (
    <header className="shrink-0 px-4 pt-2.5 pb-2">
      <div className="flex items-center gap-2.5">
        <PullRequestIcon width={15} height={15} className="shrink-0 text-accent" />
        <span
          data-pr-number={summary?.number ?? ''}
          className="shrink-0 font-mono text-[12px] tabular-nums text-fg-subtle"
        >
          #{summary?.number ?? '—'}
        </span>
        <h1
          data-pr-title
          title={summary?.title ?? ''}
          // 500 is the ceiling in this system; a page title is not an exception
          // to it (DESIGN.md 2).
          className="min-w-0 truncate text-[14px] font-medium tracking-tight text-fg"
        >
          {summary?.title ?? 'Pull request'}
        </h1>

        {/* Beside the title rather than over with the controls: the state is a
            fact about the pull request, and pinned right it reads as one more
            button. */}
        {state !== null && (
          <span
            data-pr-state={state}
            className={cn(
              'shrink-0 rounded-full border px-2 py-[1px] text-[10.5px] leading-[15px]',
              STATE_TONE[state]
            )}
          >
            {state}
          </span>
        )}

        <span className="flex-1" />

        {view !== null && (
          <button
            type="button"
            data-pr-external
            onClick={() => onOpenExternal(view.summary.url)}
            title={view.summary.url}
            className="flex shrink-0 items-center gap-1.5 rounded-well px-2 py-1 text-[11.5px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <LinkIcon width={11} height={11} />
            {compact ? 'GitHub' : 'Open on GitHub'}
          </button>
        )}

        <button
          type="button"
          data-pr-refresh
          onClick={onRefresh}
          disabled={refreshing}
          title="Fetch this pull request again"
          aria-label="Fetch this pull request again"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-1.5 flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-baseline gap-2 text-[11px] text-fg-subtle">
          {summary !== null && (
            <>
              <span className="min-w-0 max-w-[28%] truncate" data-pr-author>
                {summary.authorIsBot ? summary.author.replace(/^app\//, '') : summary.author}
              </span>
              {age !== null && (
                <>
                  <Sep />
                  <span
                    className="shrink-0 tabular-nums"
                    title={
                      summary.updatedAt === null
                        ? undefined
                        : `updated ${formatMoment(summary.updatedAt)}`
                    }
                  >
                    {age}
                  </span>
                </>
              )}
              {!compact && (
                <span data-pr-branch className="ml-1 min-w-0 truncate font-mono">
                  {summary.headRefName} &#8594; {summary.baseRefName}
                </span>
              )}
              <span className="ml-1 shrink-0 font-mono tabular-nums text-success" data-pr-adds>
                +{summary.additions}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-danger" data-pr-dels>
                &#8722;{summary.deletions}
              </span>
              <Sep />
              <span className="shrink-0 font-mono tabular-nums" data-pr-files>
                {summary.changedFiles} {summary.changedFiles === 1 ? 'file' : 'files'}
              </span>
              {/* Painted only when the roll-up could be read *and* had something
                  in it. An unreadable `statusCheckRollup` reduces to null and
                  this disappears - a wrong checks summary is worse than none. */}
              {checks !== null && checks.total > 0 && <Checks checks={checks} />}
              {decision !== undefined && (
                <span
                  data-pr-decision={summary.reviewDecision ?? ''}
                  className={cn('ml-1 shrink-0', decision.className)}
                >
                  {decision.label}
                </span>
              )}
              {view?.detail.mergeStateStatus === 'DIRTY' && (
                <span data-pr-conflicts className="ml-1 shrink-0 font-mono text-warn">
                  conflicts
                </span>
              )}
            </>
          )}
        </div>

        {/* A segmented control (DESIGN.md): sunken well, chosen segment lifted.
            Same control the config console switches its views with. */}
        <div
          role="group"
          aria-label="View"
          className="flex shrink-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              data-pr-view={option.id}
              aria-pressed={shown === option.id}
              onClick={() => onShow(option.id)}
              className={cn(
                'rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
                shown === option.id
                  ? SEGMENT_ON
                  : 'text-fg-muted hover:text-fg'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mandatory rather than decorative, exactly as on the list: everything
          above is a mirror of something on a server and is therefore always
          old, and a page of facts with no age on it is a claim about now. */}
      <p data-pr-caption className="mt-1 text-[10.5px] text-fg-subtle">
        {/* The list pane's own caption function, so the two surfaces cannot
            drift into saying "fetched just now" and "fetched now ago". */}
        {view === null ? 'reading…' : `${fetchedCaption(view.fetchedAtMs, now)} · ${view.slug}`}
      </p>
    </header>
  )
}

/** The separator between two facts that belong to each other. */
function Sep(): JSX.Element {
  return (
    <span aria-hidden className="shrink-0 text-fg-subtle/50">
      ·
    </span>
  )
}

function Checks({
  checks
}: {
  checks: { total: number; failing: number; pending: number }
}): JSX.Element {
  const failing = checks.failing > 0
  const pending = !failing && checks.pending > 0
  const passed = checks.total - checks.failing - checks.pending
  return (
    <span
      data-pr-checks={`${String(checks.total)}/${String(checks.failing)}/${String(checks.pending)}`}
      title={`${String(checks.total)} checks, ${String(checks.failing)} failing, ${String(checks.pending)} pending`}
      className={cn(
        'ml-1 flex shrink-0 items-center gap-1 font-mono tabular-nums',
        failing ? 'text-danger' : pending ? 'text-warn' : 'text-success'
      )}
    >
      {failing ? <WarnIcon width={11} height={11} /> : <CheckIcon width={11} height={11} />}
      {failing
        ? `${String(checks.failing)}/${String(checks.total)} failing`
        : pending
          ? `${String(checks.pending)}/${String(checks.total)} pending`
          : `${String(passed)}/${String(checks.total)} checks`}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/** How GitHub relates a person to the repository, in the words it uses. */
const ASSOCIATION: Record<string, string> = {
  OWNER: 'owner',
  MEMBER: 'member',
  COLLABORATOR: 'collaborator',
  CONTRIBUTOR: 'contributor',
  FIRST_TIME_CONTRIBUTOR: 'first contribution',
  FIRST_TIMER: 'first contribution'
}

/** A review's verdict, and the tone it carries. */
const VERDICT: Record<string, { label: string; className: string }> = {
  APPROVED: { label: 'approved', className: 'text-success' },
  CHANGES_REQUESTED: { label: 'requested changes', className: 'text-danger' },
  COMMENTED: { label: 'reviewed', className: 'text-fg-subtle' },
  DISMISSED: { label: 'dismissed', className: 'text-fg-subtle' },
  PENDING: { label: 'pending review', className: 'text-warn' }
}

function Conversation({
  view,
  now,
  compact,
  onOpenExternal
}: {
  view: PullDetailView
  now: number
  compact: boolean
  onOpenExternal: (url: string) => void
}): JSX.Element {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-pr-conversation={view.conversation.length}
    >
      <div className={cn('flex flex-col gap-2 py-3', compact ? 'px-3' : 'px-4')}>
        <Island
          header={
            <>
              <span className="text-[11.5px] text-fg">{view.summary.author}</span>
              {view.summary.authorIsBot && <Pill>bot</Pill>}
              <Meta>opened this</Meta>
              {view.summary.createdAt !== null && (
                <>
                  <Sep />
                  <Meta title={formatMoment(view.summary.createdAt)}>
                    {formatAge(view.summary.createdAt, now)}
                  </Meta>
                </>
              )}
            </>
          }
        >
          {view.bodyHtml === '' ? (
            <p data-pr-body-empty className="text-[12.5px] text-fg-subtle">
              No description.
            </p>
          ) : (
            <Body html={view.bodyHtml} hook="body" onOpenExternal={onOpenExternal} />
          )}
        </Island>

        {view.conversation.map((entry) => (
          <Entry key={entry.id} entry={entry} now={now} onOpenExternal={onOpenExternal} />
        ))}

        {/* Said once, at the bottom, where somebody has just finished reading a
            conversation that may be missing half of itself. */}
        <Note>
          Comments left on individual lines of the diff are not shown - the GitHub CLI&rsquo;s JSON
          does not expose them. Open the pull request on GitHub to read those.
        </Note>
      </div>
    </div>
  )
}

function Entry({
  entry,
  now,
  onOpenExternal
}: {
  entry: RenderedPullEntry
  now: number
  onOpenExternal: (url: string) => void
}): JSX.Element {
  const verdict = entry.kind === 'review' ? VERDICT[entry.state] : undefined
  const association = ASSOCIATION[entry.association]

  return (
    <Island
      hook={entry.id}
      kind={entry.kind}
      header={
        <>
          <span className="text-[11.5px] text-fg">
            {entry.authorIsBot ? entry.author.replace(/^app\//, '') : entry.author}
          </span>
          {entry.authorIsBot && <Pill>bot</Pill>}
          {association !== undefined && <Pill>{association}</Pill>}
          {verdict !== undefined && (
            <span data-pr-verdict={entry.state} className={cn('text-[10.5px]', verdict.className)}>
              {verdict.label}
            </span>
          )}
          {entry.at !== null && <Meta title={formatMoment(entry.at)}>{formatAge(entry.at, now)}</Meta>}
        </>
      }
    >
      {entry.html === '' ? (
        <p className="text-[12px] text-fg-subtle italic">
          {entry.kind === 'review' ? 'No summary - see the review on GitHub.' : 'No text.'}
        </p>
      ) : (
        <Body html={entry.html} hook={entry.id} onOpenExternal={onOpenExternal} />
      )}
    </Island>
  )
}

/** A raised card inside the pane island: a person, then what they wrote. */
function Island({
  header,
  children,
  hook,
  kind
}: {
  header: JSX.Element
  children: JSX.Element
  hook?: string | undefined
  kind?: string | undefined
}): JSX.Element {
  return (
    <article
      {...(hook !== undefined ? { 'data-pr-entry': hook } : {})}
      {...(kind !== undefined ? { 'data-pr-entry-kind': kind } : {})}
      className="overflow-hidden rounded-raised border border-border bg-surface-raised"
    >
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border px-3 py-1.5">
        {header}
      </header>
      <div className="px-3 py-2.5">{children}</div>
    </article>
  )
}

function Meta({ children, title }: { children: string; title?: string | undefined }): JSX.Element {
  return (
    <span title={title} className="text-[10.5px] text-fg-subtle">
      {children}
    </span>
  )
}

/**
 * How somebody relates to the repository, as a hairline pill.
 *
 * Outlined rather than bare text because it is a *label applied to a person*
 * rather than another fact in the row - "coledtaylor owner 40m" reads as three
 * unrelated words, and the outline is what makes the middle one belong to the
 * name before it. Neutral tone only: `owner` is not a status and must not carry
 * one (DESIGN.md 4, tags).
 */
function Pill({ children }: { children: string }): JSX.Element {
  return (
    <span className="rounded-full border border-border-strong px-1.5 py-px text-[9.5px] leading-[13px] text-fg-subtle">
      {children}
    </span>
  )
}

/** A closing sentence under a view: what this surface is not showing. */
function Note({ children }: { children: ReactNode }): JSX.Element {
  return <p className="px-1 pt-1 text-[10.5px] leading-[1.6] text-fg-subtle">{children}</p>
}

/**
 * Rendered markdown, injected.
 *
 * `dangerouslySetInnerHTML` is doing what it says, and what makes it acceptable
 * is upstream: the string was produced by `rehype-sanitize` in the main process
 * over GitHub's own schema, and nothing here evaluates any of it. What this
 * side owns is the click handling - a link in somebody's comment goes to the
 * browser, not to a navigation inside the app window.
 */
function Body({
  html,
  hook,
  onOpenExternal
}: {
  html: string
  hook: string
  onOpenExternal: (url: string) => void
}): JSX.Element {
  return (
    <div
      data-pr-body={hook}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement | null)?.closest('a')
        const href = anchor?.getAttribute('href') ?? ''
        if (!/^https?:|^mailto:/i.test(href)) return
        event.preventDefault()
        onOpenExternal(href)
      }}
      className="markdown select-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function Commits({
  view,
  now,
  compact
}: {
  view: PullDetailView
  now: number
  compact: boolean
}): JSX.Element {
  const commits = view.detail.commits
  if (commits.length === 0) return <Nothing>No commits on this branch.</Nothing>

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      data-pr-commits={commits.length}
    >
      <div className={cn('flex flex-col gap-1.5 py-3', compact ? 'px-3' : 'px-4')}>
        {commits.map((commit) => (
          <div
            key={commit.oid}
            data-pr-commit={commit.oid}
            title={commit.oid}
            className="flex items-baseline gap-3 rounded-raised border border-border bg-surface-raised px-3 py-2 transition-colors hover:bg-hover"
          >
            {/* Seven characters is what a sha is called in conversation; the row
                holds the whole one so a driver and a copy both get all forty. */}
            <span className="shrink-0 font-mono text-[11px] text-accent-text">
              {commit.oid.slice(0, 7)}
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-fg">
              {commit.messageHeadline}
            </span>
            {!compact && commit.coAuthors > 0 && (
              <span className="shrink-0 text-[10.5px] text-fg-subtle">
                +{commit.coAuthors} co-author{commit.coAuthors === 1 ? '' : 's'}
              </span>
            )}
            <span className="flex min-w-0 shrink-0 items-baseline gap-1.5 text-[10.5px] text-fg-subtle">
              <span className="min-w-0 max-w-[22ch] truncate">{commit.author}</span>
              <Sep />
              <span
                className="shrink-0 tabular-nums"
                title={commit.committedAt === null ? undefined : formatMoment(commit.committedAt)}
              >
                {commit.committedAt === null ? '-' : formatAge(commit.committedAt, now)}
              </span>
            </span>
          </div>
        ))}

        {/* The branch these are on, which is the one fact a list of shas cannot
            carry and the thing that makes the count checkable against GitHub. */}
        <Note>
          {commits.length} commit{commits.length === 1 ? '' : 's'} on{' '}
          <span className="font-mono">{view.summary.headRefName}</span>.
        </Note>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * What changed, and - now - what the change was.
 *
 * Helm showed paths and counts here until this version and linked out for the
 * patch, on the grounds that half a diff viewer is worse than a link. What
 * changed the call is that the missing half turned out to be small: a patch is
 * text, `gh pr diff` hands over the whole of one, and the parts that made a
 * real diff viewer hard - syntax grammars, whitespace modes, review threads -
 * are all things this view deliberately still does not do. So it paints hunks
 * as plain rows and keeps the link out, which is where the review threads and
 * the blame still are.
 *
 * Each file is collapsible and starts open. Starting open because a Files tab
 * that opens as a list of shut drawers is the list this used to be, with an
 * extra click added; collapsible because a pull request with forty files needs
 * a way to get past the ones already read.
 */
function Files({
  view,
  compact,
  onOpenExternal
}: {
  view: PullDetailView
  compact: boolean
  onOpenExternal: (url: string) => void
}): JSX.Element {
  const files = view.files
  // Collapsed rather than expanded, so the default needs no seeding from the
  // file list and a refresh that adds a file does not reopen the whole tab.
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set())

  if (files.length === 0) return <Nothing>No changed files.</Nothing>

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)

  const toggle = (path: string): void => {
    setShut((held) => {
      const next = new Set(held)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-pr-files-list={files.length}>
      <div className={cn('flex flex-col gap-1.5 py-3', compact ? 'px-3' : 'px-4')}>
        {view.diffNote !== null && (
          <p
            data-pr-diff-note
            className="rounded-raised border border-border bg-surface-sunken px-3 py-2 text-[11px] leading-[1.55] text-fg-muted"
          >
            {view.diffNote}
          </p>
        )}

        {files.map((file) => (
          <FileCard
            key={file.path}
            file={file}
            open={!shut.has(file.path)}
            onToggle={() => toggle(file.path)}
          />
        ))}

        <Note>
          <span data-pr-file-total className="font-mono tabular-nums">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>{' '}
          <span className="font-mono tabular-nums text-success">+{additions}</span>{' '}
          <span className="font-mono tabular-nums text-danger">&#8722;{deletions}</span>
          {' · '}
          Review threads on these lines live on GitHub -{' '}
          <button
            type="button"
            data-pr-diff-external
            onClick={() => onOpenExternal(`${view.summary.url}/files`)}
            className="rounded text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            open them there
          </button>
          .
        </Note>
      </div>
    </div>
  )
}

/** What a file's header row says happened to it. */
const STATUS_LABEL: Record<PullFileStatus, string> = {
  added: 'added',
  removed: 'removed',
  modified: 'modified',
  renamed: 'renamed'
}

function FileCard({
  file,
  open,
  onToggle
}: {
  file: PullFileView
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const hasPatch = file.hunks.length > 0
  const title = file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`

  const row = (
    <>
      <CaretIcon
        width={11}
        height={11}
        className={cn(
          'shrink-0 text-fg-subtle transition-transform',
          // Held rather than removed, so the paths of a file with no patch line
          // up with the paths of the files around it.
          !hasPatch && 'opacity-0',
          open && 'rotate-90'
        )}
      />

      {/* The directory ellipsises and the file name does not: the last segment
          is what identifies a row, and `packages/desktop/src/main/` is the part
          every row shares. Two spans rather than a right-to-left text
          direction, which is the usual trick for this and reorders the slashes
          around a path's neutral characters. */}
      <span className="flex min-w-0 items-baseline font-mono text-[11.5px]">
        {file.oldPath !== null && (
          <span className="min-w-0 truncate text-fg-subtle">
            {file.oldPath}&nbsp;&#8594;&nbsp;
          </span>
        )}
        <span className="min-w-0 truncate text-fg-subtle">{dirOf(file.path)}</span>
        <span className="shrink-0 text-fg">{baseOf(file.path)}</span>
      </span>

      <span
        data-pr-file-status={file.binary ? 'binary' : file.status}
        className="shrink-0 rounded-full border border-border-strong px-1.5 py-px text-[9px] leading-[13px] tracking-[.06em] text-fg-subtle uppercase"
      >
        {file.binary ? 'binary' : STATUS_LABEL[file.status]}
      </span>

      <span className="flex-1" />

      {/* A minimum measure so the two counts form columns down the list rather
          than shuffling with each row's digit count. */}
      <span className="min-w-[4ch] shrink-0 text-right font-mono text-[11px] tabular-nums text-success">
        +{file.additions}
      </span>
      <span className="min-w-[4ch] shrink-0 text-right font-mono text-[11px] tabular-nums text-danger">
        &#8722;{file.deletions}
      </span>
    </>
  )

  const shape = 'flex w-full items-center gap-2 px-2.5 py-1.5 text-left'

  return (
    <article
      data-pr-file={file.path}
      {...(hasPatch && open ? { 'data-pr-file-open': '' } : {})}
      className="overflow-hidden rounded-raised border border-border bg-surface-raised"
    >
      {/* A file with nothing to expand does not get a control that expands it:
          a caret that turns and reveals nothing is a broken control, not an
          empty one. Two elements rather than one with a swapped tag, because a
          button carries focus, a role and a keyboard contract that a div must
          not silently inherit. */}
      {hasPatch ? (
        <button
          type="button"
          data-pr-file-toggle={file.path}
          onClick={onToggle}
          aria-expanded={open}
          title={title}
          className={cn(shape, 'transition-colors hover:bg-hover')}
        >
          {row}
        </button>
      ) : (
        <div title={title} className={shape}>
          {row}
        </div>
      )}

      {hasPatch ? open && <Patch hunks={file.hunks} dropped={file.droppedLines} /> : <NoPatch file={file} />}
    </article>
  )
}

/** Why a listed file has no rows under it. Four different facts. */
function NoPatch({ file }: { file: PullFileView }): JSX.Element {
  return (
    <p className="border-t border-border px-3 py-1.5 text-[10.5px] text-fg-subtle">
      {file.binary
        ? 'Binary file - git records that it changed, not how.'
        : file.additions === 0 && file.deletions === 0
          ? 'No lines changed.'
          : 'No patch for this file in what was fetched.'}
    </p>
  )
}

/**
 * One file's hunks, as rows.
 *
 * Two gutters and a sign column, the way git thinks about a diff: the left
 * number is where a line was and the right is where it is, and an added line
 * has no left number because it was nowhere. Both gutters and the sign are
 * `select-none`, so dragging across a diff and copying it yields the code
 * rather than the code with line numbers welded onto every line.
 *
 * Wrapped rather than scrolled sideways. A horizontal scrollbar per file turns
 * reading a diff into operating one, and the pane is often docked at half
 * width where nothing would fit anyway.
 */
function Patch({ hunks, dropped }: { hunks: PullDiffHunk[]; dropped: number }): JSX.Element {
  return (
    <div className="border-t border-border font-mono text-[11px] leading-[1.6]">
      {hunks.map((hunk, at) => (
        <Fragment key={`${hunk.header}#${String(at)}`}>
          <div data-pr-hunk className="flex bg-surface-sunken pl-2 text-fg-subtle">
            <Gutter />
            <Gutter />
            <Sign />
            <span className="min-w-0 flex-1 py-[1px] pr-3 break-all whitespace-pre-wrap">
              {hunk.header}
            </span>
          </div>

          {hunk.lines.map((line, index) => (
            <div
              key={`${String(at)}:${String(index)}`}
              data-pr-diff-line={line.kind}
              className={cn(
                'flex pl-2',
                line.kind === 'add' && 'bg-success/[.08]',
                line.kind === 'del' && 'bg-danger/[.08]'
              )}
            >
              <Gutter>{line.oldLine}</Gutter>
              <Gutter>{line.newLine}</Gutter>
              <Sign kind={line.kind} />
              <span
                className={cn(
                  'min-w-0 flex-1 py-[1px] pr-3 break-all whitespace-pre-wrap select-text',
                  line.kind === 'context' ? 'text-fg-muted' : 'text-fg'
                )}
              >
                {line.text}
              </span>
            </div>
          ))}
        </Fragment>
      ))}

      {dropped > 0 && (
        <p
          data-pr-file-dropped={dropped}
          className="border-t border-border px-3 py-1 text-[10.5px] text-fg-subtle"
        >
          {dropped} more {dropped === 1 ? 'line' : 'lines'} in this file - Helm paints at most{' '}
          {MAX_FILE_LINES.toLocaleString()} of them. Read the rest on GitHub.
        </p>
      )}
    </div>
  )
}

/**
 * The sign column: what happened to this line, in the character git uses.
 *
 * `aria-hidden` and unselectable, because it is the row's tint said again for
 * anybody who cannot see a tint - a screen reader gets the line's text and
 * nothing else, and a copied diff comes out as code rather than as a patch.
 * Painted for a context line too, as a blank of the same width: the column has
 * to hold its place or every unchanged line would shift a character left.
 */
function Sign({ kind }: { kind?: 'add' | 'del' | 'context' }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'w-[2ch] shrink-0 select-none',
        kind === 'add' && 'text-success',
        kind === 'del' && 'text-danger'
      )}
    >
      {kind === 'add' ? '+' : kind === 'del' ? '-' : ''}
    </span>
  )
}

/**
 * The line-number column, which is deliberately the same width empty or full.
 *
 * `MAX_FILE_LINES` in `core/github/diff.ts` is what makes four characters
 * enough; a file long enough to need five has been cut long before then.
 */
function Gutter({ children }: { children?: number | null }): JSX.Element {
  return (
    <span className="w-[4ch] shrink-0 py-[1px] pr-2 text-right tabular-nums select-none text-fg-subtle/70">
      {children ?? ''}
    </span>
  )
}

function Nothing({ children }: { children: string }): JSX.Element {
  return <p className="px-4 py-6 text-[12px] text-fg-subtle">{children}</p>
}

/** `packages/ui/src/` of `packages/ui/src/Chip.tsx`; `''` at the root. */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at + 1)
}

function baseOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? path : path.slice(at + 1)
}
