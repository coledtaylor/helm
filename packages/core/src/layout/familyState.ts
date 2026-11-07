import { isCommandChild, type FamilyMember } from './family'

/**
 * How one parent's tab arranges its children: which are shrunk, which ended
 * ones the user closed or opened to their last screen, and the order the cards
 * run in. Pure and browser-safe, so every rule about what a press on a card or
 * a header does is tested here and not found in a window.
 *
 * A child is named by its row id on its parent's host, the parent being the
 * tab the state is kept under. A child with a tab of its own is not in the
 * family at all (the tab is the arrangement), so "opened as a tab" is not a
 * state here: the layout's strips already say it, and Close tab, keep running
 * puts the child back by the tab going.
 *
 * The state is the user's arrangement and nothing else. What shows as a card is
 * derived from it and from how many cards the pane has room for
 * (`familyEntries`), which is why a window growing or shrinking never has to
 * rewrite it.
 */
export interface FamilyState {
  /**
   * The children in the order they are wanted as cards, first to last. A child
   * missing from it follows those in it, in the order the sessions are listed,
   * so a child that starts is last and an untouched family needs no order.
   */
  readonly order: readonly number[]
  /** Running children the user shrank to a header. */
  readonly shrunk: readonly number[]
  /** Ended children the user closed out of the family view. */
  readonly closed: readonly number[]
  /** Ended children the user opened to their last screen. */
  readonly screens: readonly number[]
}

/** The arrangements of every parent that has one, by the parent tab's `paneId`. */
export type FamilyStates = Readonly<Record<string, FamilyState>>

/** A family nobody arranged: every running child a card while the pane has room for it. */
export const PLAIN_FAMILY: FamilyState = { order: [], shrunk: [], closed: [], screens: [] }

/** Whether the state says nothing a plain family does not. */
export function isPlainFamily(state: FamilyState): boolean {
  return (
    state.order.length === 0 &&
    state.shrunk.length === 0 &&
    state.closed.length === 0 &&
    state.screens.length === 0
  )
}

/** Whether a child has ended: it is anything but running. */
export function hasEnded(child: Pick<FamilyMember, 'status'>): boolean {
  return child.status !== 'running'
}

/** How a child shows in its parent's tab. */
export type FamilyShape =
  /** A running child: its terminal, live, under a header. */
  | 'card'
  /** An ended child pressed open: its last screen, with no input, under a header. */
  | 'screen'
  /** A running child as a one-line header. */
  | 'header'
  /** An ended child as a one-line header saying how and when, with Close. */
  | 'ended'

export interface FamilyEntry<T> {
  child: T
  shape: FamilyShape
}

/**
 * The children in the order the family wants them: those the state orders,
 * then the rest as given.
 */
function ordered<T extends FamilyMember>(children: readonly T[], state: FamilyState): T[] {
  const byId = new Map(children.map((child) => [child.id, child]))
  const first = state.order.flatMap((id) => {
    const child = byId.get(id)
    return child === undefined ? [] : [child]
  })
  const placed = new Set(first.map((child) => child.id))
  return [...first, ...children.filter((child) => !placed.has(child.id))]
}

/** Whether the family view still holds the child: an ended one the user closed is out of it. */
function inFamily(child: FamilyMember, state: FamilyState): boolean {
  return !(hasEnded(child) && state.closed.includes(child.id))
}

/**
 * Whether the user's arrangement wants a child as a card: a running child that
 * is not shrunk, or an ended one opened to its last screen. Any other child is
 * a header whatever room the pane has.
 */
export function wantsCard(child: FamilyMember, state: FamilyState): boolean {
  return hasEnded(child) ? state.screens.includes(child.id) : !state.shrunk.includes(child.id)
}

/** The children the family view holds, in the order it runs them in. */
export function familyChildren<T extends FamilyMember>(children: readonly T[], state: FamilyState): T[] {
  return ordered(children, state).filter((child) => inFamily(child, state))
}

