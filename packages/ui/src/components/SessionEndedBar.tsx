import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, HistoryIcon } from './icons'

/** A session lost on the host it ran in (its session keeper went), and the way back to it. */
export interface SessionLost {
  /** The host it ran in, as the window names it: "this PC’s host". */
  hostName: string
  /** Whether the host it reconnected to offers this session back yet. */
  restoreReady: boolean
  /** Opens the offer with this session chosen. */
  onRestore: () => void
}

export interface SessionEndedBarProps {
  /** Null when the process ended without one being observed. */
  exitCode: number | null
  durationMs: number | null
  onClose: () => void
  /** Set when the session was lost with its host rather than ending. */
  lost?: SessionLost
  /**
   * Set when the host ended the session (Stop, its parent, its parent ending),
   * so the number the system gave its termination is not an exit code: the bar
   * says "Stopped" in the ended tone, as the tab's crumb and the family view's
   * ended header do, and never in danger.
   */
  stopped?: boolean
}

const barButton = cn(
  'flex items-center gap-1 rounded px-1.5 py-0.5',
  'text-fg-subtle transition hover:bg-hover hover:text-fg',
  'disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-fg-subtle'
)

/**
 * What a terminal pane says once its process is gone.
 *
 * The tab stays: the scrollback is the record of what happened, and a session
 * that ends the moment something goes wrong is exactly the one worth reading.
 * So this reports the outcome and offers the close rather than performing it.
 *
 * A session lost on its host says so, and offers Restore beside the close:
 * it resumes the conversation through the restore offer the host makes once
 * it is back, so Restore waits until that offer holds this session.
 */
export function SessionEndedBar({
  exitCode,
  durationMs,
  onClose,
  lost,
  stopped = false
}: SessionEndedBarProps): JSX.Element {
  const failed = lost === undefined && !stopped && exitCode !== null && exitCode !== 0

  return (
    <div
      role="status"
      data-session-ended={lost === undefined ? 'ended' : 'lost'}
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px]',
        // The tint is a gradient over an opaque `surface`: the pane behind the
        // bar is the terminal's own dark ground in every theme, and a plain
        // translucent fill would read as near-black red in a light theme.
        failed
          ? 'border-danger/30 bg-surface bg-linear-to-r from-danger/10 to-danger/10 text-danger'
          : lost !== undefined
            ? 'border-warn/30 bg-surface bg-linear-to-r from-warn/10 to-warn/10 text-warn'
            : 'border-border bg-surface-sunken text-fg-muted'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          failed ? 'bg-danger' : lost !== undefined ? 'bg-warn' : 'bg-fg-subtle'
        )}
      />
      <span className="font-medium">
        {lost !== undefined
          ? `Session lost on ${lost.hostName}`
          : stopped
            ? 'Stopped'
            : exitCode === null
              ? 'Session ended'
              : failed
                ? `Session exited with code ${String(exitCode)}`
                : 'Session ended'}
      </span>
      {lost === undefined && durationMs !== null && (
        <span className="text-fg-subtle tabular-nums">after {formatDuration(durationMs)}</span>
      )}
      <span className="ml-auto flex items-center gap-1">
        {lost !== undefined && (
          <button
            type="button"
            onClick={lost.onRestore}
            disabled={!lost.restoreReady}
            title={
              lost.restoreReady
                ? 'Resume this conversation in its folder, in this tab'
                : `Waiting for ${lost.hostName} to offer it back`
            }
            className={barButton}
          >
            <HistoryIcon width={11} height={11} />
            Restore
          </button>
        )}
        <button type="button" onClick={onClose} className={barButton}>
          <CloseIcon width={11} height={11} />
          Close tab
        </button>
      </span>
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
