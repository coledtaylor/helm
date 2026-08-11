import type { JSX } from 'react'
import { Fragment, useEffect, useState } from 'react'
import type { PullRepo, PullsSnapshot, PullSummary } from '@helm/core/types'
import { Chip, type ChipTone } from './Chip'
import { cn } from '../lib/cn'
import { formatAge, formatMoment } from '../lib/time'
import { PullRequestIcon, RefreshIcon } from './icons'

/**
 * Every open pull request across the repositories Helm scans.
 *
 * The shape is `SessionHistory`'s - island header, bounded list, sticky caps
 * headers over grouped rows - because it answers the same kind of question and a
 * second list idiom would be a second thing to learn.
 *
 * What is different is the honesty. This list is a mirror of something on a
 * server, so it is **always** old, and the header says how old in the same
 * breath as it says how many: a count with no age is a claim about right now
 * that nothing here can make. When a fetch fails the rows stay and the reason
 * goes beside the repository that failed - a captioned stale list is worth more
 * than an empty one, which is the opposite of the call the usage figures make
 * and for the opposite reason (a stale percentage is wrong; a stale pull request
 * merely happened a while ago).
 *
 * There is no detail beside the list and therefore no `PaneBack`: a pull request
 * opens in its own workspace tab rather than in a panel here.
 *
 * Rows carry no buttons, per the house rule - the row itself is the action, and
 * everything else about a pull request is inside it.
 */

export interface PullsPaneProps {
  /** Cache first, then whatever the fetch found. Null before the first read. */
  snapshot: PullsSnapshot | null
  /** No argument sweeps everything; a path checks one repository. */
  onRefresh: (repoPath?: string) => void
  refreshing: boolean
  /** A rejected `pr:refresh`, which is a different failure from a repo's own. */
  error?: string | null | undefined
  /** Opens the pull request. Absent leaves the rows inert rather than lying. */
  onOpenPull?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
  /**
   * Docked beside a session split. The list is the whole pane either way; this
   * only drops the columns there is no longer room for.
   */
  compact?: boolean | undefined
}

/**
 * A clock for the age caption.
 *
 * The caption is the point of this pane and it changes with time rather than
 * with data, so nothing would repaint it: a snapshot that has not moved in
 * twenty minutes would still say "fetched 1m ago". Half a minute is finer than
 * anything `formatAge` can express below the hour mark.
 */
function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

const DECISION: Record<string, { label: string; tone: ChipTone }> = {
  APPROVED: { label: 'approved', tone: 'success' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'danger' },
  REVIEW_REQUIRED: { label: 'review required', tone: 'neutral' }
}

/** "fetched 4m ago", or the sentence for a list nothing has ever filled. */
export function fetchedCaption(fetchedAtMs: number | null, now: number): string {
  if (fetchedAtMs === null) return 'not fetched yet'
  const age = formatAge(fetchedAtMs, now)
  return age === 'now' ? 'fetched just now' : `fetched ${age} ago`
}

/**
 * The sidebar's second line: a count, or the reason there is not one.
 *
 * A short form of each problem rather than the pane's full sentence. The pane
 * has a paragraph's width and can name the remedy; a 280px rail has room for
 * about four words, and a truncated instruction is worse than a label that
 * sends you to the pane to read it.
 */
export function pullsSummaryLine(snapshot: PullsSnapshot | null): string {
  if (snapshot === null) return 'Reading…'
  switch (snapshot.gh.problem?.kind) {
    case 'missing':
      return 'GitHub CLI not installed'
    case 'unauthenticated':
      return 'Run gh auth login'
    case 'failed':
      return 'GitHub could not be reached'
    default:
      break
  }
  if (snapshot.repos.length === 0) return 'No github.com repositories'
  const repos = snapshot.repos.length
  return `${String(snapshot.open)} open · ${String(repos)} ${repos === 1 ? 'repo' : 'repos'}`
}

