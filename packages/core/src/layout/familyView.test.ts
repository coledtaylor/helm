import { describe, expect, it } from 'vitest'
import type { FamilyMember } from './family'
import { LOCAL_HOST_KEY } from '../hosts'
import {
  arrangeFamily,
  closeFamilyChild,
  familyOf,
  pressSessionRow,
  shrinkFamilyChild,
  showFamilyChild
} from './familyView'
import { familyEntries, PLAIN_FAMILY } from './familyState'
import {
  activeRef,
  closeTab,
  familiesHere,
  fromSaved,
  moveTab,
  notOpenHere,
  openTab,
  paneId,
  reconcile,
  returnsToFamily,
  sessionRef,
  sessionTabIds,
  shownSessionIds,
  toSaved,
  unplacedSessionTabs,
  upgradeSavedLayout,
  type PaneLayout,
  type PaneRef,
  type SavedPane,
  type SavedPaneGroup,
  type SavedPaneNode
} from './panes'

const session = (id: number, host?: string): PaneRef => sessionRef(id, host)
const HISTORY: PaneRef = { kind: 'history' }
const SETTINGS: PaneRef = { kind: 'settings' }

const g = (...tabs: PaneRef[]): SavedPaneGroup => ({ panes: tabs as SavedPane[], activeId: null })
const row = (children: SavedPaneNode[]): SavedPaneNode => ({
  axis: 'row',
  children,
  sizes: children.map(() => 1 / children.length)
})
const column = (children: SavedPaneNode[]): SavedPaneNode => ({
  axis: 'column',
  children,
  sizes: children.map(() => 1 / children.length)
})
const layoutOf = (root: SavedPaneNode, focused = 0): PaneLayout => fromSaved({ root, focused })

const running = (id: number, parentId?: number): FamilyMember => ({
  id,
  status: 'running',
  ...(parentId === undefined ? {} : { parentId, parentName: 'lead' })
})
const ended = (id: number, parentId: number): FamilyMember => ({
  id,
  status: 'exited',
  parentId,
  parentName: 'lead'
})

/** A parent, 1, running three children, 2 to 4. */
const FAMILY = [running(1), running(2, 1), running(3, 1), running(4, 1)]
const ROOM = (): boolean => true
const NO_ROOM = (): boolean => false

/** The window as it stands: every strip, split and tab, with nothing of a family in it. */
const arrangement = (layout: PaneLayout): unknown => ({
  root: layout.root,
  groups: layout.groups,
  focused: layout.focused
})

describe('a parent starting children', () => {
  const laidOut = layoutOf(row([g(session(1), HISTORY), column([g(session(9)), g(SETTINGS)])]), 0)
  const hosted = [...FAMILY, running(9)]

  it('adds no tab and no pane anywhere, for a window that gives its sessions their tabs itself', () => {
    const reconciled = reconcile(laidOut, () => true, unplacedSessionTabs(hosted, false))
    expect(reconciled).toEqual(laidOut)
  })

  it('adds no tab and no pane anywhere, for a window whose tabs are its own device’s', () => {
    const reconciled = reconcile(laidOut, () => true, unplacedSessionTabs(hosted, true))
    expect(reconciled).toEqual(laidOut)
  })

  it('adds none when children keep starting, one after another and several at once', () => {
    let current = laidOut
    for (const count of [1, 2, 6]) {
      const children = Array.from({ length: count }, (_, at) => running(20 + at, 1))
      current = reconcile(current, () => true, unplacedSessionTabs([...hosted, ...children], false))
    }
    expect(arrangement(current)).toEqual(arrangement(laidOut))
  })
})

