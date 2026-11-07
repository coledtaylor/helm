import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'
import { NOTICE_BUTTON, NOTICE_PLAIN, NOTICE_PRIMARY } from './NeedsYouToast'

/** How a row's dot is toned: warn for a child that needs a person or a refused start, danger for an error. */
export type AwayTone = 'needs' | 'danger'

export interface AwayRowView {
  /** Names the row among the list's. */
  key: string
  tone: AwayTone
  /** What it is about, in a few words ("worker-2 needs you"). */
  title: string
  /** The sentence saying more. */
  detail: string
  /** Peek and Open for a child that needs you; Dismiss for a refused start or an error. */
  actions: ReadonlyArray<{ label: 'Peek' | 'Open' | 'Dismiss'; onPress: () => void }>
}

export interface AwayListProps {
  /** The host the window connected to, as the window names it. */
  host: string
  rows: readonly AwayRowView[]
  /** The close button: closes the list in this window until its next connection to the host. */
  onClose: () => void
}

const DOT: Record<AwayTone, string> = { needs: 'bg-warn', danger: 'bg-danger' }

/**
 * While you were away on a host: the notices standing there when this window
 * connected, each saying what it is about, with Peek and Open for a child that
 * needs you and Dismiss for a refused start or an error. The close button
 * closes the list in this window only; the notices stand on the host.
 */
export function AwayList({ host, rows, onClose }: AwayListProps): JSX.Element {
  return (
    <section
      aria-label="While you were away"
      data-away-list
      className="pointer-events-auto flex w-[372px] max-w-full flex-col rounded-well border border-border-strong bg-surface-raised"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2 text-[12.5px] font-medium text-fg">
        <span className="min-w-0 truncate">While you were away on {host}</span>
        <button
          type="button"
          aria-label="Close list"
          onClick={onClose}
          className="ml-auto grid size-[22px] shrink-0 place-items-center rounded-well text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <CloseIcon width={11} height={11} />
        </button>
      </div>
      {rows.map((row) => (
        <div
          key={row.key}
          data-away-row={row.key}
          className="grid grid-cols-[10px_minmax(0,1fr)] items-start gap-x-[9px] border-t border-border px-3 py-[9px]"
        >
          <span aria-hidden className={cn('mt-[5px] size-1.5 rounded-full', DOT[row.tone])} />
          <div>
            <div className="text-[12.5px] text-fg">{row.title}</div>
            <div className="text-[11.5px] leading-[1.45] text-fg-muted">{row.detail}</div>
            <div className="mt-[7px] flex gap-1.5">
              {row.actions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={action.onPress}
                  className={cn(NOTICE_BUTTON, action.label === 'Open' ? NOTICE_PRIMARY : NOTICE_PLAIN)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ))}
    </section>
  )
}
