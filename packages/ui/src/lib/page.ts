/**
 * A page on the pane it is in (DESIGN.md 3, "One island per pane").
 *
 * A pane is already an island - its hairline, its surface, its tab strip - so a
 * page inside it draws none of its own. What a page has in sections it says
 * with hairlines: a bar under the strip, and a list beside its detail. Pages
 * used to float islands of their own inside the pane with canvas between them,
 * which put a box inside a box and spent two gutters of reading width on it.
 */

/**
 * The row directly under a pane's tab strip that holds a page's own controls -
 * scope, filter, counts, refresh. As tall as the strip, so the two read as one
 * header in two rows.
 */
export const PAGE_BAR = 'flex min-h-strip shrink-0 items-center gap-3 border-b border-border px-3'

/**
 * A list beside its detail: the hairline between them is the list's right edge.
 * Only while both are shown - a lone list already has the pane's own edge there.
 */
export const PAGE_LIST_BESIDE = 'border-r border-border'

/** A square icon-only control: refresh on a bar, a row's hand-off. */
export const ICON_BUTTON =
  'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'

/** The button recipes in DESIGN.md 4, for the places that are not a one-off. */
export const BUTTON_PRIMARY =
  'inline-flex h-7 items-center gap-1.5 rounded-well border border-accent px-3 text-[12px] text-accent-text transition-colors hover:bg-accent-soft disabled:cursor-default disabled:opacity-50'

export const BUTTON_SECONDARY =
  'inline-flex h-7 items-center gap-1.5 rounded-well border border-border-strong px-3 text-[12px] text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50'
