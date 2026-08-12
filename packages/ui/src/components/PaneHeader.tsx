import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface PaneHeaderProps {
  /** Names the header for a driver, e.g. `config`. */
  name: string
  /** The pane's mark, in the accent. */
  icon: ReactNode
  title: string
  /** The scope switcher. Never dropped and never allowed to reach zero. */
  scope?: ReactNode | undefined
  /**
   * What is being looked at, as a line of small text - the scope's path. First
   * thing dropped, so pass the thing that is nice to have rather than the thing
   * that is needed.
   */
  caption?: ReactNode | undefined
  /** Facts about the contents, right-aligned. Dropped before the caption is. */
  meta?: ReactNode | undefined
  /** Controls belonging to the pane - the config console's view switcher. */
  controls?: ReactNode | undefined
  /** The trailing action, normally refresh. Never dropped. */
  action?: ReactNode | undefined
}

/**
 * The header strip every scoped console wears: a `h-11` island holding a mark,
 * a title, a scope switcher, what is being looked at, and a refresh.
 *
 * **It measures itself, not the window.** The panes below it are as wide as the
 * workspace half of the split, which is a fraction of the row and not a
 * fraction of the screen - so a media query here is a query about the wrong
 * box. Docked at the divider's 20% bound on a 1280 window the pane is ~195px
 * while the viewport is still 1280, and that is exactly how the config header
 * came to paint its view switcher 100px past the island's right edge with the
 * scope select crushed to nothing: `lg:` and `xl:` were both satisfied. Every
 * threshold below is a container query against this header's own inline size.
 *
 * What goes as it narrows, in order, and why that order. The numbers are the
 * header's **content box** - a container query's box - so each is 32px inside
 * the pane's own width:
 *
 * | below | dropped |
 * |---|---|
 * | 896px | `meta` - counts are the one thing the pane repeats below itself |
 * | 672px | `caption` - the path, which the scope switcher already names |
 * | 560px | `controls` move to a second row rather than being dropped |
 * | 384px | the title, which the tab above the header already says, and the
 *           switcher stops holding its own width and stretches instead |
 * | 240px | the mark |
 *
 * The scope switcher and the action survive every step, because a pane you
 * cannot re-point or re-read is a pane with nothing left to do. Down to 384 the
 * switcher keeps the width it has at every larger size - a header that changes
 * character twice on the way down is harder to read than one that changes once
 * - and below it, with the title and the spacer gone, it takes the row.
 *
 * Two rows and not a scroll: the row wraps only where it is told to, by
 * `controls` taking a full line below the threshold, so the wrap point is a
 * decision rather than whatever happened to fit. The height follows
 * (`min-h-11`), which is why the island is not a fixed `h-11` any more.
 */
export function PaneHeader({
  name,
  icon,
  title,
  scope,
  caption,
  meta,
  controls,
  action
}: PaneHeaderProps): JSX.Element {
  return (
    <header
      data-pane-header={name}
      className={cn(
        '@container flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5',
        'rounded-island border border-border bg-surface px-4 py-1.5',
        '@[560px]:flex-nowrap @[560px]:py-0'
      )}
    >
      <span data-head="icon" className="order-1 hidden shrink-0 text-accent @[240px]:block">
        {icon}
      </span>
      <h1
        data-head="title"
        className="order-2 hidden shrink-0 text-[13px] font-medium tracking-tight text-fg @[384px]:block"
      >
        {title}
      </h1>

      {scope !== undefined && (
        // Takes the row once the title and the spacer have gone; its own width
        // at every size above that.
        <div
          data-head="scope"
          className="order-3 flex min-w-0 flex-1 items-center @[384px]:flex-none"
        >
          {scope}
        </div>
      )}

      {caption !== undefined && (
        <div data-head="caption" className="order-4 hidden min-w-0 @[672px]:block">
          {caption}
        </div>
      )}

      {/* Only while the scope switcher is holding its own width - below that it
          is the thing pushing the action to the right edge, and two `flex-1`s
          would split the room between them and strand the action mid-row. */}
      <span data-head="gap" aria-hidden className="order-5 hidden flex-1 @[384px]:block" />

      {meta !== undefined && (
        <div data-head="meta" className="order-6 hidden shrink-0 @[896px]:block">
          {meta}
        </div>
      )}

      {controls !== undefined && (
        // `order-9` puts it after the action, which is what makes a full-width
        // item wrap onto a line of its own rather than dragging the refresh
        // button down with it. Focus order stays the DOM's - switcher, then
        // controls, then refresh - which reads the same way in both layouts
        // even though the second row is painted below the refresh.
        <div
          data-head="controls"
          className="order-9 flex w-full min-w-0 justify-start @[560px]:order-7 @[560px]:w-auto"
        >
          {controls}
        </div>
      )}

      {action !== undefined && (
        <div data-head="action" className="order-8 flex shrink-0 items-center">
          {action}
        </div>
      )}
    </header>
  )
}
