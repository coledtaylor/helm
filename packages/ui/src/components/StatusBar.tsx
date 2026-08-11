import type { JSX } from 'react'
import type { UsageDisplayMode, UsageSnapshot } from '@helm/core/types'
import { cn } from '../lib/cn'
import { UsageStatus } from './UsageStatus'

export interface StatusBarProps {
  /** The app's own version, with the build mode appended when it is one worth
   * naming: "0.0.1", "0.0.1 · dev", "0.0.1 · portable". */
  build: string
  claudeVersion: string | null
  scanning: boolean
  lastScan: { projects: number; durationMs: number; at: string } | null
  /** Hosted `claude` processes currently alive. */
  runningSessions: number
  /** Claude Code's cached plan-limit figures, or null before the first read. */
  usage: UsageSnapshot | null
  usageDisplay: UsageDisplayMode
  onUsageDisplayChange: (mode: UsageDisplayMode) => void
}

/**
 * The bottom strip. Everything on it is a fact about the running app a user
 * could act on: which Helm this is, whether the `claude` CLI was found, what
 * the plan has cost, what is running, and how long the last scan took.
 *
 * Storage internals are deliberately absent. The database path and its
 * migration list are facts about Helm's implementation, not about the user's
 * work, and a strip that is always on screen is the wrong place for them.
 */
export function StatusBar({
  build,
  claudeVersion,
  scanning,
  lastScan,
  runningSessions,
  usage,
  usageDisplay,
  onUsageDisplayChange
}: StatusBarProps): JSX.Element {
  return (
    // No island and no border: the status bar is the one strip that sits
    // directly on the canvas (DESIGN.md), a caption under the islands rather
    // than a panel of its own.
    <footer className="flex h-7 shrink-0 items-center gap-2.5 px-4 text-[10.5px] text-fg-subtle tabular-nums">
      <span className="shrink-0">Helm {build}</span>

      <Divider />

      <span
        className={cn('shrink-0', claudeVersion === null && 'text-warn')}
        title={
          claudeVersion === null
            ? 'The claude CLI was not found. Config browsing works; launching a session will not.'
            : `claude --version reported ${claudeVersion}`
        }
      >
        {claudeVersion === null ? 'claude CLI not found' : `claude ${claudeVersion}`}
      </span>

      <span className="flex-1" />

      {/* The right of the bar is what is happening now, and how much of the
          plan it has cost is the first of those things. Left of the session
          count so the rightmost segment stays where it has always been. */}
      <UsageStatus snapshot={usage} mode={usageDisplay} onModeChange={onUsageDisplayChange} />

      <Divider />

      {runningSessions > 0 && (
        <>
          <span
            className="flex shrink-0 items-center gap-1.5 tabular-nums"
            title="Hosted claude processes. All of them end when Helm quits."
          >
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            {runningSessions} session{runningSessions === 1 ? '' : 's'}
          </span>
          <Divider />
        </>
      )}

      {/* The one segment allowed to give up room. Everything else on the bar is
          a fixed-width fact; this one is a sentence, and at the window's
          minimum width it is the right thing to shorten. */}
      <span className="min-w-0 truncate tabular-nums">
        {scanning
          ? 'Scanning…'
          : lastScan
            ? `${lastScan.projects} projects in ${lastScan.durationMs} ms`
            : 'No scan yet'}
      </span>
    </footer>
  )
}

function Divider(): JSX.Element {
  return <span aria-hidden className="h-2.5 w-px shrink-0 bg-border-strong" />
}
