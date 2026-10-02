import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface SidebarProps {
  /** What the rail has the sidebar showing - "Sessions", "Profiles". */
  title: string
  /** Small icon buttons on the right of the header. */
  actions?: ReactNode | undefined
  /** One line along the bottom edge, under a hairline. */
  footer?: ReactNode | undefined
  children: ReactNode
}

/**
 * The sidebar island: a header naming the view the rail chose, that view, and
 * an optional footer line.
 *
 * It knows nothing about what it holds. The sessions tree and the profile list
 * are separate components the caller puts in it, so the rail can swap one for
 * the other without this file growing a branch per view.
 */
export function Sidebar({ title, actions, footer, children }: SidebarProps): JSX.Element {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col overflow-hidden rounded-island border border-border bg-surface">
      <header className="flex h-[38px] shrink-0 items-center gap-0.5 pr-1.5 pl-3.5">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg">{title}</span>
        {actions}
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      {footer !== undefined && footer !== null && (
        <div className="shrink-0 border-t border-border px-1.5 py-1">{footer}</div>
      )}
    </aside>
  )
}

/** A 26px icon button for the sidebar's header. */
export function SidebarAction({
  label,
  onClick,
  disabled = false,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  disabled?: boolean | undefined
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'grid size-[26px] shrink-0 place-items-center rounded-raised text-fg-muted transition-colors',
        'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
