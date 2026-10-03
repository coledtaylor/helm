import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { cn } from '../lib/cn'
import { Menu, type MenuEntry } from './Menu'

/**
 * One way in, on the rail.
 *
 * Two kinds, because the rail does two jobs and they answer "where am I"
 * differently. A **view** swaps what the sidebar shows - the sessions tree, the
 * profile list, the settings sections - and is marked current with the accent
 * edge the sidebar's own selected row wears, because the sidebar beside it *is*
 * that view. A **page** opens a tab in the focused pane; it is marked only with
 * the hover tone while that tab is the one in front, since the pane is where
 * the page is and the rail is just how it was reached.
 */
export interface RailItem {
  id: string
  label: string
  icon: ReactNode
  kind: 'view' | 'page'
  /** The sidebar is showing this view, or this page is in front of the focused pane. */
  current: boolean
  /** Something in this destination is waiting on you. */
  attention?: boolean | undefined
  /**
   * False for the one item that must stay: Settings is where hiding is undone
   * from, so it is listed in the menu ticked and cannot be unticked.
   */
  hideable?: boolean | undefined
  onSelect: () => void
  /** The hooks the drivers reach a destination by - `data-open-history` and kin. */
  hooks?: Record<`data-${string}`, string | boolean> | undefined
}

export interface RailProps {
  /** Grouped by how often each is reached for; a rule is drawn between groups. */
  groups: readonly (readonly RailItem[])[]
  /** Pinned to the bottom of the rail - Settings. */
  footer?: readonly RailItem[] | undefined
  /** Ids taken off the rail. Listed in the right-click menu, unticked. */
  hidden?: ReadonlySet<string> | undefined
  /** A tick in the right-click menu changed. Absent, the rail has no menu. */
  onToggleHidden?: ((id: string) => void) | undefined
}

/**
 * The destinations, as a strip of icons down the left edge.
 *
 * Ordered by use rather than alphabetically or by feature: the sessions tree is
 * where the day is spent, history is reached for after a crash, the rest are
 * occasional and the rare ones sit below a rule. The order is the caller's,
 * because how often each is used is a fact about the person and not about the
 * component.
 *
 * A right-click lists every destination with a tick, as VS Code's activity bar
 * does; unticking one takes it off the rail. A group left with nothing in it
 * takes its rule with it, so hiding never leaves two rules touching.
 *
 * Outside the sidebar's `aside`, deliberately: the drivers reach the first
 * project row with `aside nav button[title]`, and a rail of titled buttons
 * inside that would make every such selector land here instead.
 */
export function Rail({ groups, footer, hidden, onToggleHidden }: RailProps): JSX.Element {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const shown = groups
    .map((items) => items.filter((item) => hidden?.has(item.id) !== true))
    .filter((items) => items.length > 0)
  const shownFooter = footer?.filter((item) => hidden?.has(item.id) !== true)

  const entries: MenuEntry[] = []
  for (const [index, items] of [...groups, ...(footer === undefined ? [] : [footer])].entries()) {
    if (index > 0) entries.push({ kind: 'separator', id: `rule-${String(index)}` })
    for (const item of items) {
      const fixed = item.hideable === false
      entries.push({
        kind: 'item',
        id: item.id,
        label: item.label,
        checked: hidden?.has(item.id) !== true,
        disabled: fixed,
        title: fixed ? `${item.label} stays on the rail - it is where hidden items come back from` : undefined
      })
    }
  }

  return (
    <nav
      aria-label="Destinations"
      onContextMenu={
        onToggleHidden === undefined
          ? undefined
          : (event) => {
              event.preventDefault()
              setMenuAt({ x: event.clientX, y: event.clientY })
            }
      }
      className="flex w-11 shrink-0 flex-col items-center gap-0.5 pb-1.5"
    >
      {shown.map((items, index) => (
        <div key={items[0]?.id ?? index} className="contents">
          {index > 0 && <span aria-hidden className="my-1.5 h-px w-[18px] shrink-0 bg-border" />}
          {items.map((item) => (
            <RailButton key={item.id} item={item} />
          ))}
        </div>
      ))}
      <span className="flex-1" />
      {shownFooter?.map((item) => <RailButton key={item.id} item={item} />)}
      {menuAt !== null && onToggleHidden !== undefined && (
        <Menu
          label="Show on the rail"
          at={menuAt}
          entries={entries}
          stayOpen
          onSelect={onToggleHidden}
          onDismiss={() => setMenuAt(null)}
        />
      )}
    </nav>
  )
}

function RailButton({ item }: { item: RailItem }): JSX.Element {
  return (
    <button
      type="button"
      onClick={item.onSelect}
      aria-label={item.label}
      title={item.label}
      aria-current={item.current ? 'true' : undefined}
      data-rail={item.id}
      {...item.hooks}
      className={cn(
        'relative grid size-[34px] shrink-0 place-items-center rounded-well transition-colors',
        // A current item still answers the pointer, a step further along the
        // same ramp - the selected-row rule (lib/rows.ts), applied here.
        item.current ? 'bg-hover text-fg hover:bg-active' : 'text-fg-subtle hover:bg-hover hover:text-fg'
      )}
    >
      {/* The accent edge sits in the rail's own margin, at its left edge -
          the same 2px mark a selected sidebar row carries, so a view and the
          sidebar showing it read as one thing. */}
      {item.current && item.kind === 'view' && (
        <span aria-hidden className="absolute inset-y-2 -left-[5px] w-[2px] rounded-full bg-accent" />
      )}
      {item.icon}
      {item.attention === true && (
        <span
          aria-hidden
          data-rail-attention
          className="absolute top-[5px] right-[5px] size-[7px] rounded-full bg-warn ring-2 ring-bg"
        />
      )}
    </button>
  )
}
