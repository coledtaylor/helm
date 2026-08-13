import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import type { PullChecks, PullRepo, PullSummary } from '@helm/core/types'
import { Chip, type ChipTone } from './Chip'
import { cn } from '../lib/cn'
import { formatAge, formatMoment } from '../lib/time'
import { CheckIcon, WarnIcon } from './icons'

/**
 * One pull request, wherever a pull request is listed.
 *
 * Extracted from `PullsPane` when the project pane started listing the pull
 * requests of the one repository it is about. Two lists painting the same
 * record from two copies of the same JSX is how they come to disagree about
 * what a draft looks like or which numbers are mono, and the row is the piece
 * a reader learns once and then recognises.
 *
 * The **repository pill is optional and that is the whole reason this takes a
 * flag**: DESIGN.md's source-pill rule says the pill appears only where rows
 * have been flattened out of their groups. The Pulls pane is that case - it
 * sorts every repository's pull requests into one list, so each row has to say
 * which list it came out of. A project pane is the opposite: the pane names the
 * repository at the top, and repeating it on every row would be the heading
 * said once per row.
 */

/**
 * A clock for anything that paints an age.
 *
 * Ages change with time rather than with data, so nothing else would repaint
 * them: a snapshot that has not moved in twenty minutes would still say "2m".
 * Half a minute is finer than anything `formatAge` can express below the hour
 * mark.
 */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [everyMs])
  return now
}

const DECISION: Record<string, { label: string; tone: ChipTone }> = {
  APPROVED: { label: 'approved', tone: 'success' },
  CHANGES_REQUESTED: { label: 'changes requested', tone: 'danger' }
  // REVIEW_REQUIRED is deliberately absent. It is the state nearly every open
  // pull request is in, so a chip for it is a chip on every row saying nothing;
  // the detail header has the room to spell it out and does.
}

export interface PullRowProps {
  repo: PullRepo
  pull: PullSummary
  /** From `useNow`, so every row on a pane ages off one clock. */
  now: number
  /** Docked beside a session split: drop the columns there is no room for. */
  compact?: boolean | undefined
  /**
   * Draw the repository pill. False where a heading above already names the
   * repository - see the component comment.
   */
  showRepo?: boolean | undefined
  onOpen?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
}

/**
 * Two lines: what it is, then where it is and how it is doing.
 *
 * Everything on the second line that is machine data is mono - a branch pair, a
 * check tally (DESIGN.md 2). The repository and the author are names, so they
 * are not, and the repository is a pill rather than a plain word because it is
 * the one fact on the row that is *about* the row rather than in it.
 *
 * The row carries no buttons, per the house rule: the row itself is the action,
 * and everything else about a pull request is inside it.
 */
export function PullRow({
  repo,
  pull,
  now,
  compact = false,
  showRepo = true,
  onOpen
}: PullRowProps): JSX.Element {
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
        {/* The state, as a 5px mark rather than a word: on these lists every row
            is open or draft, so the *word* would be the same on all of them and
            the distinction is the only thing worth a glyph. */}
        <span
          aria-hidden
          data-pull-state={pull.isDraft ? 'draft' : 'open'}
          className={cn(
            'size-[5px] shrink-0 translate-y-[-1px] rounded-full',
            pull.isDraft ? 'bg-fg-subtle/60' : 'bg-success'
          )}
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
          #{pull.number}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">{pull.title}</span>
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
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-success">
          +{pull.additions}
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-danger">
          &#8722;{pull.deletions}
        </span>
      </span>

      {/* Indented past the state mark, so the two lines read as one block and
          the repository pill starts under the number rather than under the dot. */}
      <span className="flex w-full items-baseline gap-1.5 pl-[13px] text-[10.5px] text-fg-subtle">
        {showRepo && (
          <span
            data-pull-repo={repo.slug ?? ''}
            title={repo.slug ?? repo.path}
            className="max-w-[30%] shrink-0 truncate rounded-full border border-border-strong px-1.5 py-px leading-[14px] text-fg-muted"
          >
            {repo.name}
          </span>
        )}
        <span className="min-w-0 max-w-[30%] truncate">{author}</span>
        {pull.authorIsBot && <span className="shrink-0 opacity-70">bot</span>}
        {age !== null && (
          <>
            <span aria-hidden className="shrink-0 text-fg-subtle/50">
              ·
            </span>
            <span className="shrink-0 tabular-nums">{age}</span>
          </>
        )}
        {!compact && (
          <span className="ml-1 min-w-0 truncate font-mono">
            {pull.headRefName} &#8594; {pull.baseRefName}
          </span>
        )}
        <span className="flex-1" />
        {pull.checks !== null && pull.checks.total > 0 && <Checks checks={pull.checks} />}
      </span>
    </button>
  )
}

/**
 * The check tally, as a tick and a fraction.
 *
 * The fraction and not a word, because the useful question on a list is "how
 * many of them" - and it is the same reduction the detail header paints, out of
 * the same three numbers, so a row and the tab it opens cannot disagree.
 */
function Checks({ checks }: { checks: PullChecks }): JSX.Element {
  const failing = checks.failing > 0
  const pending = !failing && checks.pending > 0
  const passed = checks.total - checks.failing - checks.pending
  return (
    <span
      data-pull-checks={`${String(checks.total)}/${String(checks.failing)}/${String(checks.pending)}`}
      title={`${String(checks.total)} checks, ${String(checks.failing)} failing, ${String(checks.pending)} pending`}
      className={cn(
        'flex shrink-0 items-center gap-1 font-mono tabular-nums',
        failing ? 'text-danger' : pending ? 'text-warn' : 'text-success'
      )}
    >
      {failing ? <WarnIcon width={10} height={10} /> : <CheckIcon width={10} height={10} />}
      {failing
        ? `${String(checks.failing)}/${String(checks.total)}`
        : pending
          ? `${String(checks.pending)}/${String(checks.total)}`
          : `${String(passed)}/${String(checks.total)}`}
    </span>
  )
}