export function PullsPane({
  snapshot,
  onRefresh,
  refreshing,
  error = null,
  onOpenPull,
  compact = false
}: PullsPaneProps): JSX.Element {
  const now = useNow()
  const repos = snapshot?.repos ?? []
  const problem = snapshot?.gh.problem ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <PullRequestIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="text-[13px] font-medium tracking-tight text-fg">Pull requests</h1>
        {snapshot !== null && (
          <p data-pulls-caption className="min-w-0 truncate text-[11px] text-fg-subtle">
            <Count n={snapshot.open} one="open" many="open" /> ·{' '}
            <Count n={repos.length} one="repo" many="repos" /> ·{' '}
            {/* Mandatory, not decorative: see the file comment. */}
            <span className="text-fg-muted">{fetchedCaption(snapshot.fetchedAtMs, now)}</span>
          </p>
        )}
        <span className="flex-1" />
        <button
          type="button"
          data-pulls-refresh
          onClick={() => onRefresh()}
          disabled={refreshing}
          title={
            snapshot?.gh.path === null || snapshot?.gh.path === undefined
              ? 'Check every repository for open pull requests'
              : `Run ${snapshot.gh.path} against every repository`
          }
          aria-label="Check for open pull requests"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
        {problem !== null && (
          <p
            data-pulls-problem={problem.kind}
            className={cn(
              'm-2 shrink-0 rounded-raised border px-3 py-2 text-[11.5px] leading-[1.55]',
              problem.kind === 'missing'
                ? 'border-border bg-surface-sunken text-fg-muted'
                : 'border-warn/30 bg-warn/10 text-warn'
            )}
          >
            {problem.message}
          </p>
        )}

        {error !== null && error !== undefined && (
          <p className="m-2 shrink-0 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
            {error}
          </p>
        )}

        <div
          role="group"
          aria-label="Open pull requests"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        >
          {repos.length === 0 ? (
            <Empty snapshot={snapshot} />
          ) : (
            repos.map((repo) => (
              <Fragment key={repo.path}>
                <button
                  type="button"
                  data-pulls-repo={repo.slug ?? ''}
                  onClick={() => onRefresh(repo.path)}
                  title={`Check ${repo.slug ?? repo.name} for pull requests now - ${repo.path}`}
                  className={cn(
                    'sticky top-0 z-10 mt-3 flex w-full items-baseline gap-2 bg-surface px-2 py-1',
                    'text-left text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase',
                    'first:mt-0 hover:text-fg'
                  )}
                >
                  <span className="min-w-0 truncate">{repo.name}</span>
                  {!compact && repo.slug !== null && (
                    <span className="min-w-0 truncate font-mono text-[10px] tracking-normal normal-case">
                      {repo.slug}
                    </span>
                  )}
                  <span className="flex-1" />
                  <span className="tabular-nums">{repo.pulls.length}</span>
                </button>

                {repo.error !== null && (
                  <p
                    data-pulls-repo-error={repo.slug ?? ''}
                    className="mx-2 mb-1 truncate text-[10.5px] text-danger"
                    title={repo.error}
                  >
                    {repo.error}
                  </p>
                )}

                {repo.pulls.length === 0 ? (
                  <p className="px-3 py-1.5 text-[11.5px] text-fg-subtle">Nothing open.</p>
                ) : (
                  repo.pulls.map((pull) => (
                    <Row
                      key={`${repo.path}#${String(pull.number)}`}
                      repo={repo}
                      pull={pull}
                      now={now}
                      compact={compact}
                      {...(onOpenPull ? { onOpen: onOpenPull } : {})}
                    />
                  ))
                )}
              </Fragment>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * One pull request. Two lines: what it is, then the machine data under it.
 *
 * Everything on the second line is mono because everything on it is machine
 * data - a branch pair and a diff size are not prose (DESIGN.md par. 2). The
 * author is not, so it is not.
 */
function Row({
  repo,
  pull,
  now,
  compact,
  onOpen
}: {
  repo: PullRepo
  pull: PullSummary
  now: number
  compact: boolean
  onOpen?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
}): JSX.Element {
  const age = pull.updatedAt === null ? null : formatAge(pull.updatedAt, now)
  const decision = pull.reviewDecision === null ? null : DECISION[pull.reviewDecision]
  const author = pull.authorIsBot ? pull.author.replace(/^app\//, '') : pull.author

  return (
    <button
      type="button"
      data-pull={`${repo.slug ?? ''}#${String(pull.number)}`}
      disabled={onOpen === undefined}
      onClick={() => onOpen?.(repo, pull)}
      title={
        pull.updatedAt === null
          ? pull.title
          : `${pull.title} - updated ${formatMoment(pull.updatedAt)}`
      }
      className={cn(
        'flex w-full flex-col gap-0.5 rounded-well px-2 py-1.5 text-left transition-colors',
        onOpen === undefined ? 'cursor-default' : 'hover:bg-hover'
      )}
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
          #{pull.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{pull.title}</span>
        {pull.isDraft && (
          <Chip dense tone="neutral">
            draft
          </Chip>
        )}
        {decision && (
          <Chip dense tone={decision.tone}>
            {compact && decision.label === 'changes requested' ? 'changes' : decision.label}
          </Chip>
        )}
      </span>

      <span className="flex w-full items-baseline gap-1.5 text-[10px] text-fg-subtle">
        <span className="min-w-0 max-w-[40%] truncate">{author}</span>
        {pull.authorIsBot && <span className="shrink-0 opacity-70">bot</span>}
        {age !== null && <span className="shrink-0 tabular-nums">{age}</span>}
        {!compact && (
          <span className="min-w-0 truncate font-mono">
            {pull.headRefName}&#8594;{pull.baseRefName}
          </span>
        )}
        <span className="flex-1" />
        <span className="shrink-0 font-mono tabular-nums text-success">+{pull.additions}</span>
        <span className="shrink-0 font-mono tabular-nums text-danger">
          &#8722;{pull.deletions}
        </span>
      </span>
    </button>
  )
}

/**
 * Why the list is empty, which is four different facts.
 *
 * "No pull requests", "no GitHub repositories", "no gh" and "not signed in" are
 * not the same situation, and a single empty state would make the first three
 * look like the fourth.
 */
function Empty({ snapshot }: { snapshot: PullsSnapshot | null }): JSX.Element {
  if (snapshot === null) {
    return <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
  }
  if (snapshot.gh.problem !== null) {
    // The sentence is already above the list; repeating it here would say the
    // same thing twice on one screen.
    return (
      <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">
        Nothing has been fetched.
      </p>
    )
  }
  return (
    <div className="px-6 py-8 text-center">
      <PullRequestIcon width={22} height={22} className="mx-auto text-fg-subtle" />
      <p className="mt-3 text-[12.5px] text-fg-muted">
        {snapshot.checked === 0
          ? 'Helm is not scanning any folders yet.'
          : `None of the ${String(snapshot.checked)} folders Helm scans has a github.com origin.`}
      </p>
      <p className="mt-2 text-[11.5px] leading-relaxed text-fg-subtle">
        A repository appears here once its <code className="font-mono">origin</code> remote points
        at github.com. Other forges are not fetched.
      </p>
    </div>
  )
}

function Count({ n, one, many }: { n: number; one: string; many: string }): JSX.Element {
  return (
    <span className="tabular-nums">
      {n.toLocaleString()} {n === 1 ? one : many}
    </span>
  )
}
