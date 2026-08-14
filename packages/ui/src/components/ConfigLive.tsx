import type { JSX } from 'react'
import type { ConfigLive, ConfigLiveState } from '@helm/core'
import { cn } from '../lib/cn'

/**
 * How the config console says whether a file is live.
 *
 * One vocabulary, two densities: a 6px dot on a row and a state chip on the
 * pane that opens. Both read the same `ConfigLive`, so a row and its detail
 * cannot disagree, and both are absent when there is nothing to claim - a file
 * Helm cannot speak for gets no mark at all rather than a confident grey one.
 *
 * The chip follows DESIGN.md's state-chip rule: a hairline outline in the
 * tone's own colour, never a fill. It is the second user of that rule after the
 * pull request's open/draft/merged/closed, and it earns it for the same reason
 * - one word carrying the whole status of the thing on screen.
 */

const TONE: Record<ConfigLiveState, { dot: string; chip: string }> = {
  // The live one, and the only one that is unambiguously good news.
  live: { dot: 'bg-success', chip: 'border-success/40 text-success' },
  // Something in it is outranked, which is the state worth noticing: the file
  // is doing something, and not the thing it looks like it is doing.
  partial: { dot: 'bg-warn', chip: 'border-warn/40 text-warn' },
  shadowed: { dot: 'bg-warn', chip: 'border-warn/40 text-warn' },
  // Read and empty, or read and unreachable. Not a problem, so no tone - a
  // hollow ring, which is the absence of the filled one beside it.
  inert: { dot: 'border border-fg-subtle', chip: 'border-border-strong text-fg-muted' },
  absent: { dot: 'border border-fg-subtle', chip: 'border-border-strong text-fg-muted' },
  // No claim. Rendered as an empty slot the same size as a dot, so the names
  // beside it stay in one column.
  none: { dot: '', chip: '' }
}

const LABEL: Record<ConfigLiveState, string> = {
  live: 'Live',
  partial: 'Partly shadowed',
  shadowed: 'Shadowed',
  inert: 'Not loaded',
  absent: 'Not resolved',
  none: ''
}

/** True when the state is one a reader should look twice at. */
export function isLiveWarning(state: ConfigLiveState): boolean {
  return state === 'partial' || state === 'shadowed'
}

export function LiveDot({ live }: { live: ConfigLive | null }): JSX.Element {
  return (
    <span
      aria-hidden
      data-live-dot={live?.state ?? 'unknown'}
      className={cn('size-1.5 shrink-0 rounded-full', live ? TONE[live.state].dot : '')}
    />
  )
}

export function LiveChip({ live }: { live: ConfigLive | null }): JSX.Element | null {
  if (live === null || live.state === 'none') return null
  return (
    <span
      data-live-state={live.state}
      title={live.reason}
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[10px] tracking-[.04em] whitespace-nowrap',
        TONE[live.state].chip
      )}
    >
      {LABEL[live.state]}
    </span>
  )
}