describe('a child shown in its parent’s tab is open here', () => {
  const layout = layoutOf(g(session(1), HISTORY), 0)

  it('holds each child that has no tab of its own in the tab of the nearest running ancestor that has one', () => {
    const sessions = [...FAMILY, running(5, 2)]
    const held = familiesHere(layout, sessions)
    expect([...held.keys()]).toEqual([1])
    expect(held.get(1)?.map((child) => child.id)).toEqual([2, 3, 4, 5])
  })

  it('holds an ended child too, until its family view closes it, and a child with a tab of its own is not held', () => {
    const withTab = openTab(layout, session(3))
    const held = familiesHere(withTab, [...FAMILY, ended(6, 1)])
    expect(held.get(1)?.map((child) => child.id)).toEqual([2, 4, 6])
  })

  it('holds nothing of a child whose parent has no tab here, or that ended', () => {
    expect(familiesHere(layout, [running(7), running(8, 7)]).size).toBe(0)
    expect(familiesHere(layout, [{ ...running(1), status: 'exited' }, running(2, 1)]).size).toBe(0)
  })

  it('does not list a child the pane has room for as not open here, and lists it when the pane has none or the setting is off', () => {
    expect(notOpenHere(layout, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([])
    expect(notOpenHere(layout, FAMILY, LOCAL_HOST_KEY, NO_ROOM).map((s) => s.id)).toEqual([2, 3, 4])
    expect(notOpenHere(layout, FAMILY).map((s) => s.id)).toEqual([2, 3, 4])
  })

  it('lists a running session that is no one’s child as not open here, and a child whose parent has no tab here', () => {
    const sessions = [...FAMILY, running(7), running(8, 7)]
    expect(notOpenHere(layout, sessions, LOCAL_HOST_KEY, ROOM).map((s) => s.id)).toEqual([7, 8])
  })

  it('has the window’s connection carry its terminal along with the tabs’, and only while the pane has room', () => {
    expect(shownSessionIds(layout, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([1, 2, 3, 4])
    expect(shownSessionIds(layout, FAMILY, LOCAL_HOST_KEY, NO_ROOM)).toEqual([1])
    expect(shownSessionIds(layout, FAMILY)).toEqual([1])
  })

  it('asks the room of the pane the parent’s tab is in, tab by tab', () => {
    const two = layoutOf(row([g(session(1)), g(session(5))]), 0)
    const sessions = [running(1), running(2, 1), running(5), running(6, 5)]
    const roomOf = (tab: string): boolean => tab === 'session:5'
    expect(shownSessionIds(two, sessions, LOCAL_HOST_KEY, roomOf)).toEqual([1, 5, 6])
    expect(notOpenHere(two, sessions, LOCAL_HOST_KEY, roomOf).map((s) => s.id)).toEqual([2])
  })

  it('reads another host’s sessions by that host’s tabs, and this PC’s ids are not theirs', () => {
    const away = layoutOf(g(session(1, 'build'), session(2)), 0)
    const sessions = [running(1), running(2, 1), running(3, 1)]
    expect(shownSessionIds(away, sessions, 'build', ROOM)).toEqual([1, 2, 3])
    // This PC's own tab is session 2, whose parent has no tab on this PC.
    expect(shownSessionIds(away, sessions, LOCAL_HOST_KEY, ROOM)).toEqual([2])
    expect(sessionTabIds(away, 'build')).toEqual(new Set([1]))
  })
})

describe('Close tab, keep running on a child', () => {
  const layout = layoutOf(g(session(1), session(2), HISTORY), 0)

  it('puts the child back in its parent’s family view, which carries its terminal, and does not list it as not open here', () => {
    expect(returnsToFamily(layout, FAMILY, 2, LOCAL_HOST_KEY, ROOM)).toBe(true)
    const closed = closeTab(layout, paneId(session(2)))
    expect(sessionTabIds(closed)).toEqual(new Set([1]))
    expect(shownSessionIds(closed, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([1, 2, 3, 4])
    expect(notOpenHere(closed, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([])
    expect(familiesHere(closed, FAMILY).get(1)?.map((child) => child.id)).toEqual([2, 3, 4])
  })

  it('lets nothing of it go where it would not come back: no family view on this device, no room, a parent with no tab, or a session no one started', () => {
    expect(returnsToFamily(layout, FAMILY, 2, LOCAL_HOST_KEY, null)).toBe(false)
    expect(returnsToFamily(layout, FAMILY, 2, LOCAL_HOST_KEY, NO_ROOM)).toBe(false)
    expect(returnsToFamily(layout, FAMILY, 1, LOCAL_HOST_KEY, ROOM)).toBe(false)
    expect(returnsToFamily(layoutOf(g(session(2), HISTORY), 0), FAMILY, 2, LOCAL_HOST_KEY, ROOM)).toBe(false)
    expect(returnsToFamily(layout, FAMILY, 99, LOCAL_HOST_KEY, ROOM)).toBe(false)
  })

  it('keeps how the other children were arranged', () => {
    const arranged = shrinkFamilyChild(layout, paneId(session(1)), running(3, 1))
    const closed = closeTab(arranged, paneId(session(2)))
    expect(familyOf(closed, paneId(session(1))).shrunk).toEqual([3])
  })
})

describe('the arrangement of a family', () => {
  const parent = paneId(session(1))
  const layout = layoutOf(row([g(session(1), HISTORY), g(SETTINGS)]), 0)
  const children = FAMILY.slice(1)

  it('is a plain family until someone arranges it, and arranging adds no tab or pane', () => {
    expect(familyOf(layout, parent)).toBe(PLAIN_FAMILY)
    const shrunk = shrinkFamilyChild(layout, parent, children[1]!)
    expect(familyOf(shrunk, parent).shrunk).toEqual([3])
    expect(arrangement(shrunk)).toEqual(arrangement(layout))
  })

  it('is the same layout when nothing changed, and drops an arrangement that comes to say nothing', () => {
    const shrunk = shrinkFamilyChild(layout, parent, children[1]!)
    expect(shrinkFamilyChild(shrunk, parent, children[1]!)).toBe(shrunk)
    const plain = arrangeFamily(shrunk, parent, () => PLAIN_FAMILY)
    expect(plain.families).toEqual({})
  })

  it('belongs to a tab the layout has, and is ignored for one it does not', () => {
    expect(shrinkFamilyChild(layout, 'session:77', children[0]!)).toBe(layout)
  })

  it('goes when the parent’s tab does', () => {
    const shrunk = shrinkFamilyChild(layout, parent, children[1]!)
    expect(closeTab(shrunk, parent).families).toEqual({})
  })

  it('follows a tab that moves between panes', () => {
    const shrunk = shrinkFamilyChild(layout, parent, children[1]!)
    const moved = moveTab(shrunk, parent, shrunk.groups[1]!.id, 0)
    expect(moved.groups[1]!.tabs).toContainEqual(session(1))
    expect(familyOf(moved, parent).shrunk).toEqual([3])
  })

  it('shrinks, shows and closes through the layout the way the family does', () => {
    const shrunk = shrinkFamilyChild(layout, parent, children[0]!)
    const shown = showFamilyChild(shrunk, parent, children, 2, 2)
    expect(familyOf(shown, parent).shrunk).toEqual([4])
    const gone = [children[0]!, children[1]!, ended(4, 1)]
    const closed = closeFamilyChild(shown, parent, 4)
    expect(familyOf(closed, parent).closed).toEqual([4])
    expect(familyEntries(gone, familyOf(closed, parent), 3).map((e) => e.child.id)).toEqual([3, 2])
  })
})

describe('the arrangement written down with the panes', () => {
  const parent = paneId(session(1))
  const base = layoutOf(row([g(session(1), session(3), HISTORY), g(SETTINGS)]), 0)
  const arranged = shrinkFamilyChild(
    showFamilyChild(base, parent, FAMILY.slice(1), 1, 4),
    parent,
    running(2, 1)
  )

  it('comes back as it was after a reload or a restart, children shown, shrunk and opened as tabs', () => {
    const saved = toSaved(arranged)
    const read = fromSaved(upgradeSavedLayout(JSON.parse(JSON.stringify(saved)) as unknown, null))
    expect(read.families).toEqual(arranged.families)
    expect(sessionTabIds(read)).toEqual(new Set([1, 3]))
    expect(familyOf(read, parent).shrunk).toEqual(familyOf(arranged, parent).shrunk)
  })

  it('is kept by reconcile while the sessions have not been listed, and cut back to the children that still exist once they have', () => {
    const everything = reconcile(arranged, () => true, [])
    expect(everything.families).toEqual(arranged.families)

    const survivors = reconcile(arranged, (ref) => ref.kind !== 'session' || ref.id !== 4, [])
    expect(familyOf(survivors, parent).order).not.toContain(4)
    expect(familyOf(survivors, parent).shrunk).toEqual(familyOf(arranged, parent).shrunk)

    const none = reconcile(arranged, (ref) => ref.kind !== 'session' || ref.id === 1, [])
    expect(none.families).toEqual({})
  })

  it('writes nothing for a layout no family has been arranged in, as before', () => {
    expect(toSaved(base)).not.toHaveProperty('families')
  })

  it('reads a layout written before families existed', () => {
    const old = { root: g(session(1)), focused: 0 }
    expect(fromSaved(upgradeSavedLayout(old, null)).families).toEqual({})
  })

  it('keeps the arrangements that read and drops the one that does not', () => {
    const saved = toSaved(arranged)
    const hand = { ...saved, families: { ...saved.families, 'session:3': { shrunk: ['x'] } } }
    const upgraded = upgradeSavedLayout(hand, null)
    expect(Object.keys(upgraded?.families ?? {})).toEqual([parent])
  })

  it('drops an arrangement saved for a tab the layout does not have', () => {
    const saved = { ...toSaved(base), families: { 'session:55': { order: [], shrunk: [2], closed: [], screens: [] } } }
    expect(fromSaved(saved).families).toEqual({})
  })
})

describe('two devices attached to one host', () => {
  it('arrange the same family by their own layouts, each leaving the other’s as it was', () => {
    const parent = paneId(session(1))
    const mine = layoutOf(g(session(1)), 0)
    const theirs = layoutOf(g(session(1), HISTORY), 0)
    const shrunk = shrinkFamilyChild(mine, parent, running(3, 1))
    const opened = openTab(theirs, session(2))

    expect(familyOf(shrunk, parent).shrunk).toEqual([3])
    expect(familyOf(theirs, parent)).toBe(PLAIN_FAMILY)
    expect(familyOf(opened, parent)).toBe(PLAIN_FAMILY)
    // Each shows the children by its own layout.
    expect(shownSessionIds(shrunk, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([1, 2, 3, 4])
    expect(shownSessionIds(opened, FAMILY, LOCAL_HOST_KEY, ROOM)).toEqual([1, 2, 3, 4])
    expect(familiesHere(opened, FAMILY).get(1)?.map((child) => child.id)).toEqual([3, 4])
    expect(familiesHere(shrunk, FAMILY).get(1)?.map((child) => child.id)).toEqual([2, 3, 4])
  })
})

describe('pressing a child’s row in the Sessions tree', () => {
  const parent = paneId(session(1))
  const behind = layoutOf(row([g(session(1), HISTORY), g(SETTINGS)]), 1)
  const scope = (capacity: number | null, enabled = true) => ({ enabled, capacityOf: () => capacity })

  it('brings the parent’s tab forward and shows a header as a card, the last card shrinking in its place, with no tab added', () => {
    expect(activeRef(behind.groups[0]!)).toEqual(HISTORY)
    const pressed = pressSessionRow(behind, FAMILY, 4, LOCAL_HOST_KEY, scope(2))
    expect(pressed.press).toEqual({ to: 'parent-tab', id: 1 })
    expect(activeRef(pressed.layout.groups[0]!)).toEqual(session(1))
    expect(pressed.layout.focused).toBe(pressed.layout.groups[0]!.id)
    expect(familyEntries(FAMILY.slice(1), familyOf(pressed.layout, parent), 2).map((e) => `${e.shape}${e.child.id}`)).toEqual(
      ['card2', 'card4', 'header3']
    )
    expect(sessionTabIds(pressed.layout)).toEqual(new Set([1]))
    expect(pressed.layout.groups.map((group) => group.tabs)).toEqual(behind.groups.map((group) => group.tabs))
  })

  it('brings the parent forward and moves nothing for a child that is already a card', () => {
    const pressed = pressSessionRow(behind, FAMILY, 2, LOCAL_HOST_KEY, scope(2))
    expect(pressed.press).toEqual({ to: 'parent-tab', id: 1 })
    expect(pressed.layout.families).toEqual({})
    expect(activeRef(pressed.layout.groups[0]!)).toEqual(session(1))
  })

  it('puts the child first when the pane has not been measured', () => {
    const pressed = pressSessionRow(behind, FAMILY, 4, LOCAL_HOST_KEY, scope(null))
    expect(familyOf(pressed.layout, parent).order[0]).toBe(4)
  })

  it('shows an ended child’s last screen and takes it back into a family view that closed it', () => {
    const done = [...FAMILY.slice(0, 3), ended(4, 1)]
    const closed = closeFamilyChild(behind, parent, 4)
    const pressed = pressSessionRow(closed, done, 4, LOCAL_HOST_KEY, scope(3))
    const state = familyOf(pressed.layout, parent)
    expect(state.closed).toEqual([])
    expect(state.screens).toEqual([4])
  })

  it('brings a child’s own tab forward and arranges nothing', () => {
    const own = openTab(behind, session(3))
    const pressed = pressSessionRow(own, FAMILY, 3, LOCAL_HOST_KEY, scope(2))
    expect(pressed).toEqual({ layout: own, press: { to: 'own-tab', id: 3 } })
  })

  it('is a press that opens a tab only for a child whose parent has none here', () => {
    const pressed = pressSessionRow(behind, [running(7), running(8, 7)], 8, LOCAL_HOST_KEY, scope(2))
    expect(pressed).toEqual({ layout: behind, press: { to: 'open', id: 8 } })
  })

  it('still brings the parent forward with the setting off, and leaves how it is arranged alone', () => {
    const pressed = pressSessionRow(behind, FAMILY, 4, LOCAL_HOST_KEY, scope(2, false))
    expect(pressed.press).toEqual({ to: 'parent-tab', id: 1 })
    expect(pressed.layout.families).toEqual({})
    expect(activeRef(pressed.layout.groups[0]!)).toEqual(session(1))
  })

  it('works the same through another host’s tabs', () => {
    const away = layoutOf(row([g(session(1, 'build'), HISTORY), g(SETTINGS)]), 1)
    const pressed = pressSessionRow(away, FAMILY, 4, 'build', scope(2))
    expect(pressed.press).toEqual({ to: 'parent-tab', id: 1 })
    expect(Object.keys(pressed.layout.families)).toEqual([paneId(session(1, 'build'))])
  })
})
