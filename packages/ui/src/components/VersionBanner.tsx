import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, WarnIcon } from './icons'

export interface VersionBannerProps {
  /** The version that was found, raw. */
  version: string | null
  /** The range this build was tested against. */
  range: { min: string; max: string }
  /** Set when the CLI could not be found or run at all. */
  error?: string | null | undefined
  onDismiss: () => void
  onLocate: () => void
}

/**
 * The version guard, as a strip above the tabs.
 *
 * A warning and not a gate (SPEC 8). Claude Code's flags are a stable public
 * surface and a newer CLI is far more likely to work than not, so an app that
 * refused to run outside a tested range would break on someone else's release
 * schedule for no measured reason. What it does instead is make sure that when
 * something *does* misbehave, the first thing the user sees is the one fact
 * that explains it.
 *
 * Dismissible, and dismissed only for the session: this is a fact about the
 * machine, not a notification, and it comes back next launch because it is
 * still true.
 */
export function VersionBanner({
  version,
  range,
  error,
  onDismiss,
  onLocate
}: VersionBannerProps): JSX.Element {
  return (
    <div
      role="status"
      data-version-banner
      className={cn(
        // Its own small island above the tabs, not a strip fused to them: the
        // canvas shows through around it like everywhere else.
        'flex shrink-0 items-center gap-2.5 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5',
        'text-[12px] text-warn'
      )}
    >
      <WarnIcon width={13} height={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {version === null
          ? (error ?? 'The claude CLI was not found. Sessions cannot launch until it is.')
          : `claude ${version} is outside the range Helm was tested against (${range.min} up to ${range.max}). Nothing is blocked; if a launch misbehaves, suspect this first.`}
      </span>
      <button
        type="button"
        data-version-banner-locate
        onClick={onLocate}
        className="shrink-0 rounded px-1.5 py-0.5 underline-offset-2 hover:underline"
      >
        Locate claude…
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss until the next launch"
        className="grid size-5 shrink-0 place-items-center rounded hover:bg-warn/15"
      >
        <CloseIcon width={11} height={11} />
      </button>
    </div>
  )
}
