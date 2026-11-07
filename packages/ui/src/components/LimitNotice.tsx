import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { NOTICE_BUTTON, NOTICE_PLAIN, NOTICE_PRIMARY, NOTICE_QUIET } from './NeedsYouToast'

export interface LimitNoticeProps {
  /** The limit and what holds it, in the host's sentence. */
  text: string
  /** The starts limit: how many more starts Allow adds for this parent; null for every other limit. */
  allowMore: number | null
  /** Where the notice sits: the left edge of the parent's children. */
  indent: number
  onAllowMore: () => void
  onSettings: () => void
  onDismiss: () => void
}

/**
 * What a parent's refused start leaves under its children in the Sessions
 * tree: the limit that refused and what holds it, with Allow <n> more (the
 * starts limit only, for this parent alone), Settings › Agents and Dismiss.
 */
export function LimitNotice({
  text,
  allowMore,
  indent,
  onAllowMore,
  onSettings,
  onDismiss
}: LimitNoticeProps): JSX.Element {
  return (
    <div
      role="status"
      data-limit-notice
      style={{ marginLeft: indent }}
      className="mt-0.5 mr-1.5 mb-1 rounded-well border border-border bg-surface-sunken px-[9px] py-[7px] text-[11.5px] leading-[1.45] text-fg-muted"
    >
      <b className="font-medium text-fg">Limit reached.</b> {text}
      <div className="mt-1.5 flex gap-1.5">
        {allowMore !== null && (
          <button
            type="button"
            data-limit-allow
            onClick={onAllowMore}
            className={cn(NOTICE_BUTTON, NOTICE_PRIMARY)}
          >
            Allow {allowMore} more
          </button>
        )}
        <button type="button" onClick={onSettings} className={cn(NOTICE_BUTTON, NOTICE_PLAIN)}>
          Settings › Agents
        </button>
        <button type="button" onClick={onDismiss} className={cn(NOTICE_BUTTON, NOTICE_QUIET)}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
