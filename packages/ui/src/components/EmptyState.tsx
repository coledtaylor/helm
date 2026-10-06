import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface EmptyStateProps {
  /** The destination's own icon, 18px. */
  icon: ReactNode
  /** What is empty, in a few words: "No sessions running". */
  title: string
  /** One sentence on what fills it, or why it is empty. */
  children?: ReactNode | undefined
  /** The way on, where there is one: refresh, pick a scope, open settings. */
  actions?: ReactNode | undefined
  /**
   * `page` fills a detail region and centres in it; `list` sits at the top of a
   * list column, where the eye already is.
   */
  size?: 'page' | 'list' | undefined
  /** Names it for a test or a driver. */
  name?: string | undefined
}

/**
 * What a page or a list says when it has nothing to show (DESIGN.md 5, "Empty
 * states"): the destination's icon in a small well, a title saying what is
 * empty, one sentence, and the way on as a button where there is one.
 *
 * Short on purpose. The empty states this replaced were two paragraphs each,
 * explaining the feature to somebody looking at nothing - and a paragraph in an
 * empty pane is read once and skipped every time after.
 */
export function EmptyState({ icon, title, children, actions, size = 'page', name }: EmptyStateProps): JSX.Element {
  return (
    <div
      data-empty-state={name ?? ''}
      className={cn('flex justify-center text-center', size === 'page' ? 'h-full items-center p-8' : 'px-4 py-8')}
    >
      <div className="flex max-w-[360px] flex-col items-center">
        <span
          aria-hidden
          className="grid size-9 place-items-center rounded-well border border-border bg-surface-raised text-fg-subtle"
        >
          {icon}
        </span>
        <p className="mt-3 text-[13px] font-medium text-fg">{title}</p>
        {children !== undefined && (
          <p className="mt-1 text-[12px] leading-relaxed text-fg-subtle">{children}</p>
        )}
        {actions !== undefined && <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
