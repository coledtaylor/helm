import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import {
  describeAge,
  nextUsageMode,
  priceTableAgeDays,
  usageView,
  PRICE_TABLE_FRESH_FOR_DAYS,
  type UsageBucket,
  type UsageDisplayMode,
  type UsageLimit,
  type UsageSnapshot,
  type UsageSpend,
  type UsageWindowCost
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatMoment, formatResetsIn } from '../lib/time'

/**
 * How much of the plan has been used, in the status bar.
 *
 * Two rules shape everything here. The first is that a number Helm cannot stand
 * behind does not appear: no stale figure, no invented one, no zero standing in
 * for "do not know". When the reading is too old, or its window has already
 * reset, or `cachedUsageUtilization` has changed shape under a CLI release, the
 * segment falls back to the word "Usage" and puts the reason in its tooltip.
 * The word stays because it is also the control - clicking it cycles what the
 * segment shows, and a control that vanishes when there is nothing to show is a
 * control that cannot be got back.
 *
 * The second is that the clock is an input. A reading goes stale, and a usage
 * window rolls over, with nothing on the disk having changed - so this ticks and
 * re-derives rather than waiting to be told, and it re-derives with the same
 * `usageView` the main process parsed with rather than a second opinion of its
 * own.
 */

export interface UsageStatusProps {
  /** The last reading from `~/.claude.json`, or null before the first one. */
  snapshot: UsageSnapshot | null
  mode: UsageDisplayMode
  onModeChange: (mode: UsageDisplayMode) => void
}

/**
 * How often the segment reconsiders what it may paint.
 *
 * Fifteen seconds keeps a minute-resolution countdown honest and costs one
 * re-render of one component - the tick is deliberately inside this component
 * rather than in the hook that holds the snapshot, so it does not re-render the
 * window around it four times a minute.
 */
const TICK_MS = 15_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

const SEVERITY_TEXT = {
  normal: 'text-fg-muted',
  warning: 'text-warn',
  critical: 'text-danger'
} as const

const SEVERITY_FILL = {
  normal: 'bg-fg-muted',
  warning: 'bg-warn',
  critical: 'bg-danger'
} as const

/** `Week (Fable)` for a per-model limit, `Week` for the plain one. */
function bucketLabel(bucket: UsageBucket): string {
  return bucket.scope === null ? bucket.label : `${bucket.label} (${bucket.scope})`
}

/** The same, for a limit in the tooltip - including ones not on screen. */
function limitLabel(limit: UsageLimit): string {
  if (limit.kind === 'session') return 'Session'
  if (limit.kind === 'weekly_all') return 'Week (all models)'
  if (limit.scope !== null) return `Week (${limit.scope})`
  return limit.kind
}

/**
 * Twenty-four pixels of "how close is this".
 *
 * Worth the pixels because it is the part that reads without being read: the
 * number answers precisely and the bar answers instantly, and a status bar is
 * glanced at far more often than it is studied. Colour comes from the server's
 * own `severity` rather than a threshold invented here.
 */
function Meter({ percent, severity }: Pick<UsageBucket, 'percent' | 'severity'>): JSX.Element {
  return (
    // `border-strong` rather than `border`: at three pixels tall on the status
    // bar's own surface the ordinary border colour disappears in dark mode, and
    // an invisible track turns the meter into a dash of varying length - which
    // conveys "some" but not "some out of what".
    <span aria-hidden className="h-[3px] w-6 shrink-0 overflow-hidden rounded-full bg-border-strong">
      <span
        className={cn('block h-full rounded-full', SEVERITY_FILL[severity])}
        // A limit can pass 100% when extra usage is enabled; the bar stops at
        // full and the number carries the truth.
        style={{ width: `${String(Math.max(2, Math.min(100, percent)))}%` }}
      />
    </span>
  )
}

function Bucket({ bucket, now }: { bucket: UsageBucket; now: number }): JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <Meter percent={bucket.percent} severity={bucket.severity} />
      <span>{bucketLabel(bucket)}</span>
      <span className={cn('font-medium', SEVERITY_TEXT[bucket.severity])}>
        {Math.round(bucket.percent)}%
      </span>
      {bucket.resetsAtMs !== null && (
        // Hidden rather than shrunk below a wide window: the reset time is the
        // first thing that can go without the segment becoming a bare number,
        // and it is in the tooltip at every width.
        <span className="hidden lg:inline">
          <span aria-hidden className="mr-1.5 text-fg-subtle/60">
            &middot;
          </span>
          resets {formatResetsIn(bucket.resetsAtMs, now)}
        </span>
      )}
    </span>
  )
}

function Divider(): JSX.Element {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
}

/**
 * Dollars, at the precision the number deserves.
 *
 * Cents below ten dollars, whole dollars above: an estimate reported to the
 * cent at $412.38 is claiming a precision a price table cannot give it.
 */
function dollars(amount: number): string {
  if (amount < 0.005) return '$0'
  if (amount < 10) return `$${amount.toFixed(2)}`
  return `$${Math.round(amount).toLocaleString()}`
}

function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

/**
 * The estimated-dollars half of the segment.
 *
 * Three windows, because those are the three a transcript index can honestly
 * fill - and "today" is here rather than in percent mode for exactly that
 * reason: the plan's real windows are 5-hour and 7-day, so a daily figure is
 * expressible in dollars and never as a percentage.
 *
 * The word "Est." leads, at every width, and the price table's date follows
 * where there is room. Both are load-bearing: `spend.enabled` is false on this
 * plan, so these are Helm's own arithmetic, and a price table that has gone
 * stale is worse than no figure because it still looks authoritative.
 */
