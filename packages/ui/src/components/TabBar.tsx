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
  /**
   * What the active tab lifts into. A folder tab reads as part of the pane
   * below it, so its fill must match that pane's ground: `island` for every
   * ordinary view, `terminal` for a session tab - the terminal keeps its own
   * fixed #11121A in both modes (DESIGN.md "foreign-ground islands"), and an
   * island-coloured tab on top of it would show a seam.
   */
  ground?: 'island' | 'terminal' | undefined
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
  // Not border-strong: that token became a 16% alpha hairline, and a dot
  // filled with it disappears into whatever it sits on.
  ended: 'bg-fg-subtle',
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
 *
 * With nothing to hang off it - no tabs and no actions - the strip is not
 * drawn at all rather than drawn empty. Its 40px are reserved for tabs, and
 * holding them open on the welcome screen would drop the pane island 40px
 * below the sidebar island beside it, two edges that should line up.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReorder,
  actions
}: TabBarProps): JSX.Element | null {
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

  if (tabs.length === 0 && !actions) return null

  return (
    <div className="flex h-10 shrink-0 items-end px-1.5">
      <div
        role="tablist"
        aria-label="Open tabs"
        // `overflow-x-auto` promotes the other axis from `visible` to `auto`,
        // so the active tab's 1px overlap into the pane below counted as
        // scrollable overflow and Chromium painted a vertical scrollbar over
        // the strip. The overlap is unchanged - the strip reaches 1px into the
        // pane (`-mb-px`) and spends that pixel as bottom padding (`pb-px`), so
        // the tab's overshoot lands inside the scroll container instead of past
        // it. `overflow-y-hidden` keeps it that way if a tab ever grows.
        // The caret is cleared here and not on each tab. Leaving a tab for its
        // neighbour fires that tab's `dragleave` *after* the neighbour's
        // `dragover` has already set the insertion point, so a per-tab handler
        // spends the drag erasing the mark the next tab just drew. Only leaving
        // the strip altogether means there is no insertion point any more, and
        // `relatedTarget` - the element being entered - is what says so.
        onDragLeave={(event) => {
          const entering = event.relatedTarget
          if (entering instanceof Node && event.currentTarget.contains(entering)) return
          setDropIndex(null)
        }}
        className="-mb-px flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden pb-px"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const reorderable = canReorder && tab.draggable !== false
          const terminalGround = tab.ground === 'terminal'
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
              onDrop={(event) => dropOn(dropIndex ?? index, event)}
              className={cn(
                // A folder tab: the active one lifts into the pane island below
                // it - same fill, hairline edge on three sides, and a 1px
                // overlap that erases the island's top border under it. The
                // z-index is what makes the overlap paint over the pane, which
                // is later in the DOM.
                'group relative flex h-[34px] min-w-0 shrink-0 items-center',
                'rounded-t-[9px] border border-b-0 border-transparent',
                active
                  ? cn('z-10 -mb-px border-border', terminalGround ? 'bg-terminal' : 'bg-surface')
                  : 'hover:bg-hover/60',
                dragging === tab.id && 'opacity-40'
              )}
            >
              {/* One caret per insertion point, and only one. An interior seam
                  is describable twice - after tab k-1, before tab k - and
                  drawing both put two 2px marks 4px apart on screen where the
                  tab was going to land. The left edge is the general case; the
                  right edge of the last tab is the only insertion point that
                  has no tab to its right to carry it. */}
              {dropIndex === index && (
                <span aria-hidden className="absolute inset-y-1 left-0 w-[2px] rounded bg-accent" />
              )}
              {dropIndex === tabs.length && index === tabs.length - 1 && (
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
                // own text and glue itself to the title, reading as
                // "runningapi-server" for a tab called "api-server".
                aria-label={
                  tab.indicator === undefined
                    ? undefined
                    : `${tab.title}, ${INDICATOR_LABEL[tab.indicator]}`
                }
                title={tab.hint}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => moveWithKeyboard(event, index)}
                className={cn(
                  'flex min-w-0 max-w-[240px] items-center gap-1.5 py-0 pl-3 text-[12px]',
                  tab.closable === false ? 'pr-3' : 'pr-1',
                  active
                    ? // The terminal's ground is fixed in both modes, so the
                      // text on it is too - fg would go near-black in light
                      // mode on a surface that stayed dark.
                      terminalGround
                      ? 'text-[#dde1ea]'
                      : 'text-fg'
                    : 'text-fg-muted group-hover:text-fg'
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
                  <span
                    className={cn(
                      'min-w-0 shrink truncate text-[10px]',
                      active && !terminalGround ? 'text-accent-text' : 'text-fg-subtle'
                    )}
                  >
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
                    'text-fg-subtle opacity-0 transition hover:bg-hover hover:text-fg',
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

      {actions && <div className="mb-1 flex shrink-0 items-center gap-1 self-center px-2">{actions}</div>}
    </div>
  )
}
