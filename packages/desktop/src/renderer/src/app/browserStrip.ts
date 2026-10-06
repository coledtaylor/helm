/**
 * The Browser tab's strip of pages, as data: which pages, in what order, which
 * one is in front, and which page opened which.
 *
 * Pure, so where a page lands is tested here rather than discovered in a
 * window. The pages themselves are main's (`main/browser.ts`); this only
 * arranges the ids the window has been told about.
 *
 * Two rules come from the browsers people already use, because a sign-in is
 * the case that tests them:
 *
 *   - **A page lands beside the page that opened it**, after any pages that
 *     page already opened, so three links middle-clicked in a row read left to
 *     right in the order they were clicked.
 *   - **Closing a page in front brings back the page that opened it**, if that
 *     is still there. A sign-in page that closes itself when it is done hands
 *     the front back to the page that was waiting for it, rather than to
 *     whichever page happened to sit beside it.
 */
export interface PageStrip {
  readonly order: readonly number[]
  readonly active: number | null
  /** The page each page was opened from, for the pages a page opened. */
  readonly openers: ReadonlyMap<number, number>
}

export const EMPTY_STRIP: PageStrip = { order: [], active: null, openers: new Map() }

/**
 * A page joins the strip. `after` is the page that opened it, or null for one
 * the user or an agent opened, which goes at the end - or at `at`, for a
 * closed page brought back where it was. `background` leaves the page in
 * front where it is - unless there is none.
 */
export function addPage(
  strip: PageStrip,
  id: number,
  place: { after: number | null; background: boolean; at?: number }
): PageStrip {
  if (strip.order.includes(id)) {
    return place.background ? strip : { ...strip, active: id }
  }
  const opener = place.after !== null && strip.order.includes(place.after) ? place.after : null
  let at = place.at === undefined ? strip.order.length : Math.max(0, Math.min(place.at, strip.order.length))
  const openers = new Map(strip.openers)
  if (opener !== null) {
    at = strip.order.indexOf(opener) + 1
    while (at < strip.order.length && strip.openers.get(strip.order[at]!) === opener) at += 1
    openers.set(id, opener)
  }
  return {
    order: [...strip.order.slice(0, at), id, ...strip.order.slice(at)],
    active: place.background && strip.active !== null ? strip.active : id,
    openers
  }
}

/** A page leaves the strip. If it was in front, its opener comes forward, or else its neighbour. */
export function removePage(strip: PageStrip, id: number): PageStrip {
  const at = strip.order.indexOf(id)
  if (at < 0) return strip
  const order = strip.order.filter((page) => page !== id)
  const openers = new Map([...strip.openers].filter(([page, opener]) => page !== id && opener !== id))
  let active = strip.active
  if (active === id) {
    const opener = strip.openers.get(id)
    active =
      opener !== undefined && order.includes(opener) ? opener : (order[at] ?? order[at - 1] ?? null)
  }
  return { order, active, openers }
}

/**
 * A page moved along the strip, to `toIndex` counted after it has left its
 * place - what the strip's drag and Ctrl+Shift+Arrow report. It comes to the
 * front, as a dragged tab does everywhere.
 */
export function movePage(strip: PageStrip, id: number, toIndex: number): PageStrip {
  if (!strip.order.includes(id)) return strip
  const rest = strip.order.filter((page) => page !== id)
  const at = Math.max(0, Math.min(toIndex, rest.length))
  // A page moved by hand is no longer where its opener put it, so it is no
  // longer "next after" anything.
  const openers = new Map(strip.openers)
  openers.delete(id)
  return { order: [...rest.slice(0, at), id, ...rest.slice(at)], active: id, openers }
}

export function activatePage(strip: PageStrip, id: number): PageStrip {
  return strip.order.includes(id) && strip.active !== id ? { ...strip, active: id } : strip
}

/**
 * The strip as it stands against the pages main actually holds.
 *
 * A page main holds that the strip has not been told about - one adopted after
 * a renderer reload, or a `browser:changed` that beat its `browser:opened` -
 * goes at the end, and a page main no longer holds is not drawn. The front is
 * the strip's, or the last page when that one is gone.
 */
export function pagesOf(
  strip: PageStrip,
  held: ReadonlySet<number>
): { order: number[]; active: number | null } {
  const order = strip.order.filter((id) => held.has(id))
  const listed = new Set(order)
  for (const id of held) if (!listed.has(id)) order.push(id)
  const active = strip.active !== null && held.has(strip.active) ? strip.active : (order.at(-1) ?? null)
  return { order, active }
}
