import { isChild, type FamilyMember, type UrgentState } from './family'
import { familyChildren, familyEntries } from './familyState'
import { familyOf } from './familyView'
import { familiesHere, paneId, sessionRef, sessionTabIds, type FamilyRoomOf, type PaneLayout } from './panes'

/**
 * Where a child is on screen in this window, and what follows from it: which
 * toast a child that needs a person gets, the chips a parent's crumb holds, and
 * what closing a parent ends. Pure and browser-safe, so each rule is tested
 * here and not found in a window.
 */

/** What these rules read of a session, on top of what the family rules read. */
export interface ChildMember extends FamilyMember {
  /** A command a session ran as a child rather than an agent: it has a glyph, not a dot. */
  command?: boolean | undefined
  /** Whether it was started to keep running when its parent ends. Absent reads as false. */
  outlive?: boolean | undefined
}

/**
 * Where a session is on screen here.
 *
 * - `tab`: it has a tab of its own.
 * - `card`: a card in its parent's family view.
 * - `header`: a one-line header in its parent's family view.
 * - `chip`: a chip in the crumb of its parent's tab, which is here but has no
 *   room for the family view, or this device shows no family view.
 * - `nowhere`: none of those, so only the Sessions tree lists it.
 */
export type ChildPlace = 'tab' | 'card' | 'header' | 'chip' | 'nowhere'

/** What the places read of this device's family view. */
export interface PlaceScope {
  /** Whether this device shows children in their parent's tab. */
  enabled: boolean
  /** Whether the pane of parent tab `tab` has room for the family view; true until it is measured. */
  roomOf: FamilyRoomOf
  /** How many cards the parent tab `tab` holds, or null until it is measured. */
  capacityOf: (tab: string) => number | null
}

/** Whether the parent tab `tab` draws the family view: this device shows one and its pane has room. */
function drawsFamily(scope: PlaceScope, tab: string): boolean {
  return scope.enabled && scope.roomOf(tab)
}

/**
 * The place of every session on `host` that is somewhere on screen here, by
 * row id; a session missing from the result is `nowhere`.
 *
 * A child in a parent's tab whose pane draws the family view is a card or a
 * header as the arrangement and the pane's room make it (`familyEntries`; a pane
 * not measured yet holds every card that is wanted), and an ended child the
 * user closed is in neither. In a pane that draws no family view, every child
 * the family holds is a chip, an ended one with its ended dot; one the user
 * closed is on screen nowhere.
 */
export function childPlaces<T extends ChildMember>(
  layout: PaneLayout,
  sessions: readonly T[],
  host: string,
  scope: PlaceScope
): Map<number, ChildPlace> {
  const places = new Map<number, ChildPlace>()
  for (const id of sessionTabIds(layout, host)) places.set(id, 'tab')
  for (const [parent, family] of familiesHere(layout, sessions, host)) {
    const tab = parentTab(layout, parent, host)
    if (tab === null) continue
    if (!drawsFamily(scope, tab)) {
      for (const child of familyChildren(family, familyOf(layout, tab))) places.set(child.id, 'chip')
      continue
    }
    const capacity = scope.capacityOf(tab) ?? Number.POSITIVE_INFINITY
    for (const entry of familyEntries(family, familyOf(layout, tab), capacity)) {
      places.set(entry.child.id, entry.shape === 'card' || entry.shape === 'screen' ? 'card' : 'header')
    }
  }
  return places
}

/** The place of session `id` on `host`. */
export function childPlace<T extends ChildMember>(
  layout: PaneLayout,
  sessions: readonly T[],
  host: string,
  id: number,
  scope: PlaceScope
): ChildPlace {
  return childPlaces(layout, sessions, host, scope).get(id) ?? 'nowhere'
}

/** The `paneId` of session `id`'s tab on `host`, or null when it has none in `layout`. */
function parentTab(layout: PaneLayout, id: number, host: string): string | null {
  return sessionTabIds(layout, host).has(id) ? paneId(sessionRef(id, host)) : null
}

