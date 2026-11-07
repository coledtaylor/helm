import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'

/** The button every notice draws: a hairline outline, the accent only on the primary one. */
export const NOTICE_BUTTON =
  'rounded-well border px-[9px] py-[3px] text-[11.5px] font-medium whitespace-nowrap transition-colors'
export const NOTICE_PLAIN = 'border-border-strong text-fg hover:bg-hover'
export const NOTICE_PRIMARY = 'border-accent text-accent-text hover:bg-accent-soft'
export const NOTICE_QUIET = 'border-transparent text-fg-muted hover:text-fg'

export interface NeedsYouToastProps {
  /** The child, as every surface names it. */
  name: string
  /** What it waits on and who started it, in a sentence. */
  detail: string
  /** The one thing besides Open as tab: Show swaps a header into the family view, Peek opens the peek. */
  action: { label: 'Show' | 'Peek'; onPress: () => void }
  onOpen: () => void
  onClose: () => void
}

/**
 * A child that needs a person, for one that is not on screen as a card or a
 * tab: its name, what it waits on and who started it, with Show (a child in a
 * shrunk header) or Peek (a child with nowhere on screen), Open as tab, and a
 * close button that closes it in this window.
 *
 * Not an overlay: the window draws the stack of notices where no browser view
 * reaches, so a toast does not stand the page down.
 */
export function NeedsYouToast({ name, detail, action, onOpen, onClose }: NeedsYouToastProps): JSX.Element {
  return (
    <div
      role="status"
      data-needs-you-toast={name}
      className="pointer-events-auto flex w-[330px] max-w-[calc(100vw-16px)] flex-col gap-1.5 rounded-well border border-border-strong bg-surface-raised px-3 py-[11px]"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
        <span className="min-w-0 truncate">{name} needs you</span>
        <button
          type="button"
          aria-label="Close notification"
          onClick={onClose}
          className="ml-auto grid size-[22px] shrink-0 place-items-center rounded-well text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <CloseIcon width={11} height={11} />
        </button>
      </div>
      <p className="m-0 text-[12px] leading-[1.45] text-fg-muted">{detail}</p>
      <div className="flex gap-1.5">
        <button
          type="button"
          data-toast-action={action.label}
          onClick={action.onPress}
          className={cn(NOTICE_BUTTON, NOTICE_PLAIN)}
        >
          {action.label}
        </button>
        <button type="button" data-toast-open onClick={onOpen} className={cn(NOTICE_BUTTON, NOTICE_PRIMARY)}>
          Open as tab
        </button>
      </div>
    </div>
  )
}
