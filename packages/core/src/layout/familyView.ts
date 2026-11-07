import { LOCAL_HOST_KEY } from '../hosts'
import { hasRunningParent, tabHolder, type FamilyMember, type FamilyPress } from './family'
import {
  PLAIN_FAMILY,
  closeChild,
  isPlainFamily,
  shrinkChild,
  showChild,
  type FamilyState
} from './familyState'
import {
  activateTab,
  familiesHere,
  findTab,
  groupById,
  isSessionOn,
  moveTab,
  openTab,
  paneId,
  sessionRef,
  sessionTabIds,
  type FamilyRoomOf,
  type PaneLayout
} from './panes'

/**
 * The family view's arrangement as operations on a layout. Each takes the
 * layout and returns one, the very same layout when nothing changed, and none
 * adds a tab or a pane: a parent's children are drawn inside its tab, and the
 * arrangement is kept in `PaneLayout.families` with the panes, per device.
 */

/** The arrangement of the parent whose tab is `tab`: a plain family when nobody arranged it. */
export function familyOf(layout: PaneLayout, tab: string): FamilyState {
  return layout.families[tab] ?? PLAIN_FAMILY
}

/**
 * The layout with `tab`'s arrangement changed by `change`. Left alone for a
 * tab the layout does not have, and an arrangement that comes to say nothing a
 * plain family does not is removed rather than kept.
 */
export function arrangeFamily(
  layout: PaneLayout,
  tab: string,
  change: (state: FamilyState) => FamilyState
): PaneLayout {
  if (findTab(layout, tab) === null) return layout
  const before = familyOf(layout, tab)
  const after = change(before)
  if (after === before) return layout
  const others = Object.entries(layout.families).filter(([key]) => key !== tab)
  const families = Object.fromEntries(isPlainFamily(after) ? others : [...others, [tab, after]])
  return { ...layout, families }
}

/** A card's header pressed: the child shrinks to a header. */
export function shrinkFamilyChild(layout: PaneLayout, tab: string, child: FamilyMember): PaneLayout {
  return arrangeFamily(layout, tab, (state) => shrinkChild(state, child))
}

/** Close pressed on an ended child: it leaves the family view, and its row in the Sessions tree stays. */
export function closeFamilyChild(layout: PaneLayout, tab: string, id: number): PaneLayout {
  return arrangeFamily(layout, tab, (state) => closeChild(state, id))
}

/**
 * A header pressed: the child shows as a card, and the last card shrinks in
 * its place when every card place is taken (`showChild`).
 */
export function showFamilyChild<T extends FamilyMember>(
  layout: PaneLayout,
  tab: string,
  children: readonly T[],
  capacity: number | null,
  id: number
): PaneLayout {
  return arrangeFamily(layout, tab, (state) => showChild(state, children, capacity, id))
}

/**
 * Open as tab on a card: the child gets a tab in the pane strip its parent's
 * tab is in, in front, and that pane takes the focus. It leaves the family view
 * on this device by having a tab (`familiesHere` holds no child that has one),
 * and Close tab, keep running puts it back.
 *
 * The tab goes after the parent's and after any tab of the parent's other
 * children that already follows it (`siblings`), so the children of a parent
 * stay together behind it in the order they were opened. The layout is
 * returned unchanged when the parent's tab is not here, and the child's own
 * tab, if it already has one, is only brought forward.
 */
export function openFamilyChildAsTab(
  layout: PaneLayout,
  tab: string,
  child: { id: number; host?: string },
  siblings: ReadonlySet<number> = new Set()
): PaneLayout {
  const host = child.host ?? LOCAL_HOST_KEY
  const ref = sessionRef(child.id, host)
  const childTab = paneId(ref)
  if (findTab(layout, childTab) !== null) return activateTab(layout, childTab)
  const at = findTab(layout, tab)
  if (at === null) return layout

  const group = groupById(layout, at.group)!
  let index = at.index + 1
  while (index < group.tabs.length) {
    const next = group.tabs[index]!
    if (!isSessionOn(next, host) || !siblings.has(next.id)) break
    index += 1
  }
  const opened = openTab(layout, ref, group.id)
  return activateTab(moveTab(opened, childTab, group.id, index), childTab)
}

/** What a press on a session's row needs to know of this device's family view. */
export interface FamilyPressScope {
  /** Whether this device shows children in their parent's tab. */
  enabled: boolean
  /** How many cards the parent tab `tab` has room for, or null when it has not been measured. */
  capacityOf: (tab: string) => number | null
  /**
   * Whether the pane of parent tab `tab` has room for its family view; true
   * for a pane that has not been measured. Left out, every pane has room.
   */
  roomOf?: FamilyRoomOf
}

/**
 * A press on a session's row in the Sessions tree: where it goes, and the
 * layout that goes with it.
 *
 * A session with a tab here is brought forward, the layout unchanged. A child
 * with no tab whose parent's tab is here comes with that tab to the front,
 * and while the family view is on and its pane has room for it, it shows as a
 * card in it, the last card shrinking in its place when it was a header; no
 * tab is added.
 *
 * A running child that is on screen nowhere here is `peek`, the layout
 * unchanged: its parent's tab is not open here, or that tab's pane has no room
 * for the family view, or this device does not show children in their parent's
 * tab. An ended child in such a place keeps what it had: its parent's tab
 * comes forward when there is one here, and otherwise it is `open`. Anything
 * else is `open`, which is the one press that gives a session a tab, and the
 * caller opens it as any running session not open here is.
 */
export function pressSessionRow<T extends FamilyMember>(
  layout: PaneLayout,
  sessions: readonly T[],
  id: number,
  host: string,
  scope: FamilyPressScope
): { layout: PaneLayout; press: FamilyPress } {
  const tabbed = sessionTabIds(layout, host)
  if (tabbed.has(id)) return { layout, press: { to: 'own-tab', id } }
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const holder = tabHolder(byId, id, tabbed)
  const running = byId.get(id)?.status === 'running'
  if (holder === null) {
    return { layout, press: { to: running && hasRunningParent(byId, id) ? 'peek' : 'open', id } }
  }

  const tab = paneId(sessionRef(holder, host))
  const press: FamilyPress = { to: 'parent-tab', id: holder }
  if (!scope.enabled || !(scope.roomOf?.(tab) ?? true)) {
    return running ? { layout, press: { to: 'peek', id } } : { layout: activateTab(layout, tab), press }
  }
  const family = familiesHere(layout, sessions, host).get(holder) ?? []
  const shown = showFamilyChild(layout, tab, family, scope.capacityOf(tab), id)
  return { layout: activateTab(shown, tab), press }
}
