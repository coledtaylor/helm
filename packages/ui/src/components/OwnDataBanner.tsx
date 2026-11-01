import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, WarnIcon } from './icons'

export interface OwnDataBannerProps {
  /** Why the copy stopped, in words that name no row of it. */
  reason: string
  onDismiss: () => void
}

/**
 * Says that copying what only Helm's own database holds into the local host
 * stopped part way, as a strip above the tabs like the version guard.
 *
 * Nothing is lost: Helm's database is never written by the copy, and the host
 * keeps every whole batch it was sent, so this is a fact to know rather than
 * something to fix. Dismissible for the session; it does not come back once
 * a later attempt finishes.
 */
export function OwnDataBanner({ reason, onDismiss }: OwnDataBannerProps): JSX.Element {
  return (
    <div
      role="status"
      data-own-data-banner
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5',
        'text-[12px] text-warn'
      )}
    >
      <WarnIcon width={13} height={13} className="shrink-0" />
      {/* What happens next before why, so a narrow window cuts the reason, which the tooltip still has. */}
      <span className="min-w-0 flex-1 truncate" title={reason}>
        Copying Helm’s history, usage and config versions into the local host did not finish. It will be tried again
        when Helm next starts. <span className="text-warn/80">({reason.replace(/\.$/, '')})</span>
      </span>
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
