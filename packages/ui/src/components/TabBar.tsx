import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'

export interface Tab {
  id: string
  title: string
  /** Shown before the title; the launcher uses the project's kind icon. */
  icon?: ReactNode | undefined
  subtitle?: string | undefined
  closable?: boolean | undefined
}

export interface TabBarProps {
  tabs: Tab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** Trailing controls - theme switch, about. Kept out of the tab strip's
   * scroll so they stay reachable when tabs overflow. */
  actions?: ReactNode | undefined
}

/**
 * The strip M2 hangs terminals off. It holds no session state of its own: a tab
 * is an id and a label, and what fills the pane is the caller's business.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  actions
}: TabBarProps): JSX.Element {
  return (
    <div className="flex h-11 shrink-0 items-stretch border-b border-border bg-surface">
      <div
        role="tablist"
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId
          return (
            <div
              key={tab.id}
              className={cn(
                'group relative flex min-w-0 shrink-0 items-center',
                'border-r border-border',
                active ? 'bg-bg' : 'hover:bg-hover'
              )}
            >
              {active && (
                <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onActivate(tab.id)}
                className={cn(
                  'flex min-w-0 max-w-[240px] items-center gap-2 py-0 pl-3 text-[12px]',
                  tab.closable === false ? 'pr-3' : 'pr-1',
                  active ? 'text-fg' : 'text-fg-muted group-hover:text-fg'
                )}
              >
                {tab.icon && (
                  <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>
                    {tab.icon}
                  </span>
                )}
                <span className="min-w-0 truncate">{tab.title}</span>
                {tab.subtitle !== undefined && (
                  <span className="min-w-0 shrink truncate text-[11px] text-fg-subtle">
                    {tab.subtitle}
                  </span>
                )}
              </button>

              {tab.closable !== false && (
                <button
                  type="button"
                  onClick={() => onClose(tab.id)}
                  aria-label={`Close ${tab.title}`}
                  title={`Close ${tab.title}`}
                  className={cn(
                    'mr-1.5 grid size-5 shrink-0 place-items-center rounded',
                    'text-fg-subtle opacity-0 transition hover:bg-active hover:text-fg',
                    'group-hover:opacity-100 focus-visible:opacity-100',
                    active && 'opacity-60'
                  )}
                >
                  <CloseIcon width={12} height={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {actions && (
        <div className="flex shrink-0 items-center gap-1 border-l border-border px-2">
          {actions}
        </div>
      )}
    </div>
  )
}