function Spend({ spend, now }: { spend: UsageSpend; now: number }): JSX.Element {
  const age = priceTableAgeDays(now)
  const stale = age > PRICE_TABLE_FRESH_FOR_DAYS

  const window = (label: string, cost: UsageWindowCost): JSX.Element => (
    <span key={label} className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <span className="font-medium text-fg-muted">{dollars(cost.dollars)}</span>
      <span>{label}</span>
    </span>
  )

  return (
    <>
      <span className="shrink-0 font-medium uppercase tracking-wide text-fg-subtle">Est.</span>
      {window('5h', spend.session)}
      <Divider />
      {window('today', spend.today)}
      <Divider />
      {window('7d', spend.week)}
      <Divider />
      <span className={cn('hidden shrink-0 lg:inline', stale && 'text-warn')}>
        {spend.pricedAt} prices
      </span>
    </>
  )
}

export function UsageStatus({ snapshot, mode, onModeChange }: UsageStatusProps): JSX.Element {
  const now = useNow()
  const view = usageView(snapshot, now)

  // `cost` is only in the cycle once the index has produced an estimate.
  // Offering a mode that would paint nothing is offering a broken setting.
  const offerable: UsageDisplayMode[] =
    snapshot?.spend != null ? ['percent', 'cost', 'off'] : ['percent', 'off']

  const showing = mode === 'percent' ? view.buckets : []
  const spend = mode === 'cost' ? (snapshot?.spend ?? null) : null
  const title = tooltip(snapshot, view.problem?.detail ?? null, view.ageMs, mode, now)

  return (
    <button
      type="button"
      // The one hook `usage-check` locates this by. It reads the rendered text
      // from here and parses it with a regex of its own rather than reading a
      // number Helm put in an attribute, which would only prove Helm agrees
      // with itself.
      data-usage-segment={mode}
      onClick={() => onModeChange(nextUsageMode(mode, offerable))}
      title={title}
      className={cn(
        '-mx-1.5 flex shrink-0 items-center gap-2.5 rounded px-1.5 py-0.5',
        'transition-colors hover:bg-hover'
      )}
    >
      {spend !== null ? (
        <Spend spend={spend} now={now} />
      ) : showing.length === 0 ? (
        // Dotted underline only when there is a reason to read: it is the
        // conventional "there is an explanation behind this" affordance, and
        // hiding usage on purpose is not something that needs explaining.
        <span
          className={cn(
            mode === 'percent' &&
              view.problem !== null &&
              'underline decoration-border-strong decoration-dotted underline-offset-[3px]'
          )}
        >
          Usage
        </span>
      ) : (
        showing.map((bucket, at) => (
          <span key={bucket.group} className="flex items-center gap-2.5">
            {at > 0 && <Divider />}
            <Bucket bucket={bucket} now={now} />
          </span>
        ))
      )}
    </button>
  )
}

/**
 * Everything the segment could not fit, in the one place there is room for it.
 *
 * Including the limits that are *not* on screen: a non-binding per-model weekly
 * limit is still worth knowing about, and this is where it goes rather than
 * into a third segment nobody asked for.
 */
function tooltip(
  snapshot: UsageSnapshot | null,
  problem: string | null,
  ageMs: number | null,
  mode: UsageDisplayMode,
  nowMs: number
): string {
  const lines: string[] = []

  if (mode === 'cost') {
    const spend = snapshot?.spend ?? null
    if (spend === null) {
      lines.push('Reading the transcripts. The estimate appears when the index has caught up.')
    } else {
      lines.push(
        'Estimated, not billed. This plan is not charged per token, so these are Helm’s own',
        `sums over your transcripts at ${spend.pricedAt} list prices.`,
        ''
      )
      const row = (label: string, cost: UsageWindowCost): string =>
        `  ${label.padEnd(6)} ${dollars(cost.dollars).padStart(8)}   ` +
        `${tokens(cost.tokens.input)} in, ${tokens(cost.tokens.output)} out, ` +
        `${tokens(cost.tokens.cacheWrite)} cache write, ${tokens(cost.tokens.cacheRead)} cache read`
      lines.push(row('5h', spend.session), row('today', spend.today), row('7d', spend.week))
      const age = priceTableAgeDays(nowMs)
      if (age > PRICE_TABLE_FRESH_FOR_DAYS) {
        lines.push(
          '',
          `The price table is ${String(age)} days old and may no longer be right.`
        )
      }
      if (spend.unpricedModels.length > 0) {
        lines.push('', `Not priced (no rate on file): ${spend.unpricedModels.join(', ')}`)
      }
      lines.push('', `Index pass: ${spend.indexMs.toFixed(0)} ms`)
    }
  } else if (mode === 'off') {
    lines.push('Usage is hidden.')
  } else if (problem !== null) {
    lines.push(problem)
  } else if (snapshot !== null) {
    lines.push(
      `Plan limits as Claude Code last had them from the server${
        ageMs === null ? '' : `, ${describeAge(ageMs)} ago`
      }.`
    )
    for (const limit of snapshot.limits) {
      const resets =
        limit.resetsAtMs === null ? '' : `, resets ${formatMoment(limit.resetsAtMs)}`
      lines.push(`  ${limitLabel(limit)}  ${String(Math.round(limit.percent))}%${resets}`)
    }
  } else {
    lines.push('Waiting for Claude Code to report its usage figures.')
  }

  if (snapshot !== null && snapshot.file !== '') lines.push(snapshot.file)
  lines.push('Click to change what this shows.')
  return lines.join('\n')
}
