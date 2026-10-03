import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { PAGE_BAR } from '../lib/page'

export interface PaneHeaderProps {
  /** Names the header for a driver, e.g. `config`. */
  name: string
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
 * The bar a scoped page wears under its pane's tab strip: a scope switcher,
 * what is being looked at, the page's own controls and a refresh.
 *
 * It is a row of the pane's island, not an island of its own (DESIGN.md 3), and
 * it carries no title: the tab directly above it already says "Config", and a
 * second "Config" one row down was the header reading as a card sitting on top
 * of somebody else's pane.
 *
 * **It measures itself, not the window.** A pane is as wide as its half of the
 * split, which is a fraction of the row and not a fraction of the screen - so a
 * media query here is a query about the wrong box. Docked at the divider's 20%
 * bound on a 1280 window the pane is ~195px while the viewport is still 1280,
 * and that is exactly how the config header once painted its view switcher
 * 100px past its right edge with the scope select crushed to nothing. Every
 * threshold below is a container query against this bar's own content box.
 *
 * | below | dropped |
 * |---|---|
 * | 896px | `meta` - counts are the one thing the pane repeats below itself |
 * | 672px | `caption` - the path, which the scope switcher already names |
 * | 560px | `controls` move to a second row rather than being dropped |
 * | 384px | the switcher stops holding its own width and takes the row |
 *
 * The scope switcher and the action survive every step, because a pane you
 * cannot re-point or re-read is a pane with nothing left to do.
 *
 * Two rows and not a scroll: the row wraps only where it is told to, by
 * `controls` taking a full line below the threshold, so the wrap point is a
 * decision rather than whatever happened to fit.
 */
export function PaneHeader({ name, scope, caption, meta, controls, action }: PaneHeaderProps): JSX.Element {
  return (
    <header
      data-pane-header={name}
      className={cn(PAGE_BAR, '@container flex-wrap gap-x-3 gap-y-1.5 py-1.5', '@[560px]:flex-nowrap @[560px]:py-0')}
    >
      {scope !== undefined && (
        // Takes the row once the spacer has gone; its own width at every size
        // above that.
        <div data-head="scope" className="order-3 flex min-w-0 flex-1 items-center @[384px]:flex-none">
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
        // controls, then refresh - which reads the same way in both layouts.
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