/**
 * What the family view draws: the cards first, then the headers, each in the
 * family's order.
 *
 * A running child that is not shrunk, and an ended one opened to its last
 * screen, want a card; the first `capacity` of them get one, and the rest are
 * one-line headers beside the ones the user shrank. An ended child nobody
 * opened is a header saying how it ended; one the user closed is not drawn. So
 * a card that ends, shrinks or closes gives its place to the next child that
 * wants one, and the parent's terminal, which never depends on any of it,
 * stays as it is.
 */
export function familyEntries<T extends FamilyMember>(
  children: readonly T[],
  state: FamilyState,
  capacity: number
): FamilyEntry<T>[] {
  const cards: FamilyEntry<T>[] = []
  const headers: FamilyEntry<T>[] = []
  let room = Math.max(0, Math.floor(capacity))
  for (const child of familyChildren(children, state)) {
    const ended = hasEnded(child)
    if (wantsCard(child, state) && room > 0) {
      room -= 1
      cards.push({ child, shape: ended ? 'screen' : 'card' })
    } else {
      headers.push({ child, shape: ended ? 'ended' : 'header' })
    }
  }
  return [...cards, ...headers]
}

function withId(ids: readonly number[], id: number): readonly number[] {
  return ids.includes(id) ? ids : [...ids, id]
}

function withoutId(ids: readonly number[], id: number): readonly number[] {
  return ids.includes(id) ? ids.filter((each) => each !== id) : ids
}

/** A state with its lists replaced, or the very same state when none changed. */
function changed(state: FamilyState, next: Partial<FamilyState>): FamilyState {
  const merged = { ...state, ...next }
  const same =
    merged.order === state.order &&
    merged.shrunk === state.shrunk &&
    merged.closed === state.closed &&
    merged.screens === state.screens
  return same ? state : merged
}

/**
 * A card's header pressed: the child shrinks to a header. An ended child's last
 * screen goes back to the header that says how it ended.
 */
export function shrinkChild(state: FamilyState, child: FamilyMember): FamilyState {
  return hasEnded(child)
    ? changed(state, { screens: withoutId(state.screens, child.id) })
    : changed(state, { shrunk: withId(state.shrunk, child.id) })
}

/**
 * A close pressed on an ended child's header or last screen: it leaves the
 * family view. Its row in the Sessions tree is not the family's to take away.
 */
export function closeChild(state: FamilyState, id: number): FamilyState {
  return changed(state, { closed: withId(state.closed, id), screens: withoutId(state.screens, id) })
}

/**
 * A header pressed, or the child's row in the Sessions tree: the child shows
 * as a card, and when every card place is taken the last card shrinks to a
 * header in the child's place.
 *
 * `capacity` is how many cards the pane has room for, or null when none has
 * been measured (a pane that has not been drawn yet): the child then goes first
 * in the family's order, ahead of every card, so whichever cards fit once it is
 * drawn include it and the last of them is what falls to a header.
 *
 * Nothing changes for a child that is already a card, so pressing a row of a
 * child you can see does not move it.
 */
export function showChild<T extends FamilyMember>(
  state: FamilyState,
  children: readonly T[],
  capacity: number | null,
  id: number
): FamilyState {
  const child = children.find((each) => each.id === id)
  if (child === undefined) return state
  const wanted = {
    closed: withoutId(state.closed, id),
    shrunk: withoutId(state.shrunk, id),
    screens: hasEnded(child) ? withId(state.screens, id) : state.screens
  }
  const ranked = ordered(children, state).map((each) => each.id)
  const places = capacity === null || capacity < 1 ? null : Math.floor(capacity)

  if (places === null) {
    if (ranked[0] === id && wanted.shrunk === state.shrunk && wanted.closed === state.closed) {
      return changed(state, wanted)
    }
    return changed(state, { ...wanted, order: [id, ...ranked.filter((each) => each !== id)] })
  }

  const shown = familyEntries(children, state, places).filter(
    (entry) => entry.shape === 'card' || entry.shape === 'screen'
  )
  if (shown.some((entry) => entry.child.id === id)) return state
  if (shown.length < places) return changed(state, wanted)

  // The last card gives its place to the child, and takes the child's own in
  // the order, so neither moves relative to the rest.
  const last = shown[shown.length - 1]!.child
  const order = [...ranked]
  order[ranked.indexOf(id)] = last.id
  order[ranked.indexOf(last.id)] = id
  return changed(
    state,
    hasEnded(last)
      ? { ...wanted, order, screens: withoutId(wanted.screens, last.id) }
      : { ...wanted, order, shrunk: withId(wanted.shrunk, last.id) }
  )
}

