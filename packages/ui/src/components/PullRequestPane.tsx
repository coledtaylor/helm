import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { PullDetailView, RenderedPullEntry } from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatAge, formatMoment } from '../lib/time'
import { CheckIcon, LinkIcon, PullRequestIcon, RefreshIcon, WarnIcon } from './icons'
import { fetchedCaption } from './PullsPane'

/**
 * One pull request, in its own workspace tab.
 *
 * Laid out as GitHub's own page is - a header of facts, then Conversation,
 * Commits and Files behind a segmented control - because that is the shape
 * anybody opening this already knows, and a rearrangement of it would be a new
 * thing to learn for no gain. What it is *not* is a diff viewer: the Files view
 * lists paths and line counts and hands the patch itself to the browser
 * (`shell:openExternal`). A diff needs syntax, wrapping, whitespace modes and
 * review threads, and half of one is worse than a link.
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
 * be sure of than two.
 */

export type PullView = 'conversation' | 'commits' | 'files'

const VIEWS: Array<{ id: PullView; label: string }> = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'commits', label: 'Commits' },
  { id: 'files', label: 'Files' }
]

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
  compact = false
}: PullRequestPaneProps): JSX.Element {
  const [shown, setShown] = useState<PullView>('conversation')
  const now = useNow()

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
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

      <div
        data-pr-view-body={shown}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface"
      >
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

/**
 * Two lines: what this is, then the machine data about it.
 *
 * The second line is mono throughout because every value on it is machine data
 * - a branch pair, a diff size, a file count, a check tally (DESIGN.md 2). The
 * author is a name, so it is not, and the fetched-at caption is a sentence, so
 * it is not either.
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

  return (
    <header className="shrink-0 rounded-island border border-border bg-surface px-4 py-2.5">
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
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5 text-[11px] text-fg-subtle">
          {summary !== null && (
            <>
              <span className="min-w-0 max-w-[28%] truncate" data-pr-author>
                {summary.authorIsBot ? summary.author.replace(/^app\//, '') : summary.author}
              </span>
              {age !== null && (
                <span
                  className="shrink-0 tabular-nums"
                  title={
                    summary.updatedAt === null ? undefined : `updated ${formatMoment(summary.updatedAt)}`
                  }
                >
                  {age}
                </span>
              )}
              {!compact && (
                <span data-pr-branch className="min-w-0 truncate font-mono">
                  {summary.headRefName}&#8594;{summary.baseRefName}
                </span>
              )}
              <span className="shrink-0 font-mono tabular-nums text-success" data-pr-adds>
                +{summary.additions}
              </span>
              <span className="shrink-0 font-mono tabular-nums text-danger" data-pr-dels>
                &#8722;{summary.deletions}
              </span>
              <span className="shrink-0 font-mono tabular-nums" data-pr-files>
                {summary.changedFiles} {summary.changedFiles === 1 ? 'file' : 'files'}
              </span>
              {/* Painted only when the roll-up could be read *and* had something
                  in it. An unreadable `statusCheckRollup` reduces to null and
                  this disappears - a wrong checks summary is worse than none. */}
              {checks !== null && checks.total > 0 && <Checks checks={checks} />}
              {view?.detail.mergeStateStatus === 'DIRTY' && (
                <span data-pr-conflicts className="shrink-0 font-mono text-warn">
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
                  ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
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

function Checks({ checks }: { checks: { total: number; failing: number; pending: number } }): JSX.Element {
  const failing = checks.failing > 0
  const pending = !failing && checks.pending > 0
  return (
    <span
      data-pr-checks={`${String(checks.total)}/${String(checks.failing)}/${String(checks.pending)}`}
      title={`${String(checks.total)} checks, ${String(checks.failing)} failing, ${String(checks.pending)} pending`}
      className={cn(
        'flex shrink-0 items-center gap-1 font-mono tabular-nums',
        failing ? 'text-danger' : pending ? 'text-warn' : 'text-success'
      )}
    >
      {failing ? <WarnIcon width={11} height={11} /> : <CheckIcon width={11} height={11} />}
      {failing
        ? `${String(checks.failing)}/${String(checks.total)} failing`
        : pending
          ? `${String(checks.pending)}/${String(checks.total)} pending`
          : `${String(checks.total)} passed`}
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
              {view.summary.authorIsBot && <Meta>bot</Meta>}
              <Meta>opened this</Meta>
              {view.summary.createdAt !== null && (
                <Meta title={formatMoment(view.summary.createdAt)}>
                  {formatAge(view.summary.createdAt, now)}
                </Meta>
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
        <p className="px-1 pt-1 text-[10.5px] leading-[1.6] text-fg-subtle">
          Comments left on individual lines of the diff are not shown - the
          GitHub CLI&rsquo;s JSON does not expose them. Open the pull request on
          GitHub to read those.
        </p>
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
          {entry.authorIsBot && <Meta>bot</Meta>}
          {association !== undefined && <Meta>{association}</Meta>}
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
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
      data-pr-commits={commits.length}
    >
      {commits.map((commit) => (
        <div
          key={commit.oid}
          data-pr-commit={commit.oid}
          title={commit.oid}
          className="flex items-baseline gap-2.5 rounded-well px-2.5 py-1.5 hover:bg-hover"
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
          <span className="min-w-0 max-w-[26%] shrink-0 truncate text-[10.5px] text-fg-subtle">
            {commit.author}
          </span>
          <span
            className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle"
            title={commit.committedAt === null ? undefined : formatMoment(commit.committedAt)}
          >
            {commit.committedAt === null ? '-' : formatAge(commit.committedAt, now)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * What changed, and by how much. Not the diff - see the file comment.
 *
 * The totals footer is the row that makes this checkable against GitHub without
 * counting a list by eye, and the link-out sentence is where the patch actually
 * is. Both are the honest version of a view that deliberately stops short.
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
  const files = view.detail.files
  if (files.length === 0) return <Nothing>No changed files.</Nothing>

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)

  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        data-pr-files-list={files.length}
      >
        {files.map((file) => (
          <div
            key={file.path}
            data-pr-file={file.path}
            title={file.path}
            className="flex items-baseline gap-2.5 rounded-well px-2.5 py-1 hover:bg-hover"
          >
            {/* The directory ellipsises and the file name does not: the last
                segment is what identifies a row, and
                `packages/desktop/src/main/` is the part every row shares. Two
                spans rather than a right-to-left text direction, which is the
                usual trick for this and reorders the slashes around a path's
                neutral characters. */}
            <span className="flex min-w-0 flex-1 items-baseline font-mono text-[11.5px]">
              <span className="min-w-0 truncate text-fg-subtle">{dirOf(file.path)}</span>
              <span className="shrink-0 text-fg-muted">{baseOf(file.path)}</span>
            </span>
            {/* A minimum measure so the two counts form columns down the list
                rather than shuffling with each row's digit count. */}
            <span className="min-w-[4ch] shrink-0 text-right font-mono text-[11px] tabular-nums text-success">
              +{file.additions}
            </span>
            <span className="min-w-[4ch] shrink-0 text-right font-mono text-[11px] tabular-nums text-danger">
              &#8722;{file.deletions}
            </span>
          </div>
        ))}
      </div>

      <footer
        className={cn(
          'shrink-0 border-t border-border px-4 py-2',
          compact ? 'text-[10.5px]' : 'text-[11px]'
        )}
      >
        <p className="flex items-baseline gap-2.5 text-fg-subtle">
          <span data-pr-file-total className="font-mono tabular-nums">
            {files.length} {files.length === 1 ? 'file' : 'files'}
          </span>
          <span className="font-mono tabular-nums text-success">+{additions}</span>
          <span className="font-mono tabular-nums text-danger">&#8722;{deletions}</span>
        </p>
        <p className="mt-1 leading-[1.6] text-fg-subtle">
          Helm does not show the diff.{' '}
          <button
            type="button"
            data-pr-diff-external
            onClick={() => onOpenExternal(`${view.summary.url}/files`)}
            className="rounded text-accent-text underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            Read it on GitHub
          </button>
          , where the review threads are too.
        </p>
      </footer>
    </>
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
