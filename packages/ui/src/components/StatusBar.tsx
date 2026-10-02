import type { JSX } from 'react'
import type { UsageDisplayMode, UsageSnapshot } from '@helm/core/types'
import { cn } from '../lib/cn'
import { UsageStatus } from './UsageStatus'

export interface StatusBarProps {
  /**
   * Helm's own live sessions, by what they are doing. `idle` counts every
   * session that is alive and not working or waiting - one that has handed
   * back with a background task still running, and one that has not said
   * anything yet, as well as one that is simply ready.
   */
  sessions: { working: number; waiting: number; idle: number }
  /** Brings the next session that is waiting on you to the front. */
  onShowWaiting: () => void
  /**
   * What kind of build this is when it is not an ordinary install - "dev",
   * "dev · live", "portable" - and null when it is. Each of those changes what
   * the binary is and where the data lives, so it is worth a word; an
   * installed build is the case that needs none.
   */
  mode: string | null
  /** The app's own version, for the mode chip's hover text. */
  version: string
  /** The `claude` CLI was not found. Said here as well as in the banner,
   * because the banner can be dismissed and the fact cannot. */
  claudeMissing: boolean
  /** Claude Code's cached plan-limit figures, or null before the first read. */
  usage: UsageSnapshot | null
  usageDisplay: UsageDisplayMode
  onUsageDisplayChange: (mode: UsageDisplayMode) => void
  /**
   * What the launch's update check found, or null if it made none. Structural
   * rather than the desktop package's `UpdateCheck`: the bar renders a version
   * and opens a URL, so it takes a version and a URL.
   */
  update: { latest: string; newer: boolean; url: string } | null
  onOpenUpdate: (url: string) => void
}

/**
 * The bottom strip: what your sessions are doing on the left, what you have
 * left of the plan on the right.
 *
 * That is the whole of it now, and the cut was deliberate. The app's version,
 * the CLI's version and how long the last scan took are facts about Helm, and
 * a strip that is always on screen is for facts about your work. They live in
 * Settings, and two of them come back here only as exceptions: a build that is
 * not an ordinary install, and a `claude` that cannot be found.
 */
export function StatusBar({
  sessions,
  onShowWaiting,
  mode,
  version,
  claudeMissing,
  usage,
  usageDisplay,
  onUsageDisplayChange,
  update,
  onOpenUpdate
}: StatusBarProps): JSX.Element {
  const total = sessions.working + sessions.waiting + sessions.idle
  return (
    // No island and no border: the status bar is the one strip that sits
    // directly on the canvas (DESIGN.md), a caption under the islands rather
    // than a panel of its own.
    <footer className="flex h-[26px] shrink-0 items-center gap-3 px-3.5 text-[11px] text-fg-subtle tabular-nums">
      {total === 0 ? (
        <span data-status-sessions="none">No sessions running</span>
      ) : (
        <>
          {sessions.working > 0 && (
            <span data-status-sessions="working" className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              {sessions.working} working
            </span>
          )}
          {/* The one segment that is a button: "needs you" is a request, and
              the answer to it is to go there. Each press brings the next one
              forward. */}
          {sessions.waiting > 0 && (
            <button
              type="button"
              data-status-sessions="waiting"
              onClick={onShowWaiting}
              title="Show the session that is waiting on you"
              className="-mx-1 flex shrink-0 items-center gap-1.5 rounded px-1 text-warn transition-colors hover:bg-hover"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              {sessions.waiting} needs you
            </button>
          )}
          {sessions.idle > 0 && (
            <span data-status-sessions="idle" className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full border-[1.5px] border-success" />
              {sessions.idle} idle
            </span>
          )}
        </>
      )}

      <span className="flex-1" />

      {claudeMissing && (
        <span
          className="shrink-0 text-warn"
          title="The claude CLI was not found. Config browsing works; launching a session will not."
        >
          claude CLI not found
        </span>
      )}

      {mode !== null && (
        <span
          data-status-mode={mode}
          title={`Helm ${version}`}
          className="shrink-0 rounded-sm border border-border-strong px-1.5 leading-[16px] text-fg-muted"
        >
          {mode}
        </span>
      )}

      {/* The accent as *text*, never as a fill. A newer release is worth
          noticing and is not a warning - colouring it `warn` would put it in
          the same language as a missing CLI, which is a thing you have to fix.
          This is an offer. */}
      {update !== null && update.newer && (
        <button
          type="button"
          data-update-available={update.latest}
          title={`Helm ${update.latest} was released. Opens the releases page - Helm downloads and installs nothing.`}
          onClick={() => onOpenUpdate(update.url)}
          className={cn(
            '-mx-1 shrink-0 rounded px-1 text-accent underline decoration-dotted',
            'underline-offset-[3px] transition-colors hover:bg-hover'
          )}
        >
          {update.latest} available
        </button>
      )}

      <UsageStatus snapshot={usage} mode={usageDisplay} onModeChange={onUsageDisplayChange} />
    </footer>
  )
}
