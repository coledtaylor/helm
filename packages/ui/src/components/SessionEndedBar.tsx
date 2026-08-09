import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'

export interface SessionEndedBarProps {
  /** Null when the process ended without one being observed. */
  exitCode: number | null
  durationMs: number | null
  onClose: () => void
}

/**
 * What a terminal pane says once its process is gone.
 *
 * The tab stays: the scrollback is the record of what happened, and a session
 * that ends the moment something goes wrong is exactly the one worth reading.
 * So this reports the outcome and offers the close rather than performing it.
 */
export function SessionEndedBar({
  exitCode,
  durationMs,
  onClose
}: SessionEndedBarProps): JSX.Element {
  const failed = exitCode !== null && exitCode !== 0

  return (
    <div
      role="status"
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px]',
        failed
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-border bg-surface-sunken text-fg-muted'
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-border-strong')}
      />
      <span className="font-medium">
        {exitCode === null
          ? 'Session ended'
          : failed
            ? `Session exited with code ${String(exitCode)}`
            : 'Session ended'}
      </span>
      {durationMs !== null && (
        <span className="text-fg-subtle tabular-nums">after {formatDuration(durationMs)}</span>
      )}
      <button
        type="button"
        onClick={onClose}
        className={cn(
          'ml-auto flex items-center gap-1 rounded px-1.5 py-0.5',
          'text-fg-subtle transition hover:bg-hover hover:text-fg'
        )}
      >
        <CloseIcon width={11} height={11} />
        Close tab
      </button>
    </div>
  )
}

/** Coarse on purpose: a session's length is context, not a measurement. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.max(ms, 0))}ms`

  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`

  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}