/**
 * What a child that starts needing a person gets, by where it is on screen:
 * nothing for one that is a card (its warn edge says it) or has a tab of its
 * own, `show` for a header (Show swaps it into the family view), and `peek` for
 * a chip or a child on screen nowhere (Peek opens its peek). Open as tab is on
 * every toast.
 */
export type NeedsYouToast = 'show' | 'peek'

export function needsYouToast(place: ChildPlace): NeedsYouToast | null {
  switch (place) {
    case 'card':
    case 'tab':
      return null
    case 'header':
      return 'show'
    case 'chip':
    case 'nowhere':
      return 'peek'
  }
}

/** The mark a child wears: a state dot, or a terminal glyph for a command, which has no conversation to be busy or waiting in. */
export interface ChildMark {
  glyph: 'dot' | 'command'
  /** The state the dot or glyph is toned by, or null when it has none. */
  state: UrgentState | null
}

export function childMark(child: ChildMember, state: UrgentState | null): ChildMark {
  return { glyph: child.command === true ? 'command' : 'dot', state }
}

/** One chip in a parent's crumb: the child, and its dot or glyph. */
export interface CrumbChip<T> {
  child: T
  mark: ChildMark
}

/**
 * The chips the crumb of parent `parent`'s tab holds: its children that are on
 * screen as chips (`childPlaces`), ended ones included, in the order the family
 * view runs them, each with its state's dot or, for a command, its glyph. None
 * while the pane draws the family view, or when the parent's tab is not here.
 */
export function crumbChips<T extends ChildMember>(
  layout: PaneLayout,
  sessions: readonly T[],
  host: string,
  parent: number,
  scope: PlaceScope,
  stateOf: (session: T) => UrgentState | null
): CrumbChip<T>[] {
  const tab = parentTab(layout, parent, host)
  const family = familiesHere(layout, sessions, host).get(parent)
  if (tab === null || family === undefined || drawsFamily(scope, tab)) return []
  return familyChildren(family, familyOf(layout, tab)).map((child) => ({ child, mark: childMark(child, stateOf(child)) }))
}

/**
 * What closing a parent's tab does to the sessions it started.
 *
 * `ends` is every running descendant that ends with it: its children that were
 * not started to outlive it, and their children by the same rule. `outlives`
 * is each running descendant started to outlive its parent, reached through the
 * sessions that end; what such a child started goes on with it.
 */
export interface CloseParentPlan<T> {
  ends: Array<{ child: T; mark: ChildMark }>
  outlives: Array<{ child: T; mark: ChildMark }>
}

/**
 * What closing the tab of running parent `parent` ends and leaves running, in
 * the order the sessions are listed.
 */
export function closeParentPlan<T extends ChildMember>(
  sessions: readonly T[],
  parent: number,
  stateOf: (session: T) => UrgentState | null
): CloseParentPlan<T> {
  const byParent = new Map<number, T[]>()
  for (const session of sessions) {
    if (!isChild(session) || session.status !== 'running') continue
    const siblings = byParent.get(session.parentId as number)
    if (siblings === undefined) byParent.set(session.parentId as number, [session])
    else siblings.push(session)
  }

  const ends: T[] = []
  const outlives: T[] = []
  const seen = new Set<number>([parent])
  const walk = (id: number): void => {
    for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.outlive === true) {
        outlives.push(child)
        continue
      }
      ends.push(child)
      walk(child.id)
    }
  }
  walk(parent)

  const listed = new Map(sessions.map((session, index) => [session.id, index]))
  const inOrder = (items: readonly T[]): Array<{ child: T; mark: ChildMark }> =>
    [...items]
      .sort((a, b) => (listed.get(a.id) ?? 0) - (listed.get(b.id) ?? 0))
      .map((child) => ({ child, mark: childMark(child, stateOf(child)) }))
  return { ends: inOrder(ends), outlives: inOrder(outlives) }
}

/**
 * The close question's button: `End session` when only the session itself
 * ends, and `End 4 sessions` when it and three others do. `ending` is how many
 * sessions end with the one whose tab closes.
 */
export function closeParentButton(ending: number): string {
  const total = 1 + Math.max(0, Math.floor(ending))
  return total === 1 ? 'End session' : `End ${total} sessions`
}