/**
 * The state with the children `exists` does not know taken out, or null when
 * nothing is left of it. The same state when none went.
 */
export function pruneFamilyState(
  state: FamilyState,
  exists: (id: number) => boolean
): FamilyState | null {
  const keep = (ids: readonly number[]): readonly number[] =>
    ids.every(exists) ? ids : ids.filter(exists)
  const next = changed(state, {
    order: keep(state.order),
    shrunk: keep(state.shrunk),
    closed: keep(state.closed),
    screens: keep(state.screens)
  })
  return isPlainFamily(next) ? null : next
}

/**
 * An ended child's header: how it ended and when, "Stopped · 14:52" when its
 * parent, the user or the host ended it and "Done · 14:52" when its agent
 * exited by itself, in the time of day where this window is. A command child
 * that exited on its own says "exited 0 · 14:52", with the command's own exit
 * code; one that was stopped says "Stopped", because the number a system gives
 * a process it killed is not an exit code, and one whose code was never
 * observed is told as an agent would be. A child this
 * window's user stopped with Stop (`byYou`) says "Stopped by you". A session
 * whose host lost it says "Lost". With no time (it never saw one end) the time
 * is left off rather than guessed.
 */
export function endedHeaderText(
  child: {
    status: string
    stopped?: boolean
    endedAt?: string | null
    command?: string | null
    exitCode?: number | null
  },
  byYou = false
): string {
  const stopped = byYou && child.stopped === true ? 'Stopped by you' : 'Stopped'
  const exited =
    isCommandChild(child) && child.stopped !== true && child.exitCode !== undefined && child.exitCode !== null
      ? `exited ${String(child.exitCode)}`
      : null
  const how = exited ?? (child.status === 'lost' ? 'Lost' : child.stopped === true ? stopped : 'Done')
  if (child.endedAt === undefined || child.endedAt === null) return how
  const at = new Date(child.endedAt)
  if (Number.isNaN(at.getTime())) return how
  const clock = [at.getHours(), at.getMinutes()].map((part) => String(part).padStart(2, '0')).join(':')
  return `${how} · ${clock}`
}

/** Whether `value` reads as a family state: four lists of whole numbers. */
export function readFamilyState(value: unknown): FamilyState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const list = (name: string): readonly number[] | null => {
    const raw = record[name]
    if (raw === undefined) return []
    if (!Array.isArray(raw) || !raw.every((id) => Number.isInteger(id) && (id as number) > 0)) return null
    return [...new Set(raw as number[])]
  }
  const order = list('order')
  const shrunk = list('shrunk')
  const closed = list('closed')
  const screens = list('screens')
  if (order === null || shrunk === null || closed === null || screens === null) return null
  const state: FamilyState = { order, shrunk, closed, screens }
  return isPlainFamily(state) ? null : state
}

/**
 * `AppSettings.paneLayout`'s `families` as this build reads it: an object of
 * parent tab to state, each state kept if it reads as one. A value that is not
 * an object is none, and a state that does not read is dropped, so one hand
 * edit never costs the arrangement of every other parent.
 */
export function readFamilyStates(value: unknown): FamilyStates | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const states: Record<string, FamilyState> = {}
  for (const [tab, raw] of Object.entries(value)) {
    const state = readFamilyState(raw)
    if (state !== null) states[tab] = state
  }
  return Object.keys(states).length === 0 ? null : states
}
