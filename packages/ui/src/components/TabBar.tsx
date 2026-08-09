import type { DragEvent, JSX, KeyboardEvent, ReactNode } from 'react'
import { useState } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'

/** Whether a tab's session is alive, and how it ended if it is not. */
export type TabIndicator = 'running' | 'ended' | 'failed'

export interface Tab {
  id: string
  title: string
  /** Shown before the title; the launcher uses the project's kind icon. */
  icon?: ReactNode | undefined
  subtitle?: string | undefined
  closable?: boolean | undefined
  indicator?: TabIndicator | undefined
  /** Hover text. The launcher puts the working directory here. */
  hint?: string | undefined
  /** Tabs are only reorderable among tabs that agree they are. */
  draggable?: boolean | undefined
}

export interface TabBarProps {
  tabs: Tab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** Called with the tab's new index within `tabs`. Omit to disable dragging. */
  onReorder?: ((id: string, toIndex: number) => void) | undefined
  /** Trailing controls - theme switch, about. Kept out of the tab strip's
   * scroll so they stay reachable when tabs overflow. */
  actions?: ReactNode | undefined
}

const INDICATOR_CLASS: Record<TabIndicator, string> = {
  running: 'bg-success',
  ended: 'bg-border-strong',
  failed: 'bg-danger'
}

const INDICATOR_LABEL: Record<TabIndicator, string> = {
  running: 'running',
  ended: 'ended',
  failed: 'exited with an error'
}

/**
 * The strip the terminals hang off. It holds no session state of its own: a tab
 * is an id, a label and a dot, and what fills the pane is the caller's
 * business.
 *
 * Reordering is a pointer drag with a keyboard equivalent, not a pointer drag
 * alone. Ctrl+Shift+Arrow moves the focused tab, because a tab strip that can
 * only be arranged with a mouse is a tab strip half the ways into this app
 * cannot reach - and it costs one key handler.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReorder,
  actions
}: TabBarProps): JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const canReorder = onReorder !== undefined

  const finishDrag = (): void => {
    setDragging(null)
    setDropIndex(null)
  }

  const dropOn = (index: number, event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (dragging === null) return
    const from = tabs.findIndex((t) => t.id === dragging)
    // Dropping on the far side of where it came from lands one place short
    // once the tab is lifted out of the list, so the index is taken after the
    // removal it is about to cause.
    onReorder?.(dragging, from >= 0 && from < index ? index - 1 : index)
    finishDrag()
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    if (!canReorder || !event.ctrlKey || !event.shiftKey) return
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (delta === 0) return
    const target = index + delta
    if (target < 0 || target >= tabs.length) return
    event.preventDefault()
    onReorder?.(tabs[index]!.id, target)
  }

  return (
    <div className="flex h-11 shrink-0 items-stretch border-b border-border bg-surface">
      <div
        role="tablist"
        aria-label="Open tabs"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const reorderable = canReorder && tab.draggable !== false
          return (
            <div
              key={tab.id}
              draggable={reorderable}
              onDragStart={(event) => {
                setDragging(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                // Firefox and Chromium both refuse to start a drag with no
                // payload, even when nothing reads it.
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                if (!reorderable || dragging === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                // Past the midpoint means "after this tab", which is the same
                // insertion point as "before the next one".
                const box = event.currentTarget.getBoundingClientRect()
                setDropIndex(event.clientX < box.left + box.width / 2 ? index : index + 1)
              }}
              onDragLeave={() =>
                setDropIndex((current) =>
                  current === index || current === index + 1 ? null : current
                )
              }
              onDrop={(event) => dropOn(dropIndex ?? index, event)}
              className={cn(
                'group relative flex min-w-0 shrink-0 items-center',
                'border-r border-border',
                active ? 'bg-bg' : 'hover:bg-hover',
                dragging === tab.id && 'opacity-40'
              )}
            >
              {active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
              {dropIndex === index && (
                <span aria-hidden className="absolute inset-y-1 left-0 w-[2px] rounded bg-accent" />
              )}
              {dropIndex === index + 1 && (
                <span aria-hidden className="absolute inset-y-1 right-0 w-[2px] rounded bg-accent" />
              )}

              <button
                type="button"
                role="tab"
                data-tab={tab.id}
                aria-selected={active}
                // The state dot is drawn, not written, so the name it would
                // otherwise be missing is spelled out here instead of hidden in
                // a visually-hidden span - which would land inside the tab's
                // own text and read as "runningorchard-sim".
                aria-label={
                  tab.indicator === undefined
                    ? undefined
                    : `${tab.title}, ${INDICATOR_LABEL[tab.indicator]}`
                }
                title={tab.hint}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => moveWithKeyboard(event, index)}
                className={cn(
                  'flex min-w-0 max-w-[240px] items-center gap-2 py-0 pl-3 text-[12px]',
                  tab.closable === false ? 'pr-3' : 'pr-1',
                  active ? 'text-fg' : 'text-fg-muted group-hover:text-fg'
                )}
              >
                {tab.indicator !== undefined ? (
                  <span
                    aria-hidden
                    className={cn('size-1.5 shrink-0 rounded-full', INDICATOR_CLASS[tab.indicator])}
                  />
                ) : (
                  tab.icon && (
                    <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>
                      {tab.icon}
                    </span>
                  )
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
        <div className="flex shrink-0 items-center gap-1 border-l border-border px-2">{actions}</div>
      )}
    </div>
  )
}
