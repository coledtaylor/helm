import { describe, expect, it } from 'vitest'
import {
  activateTab,
  activeRef,
  closeGroup,
  closeTab,
  cycleTab,
  EMPTY_LAYOUT,
  findTab,
  focusGroup,
  fromSaved,
  moveTab,
  openFile,
  openTab,
  paneId,
  placeBeside,
  placeRestored,
  reconcile,
  sendToOtherGroup,
  toSaved,
  visibleTabs,
  type FileRef,
  type PaneLayout,
  type PaneRef,
  type SavedPaneLayout
} from './panes'

const session = (id: number): PaneRef => ({ kind: 'session', id })
const project = (path: string): PaneRef => ({ kind: 'project', path })
const HISTORY: PaneRef = { kind: 'history' }
const SETTINGS: PaneRef = { kind: 'settings' }

/** The ids in each group, front tab marked with `*`, focused group with `>`. */
function shape(layout: PaneLayout): string[] {
  return layout.groups.map((group, index) => {
    const front = activeRef(group)
    const ids = group.tabs.map((ref) => (ref === front ? `*${paneId(ref)}` : paneId(ref)))
    return `${index === layout.focused ? '>' : ' '}${ids.join(' ')}`
  })
}

function layoutOf(...groups: PaneRef[][]): PaneLayout {
  return groups.reduce<PaneLayout>(
    (layout, tabs, group) => tabs.reduce((acc, ref) => openTab(acc, ref, group), layout),
    EMPTY_LAYOUT
  )
}

describe('paneId', () => {
  it('keeps the shapes the drivers address tabs by', () => {
    expect(paneId(session(12))).toBe('session:12')
    expect(paneId(project('C:\\work\\a#b:c'))).toBe('project:C:\\work\\a#b:c')
    expect(paneId({ kind: 'pr', repoPath: 'C:\\r', number: 7 })).toBe('pr:C:\\r#7')
    expect(paneId({ kind: 'browser', id: 3 })).toBe('browser:3')
    expect(paneId(HISTORY)).toBe('history')
  })
})

describe('openTab', () => {
  it('appends to the focused group and brings the tab to the front', () => {
    const layout = openTab(openTab(EMPTY_LAYOUT, HISTORY), session(1))
    expect(shape(layout)).toEqual(['>history *session:1'])
  })

  it('activates a tab that is already open instead of opening it twice', () => {
    const layout = layoutOf([HISTORY, session(1)], [SETTINGS])
    const reopened = openTab(layout, HISTORY)
    expect(shape(reopened)).toEqual(['>*history session:1', ' *settings'])
  })

  it('opens a second group beside the first, and no third', () => {
    const two = openTab(openTab(EMPTY_LAYOUT, HISTORY), session(1), 1)
    expect(shape(two)).toEqual([' *history', '>*session:1'])
    const three = openTab(two, session(2), 2)
    expect(three.groups).toHaveLength(2)
    expect(shape(three)).toEqual([' *history', '>session:1 *session:2'])
  })

  it('does not open a new group beside an empty window', () => {
    expect(shape(openTab(EMPTY_LAYOUT, HISTORY, 1))).toEqual(['>*history'])
  })
})

describe('closeTab', () => {
  it('hands the front to the neighbour that slides into its place', () => {
    const layout = activateTab(layoutOf([session(1), session(2), session(3)]), 'session:2')
    expect(shape(closeTab(layout, 'session:2'))).toEqual(['>session:1 *session:3'])
  })

  it('takes the left neighbour when the last tab closes', () => {
    const layout = layoutOf([session(1), session(2)])
    expect(shape(closeTab(layout, 'session:2'))).toEqual(['>*session:1'])
  })

  it('leaves the front alone when a background tab closes', () => {
    const layout = activateTab(layoutOf([session(1), session(2), session(3)]), 'session:1')
    expect(shape(closeTab(layout, 'session:3'))).toEqual(['>*session:1 session:2'])
  })

  it('drops a group that empties, and the other takes its place and the focus', () => {
    const layout = layoutOf([HISTORY], [session(1)])
    const closed = closeTab(focusGroup(layout, 0), 'history')
    expect(shape(closed)).toEqual(['>*session:1'])
  })

  it('leaves one empty group when the last tab in the window closes', () => {
    expect(closeTab(layoutOf([HISTORY]), 'history')).toEqual(EMPTY_LAYOUT)
  })
})

describe('moveTab', () => {
  it('reorders within a group, counting the target after the tab has left', () => {
    const layout = layoutOf([session(1), session(2), session(3)])
    expect(shape(moveTab(layout, 'session:1', 0, 2))).toEqual(['>session:2 session:3 *session:1'])
    expect(shape(moveTab(layout, 'session:3', 0, 0))).toEqual(['>*session:3 session:1 session:2'])
  })

  it('moves a tab to the other group, in front there, and focuses it', () => {
    const layout = focusGroup(layoutOf([session(1), session(2)], [HISTORY]), 0)
    const moved = moveTab(layout, 'session:1', 1, 0)
    expect(shape(moved)).toEqual([' *session:2', '>*session:1 history'])
  })

  it('opens the second group when moved past the last one', () => {
    const layout = layoutOf([session(1), session(2)])
    expect(shape(moveTab(layout, 'session:2', 1, 0))).toEqual([' *session:1', '>*session:2'])
  })

  it('will not split a group away from itself', () => {
    const layout = layoutOf([session(1)])
    expect(moveTab(layout, 'session:1', 1, 0)).toBe(layout)
  })

  it('collapses to one group when the first group gives away its last tab', () => {
    const layout = layoutOf([session(1)], [session(2)])
    expect(shape(moveTab(layout, 'session:1', 1, 1))).toEqual(['>session:2 *session:1'])
  })

  it('ignores a tab nobody holds and a group past the end', () => {
    const layout = layoutOf([session(1), session(2)])
    expect(moveTab(layout, 'session:9', 0, 0)).toBe(layout)
    expect(moveTab(layout, 'session:1', 5, 0)).toBe(layout)
  })
})

describe('sendToOtherGroup', () => {
  it('splits the focused front tab into a new group', () => {
    const layout = layoutOf([session(1), session(2)])
    expect(shape(sendToOtherGroup(layout))).toEqual([' *session:1', '>*session:2'])
  })

  it('appends to the other group when there already are two', () => {
    const layout = focusGroup(layoutOf([session(1), session(2)], [HISTORY]), 0)
    expect(shape(sendToOtherGroup(layout))).toEqual([' *session:1', '>history *session:2'])
  })

  it('does nothing to a lone tab', () => {
    const layout = layoutOf([session(1)])
    expect(sendToOtherGroup(layout)).toBe(layout)
  })
})

describe('placeBeside', () => {
  it('opens the second pane for the tab when there is one', () => {
    const layout = layoutOf([session(1)])
    expect(shape(placeBeside(layout, session(2)))).toEqual([' *session:1', '>*session:2'])
  })

  it('appends to the pane that is not focused when there are two', () => {
    const layout = focusGroup(layoutOf([session(1)], [HISTORY]), 0)
    expect(shape(placeBeside(layout, session(2)))).toEqual([' *session:1', '>history *session:2'])
    const fromRight = layoutOf([session(1)], [HISTORY])
    expect(shape(placeBeside(fromRight, session(2)))).toEqual(['>session:1 *session:2', ' *history'])
  })

  it('moves a tab reconcile already put in the focused pane', () => {
    const layout = reconcile(layoutOf([session(1)]), () => true, [session(1), session(2)])
    expect(shape(placeBeside(layout, session(2)))).toEqual([' *session:1', '>*session:2'])
  })

  it('leaves a tab alone in an otherwise empty window', () => {
    expect(shape(placeBeside(EMPTY_LAYOUT, session(1)))).toEqual(['>*session:1'])
  })
})

describe('closeGroup', () => {
  it('merges the closed group into the other rather than closing its tabs', () => {
    const layout = layoutOf([session(1)], [session(2), HISTORY])
    expect(shape(closeGroup(layout, 1))).toEqual(['>*session:1 session:2 history'])
    expect(shape(closeGroup(layout, 0))).toEqual(['>session:2 *history session:1'])
  })

  it('does nothing with one group', () => {
    const layout = layoutOf([session(1)])
    expect(closeGroup(layout, 0)).toBe(layout)
  })
})

describe('reconcile', () => {
  it('drops tabs whose thing is gone and appends what has no tab to the focused group', () => {
    const layout = focusGroup(layoutOf([session(1), session(2)], [HISTORY]), 0)
    const live = new Set(['session:2', 'history'])
    const drawn = reconcile(layout, (ref) => live.has(paneId(ref)) || ref.kind === 'browser', [
      session(2),
      { kind: 'browser', id: 4 }
    ])
    expect(shape(drawn)).toEqual(['>*session:2 browser:4', ' *history'])
  })

  it('appends each extra once, however often it is offered', () => {
    const drawn = reconcile(EMPTY_LAYOUT, () => true, [session(1), session(1)])
    expect(shape(drawn)).toEqual(['>*session:1'])
  })

  it('closes a group whose every tab is gone', () => {
    const layout = layoutOf([HISTORY], [session(1)])
    const drawn = reconcile(layout, (ref) => ref.kind !== 'session', [])
    expect(shape(drawn)).toEqual(['>*history'])
  })
})

describe('cycleTab', () => {
  it('walks every group as one ring and takes the focus with it', () => {
    const layout = focusGroup(
      activateTab(layoutOf([session(1), session(2)], [HISTORY]), 'session:2'),
      0
    )
    const next = cycleTab(layout, 1)
    expect(shape(next)).toEqual([' session:1 *session:2', '>*history'])
    const wrapped = cycleTab(next, 1)
    expect(shape(wrapped)).toEqual(['>*session:1 session:2', ' *history'])
    expect(shape(cycleTab(wrapped, -1))).toEqual([' *session:1 session:2', '>*history'])
  })

  it('does nothing with fewer than two tabs', () => {
    const layout = layoutOf([HISTORY])
    expect(cycleTab(layout, 1)).toBe(layout)
  })
})

describe('visibleTabs and findTab', () => {
  it('reports the front tab of each group and where any tab is', () => {
    const layout = layoutOf([session(1), session(2)], [HISTORY])
    expect(visibleTabs(layout).map(paneId)).toEqual(['session:2', 'history'])
    expect(findTab(layout, 'history')).toEqual({ group: 1, index: 0 })
    expect(findTab(layout, 'settings')).toBeNull()
  })
})

describe('toSaved and fromSaved', () => {
  it('writes down pages and sessions in their groups, and never a browser tab or the restore offer', () => {
    const layout = layoutOf(
      [project('C:\\a'), session(1)],
      [HISTORY, { kind: 'restore' }, { kind: 'browser', id: 2 }]
    )
    const saved = toSaved(layout)
    expect(saved).toEqual({
      groups: [
        { panes: [project('C:\\a'), session(1)], activeId: 'session:1' },
        { panes: [HISTORY], activeId: null }
      ],
      focused: 1
    })
    // A session nothing hosts is dropped before it is drawn; the other front
    // was not written down, so that group restores with its last tab in front.
    const hosted = (ref: PaneRef): boolean => ref.kind !== 'session'
    expect(shape(reconcile(fromSaved(saved), hosted, []))).toEqual([' *project:C:\\a', '>*history'])
  })

  it('restores a group of only sessions as no group at all', () => {
    const saved = toSaved(layoutOf([HISTORY], [session(1)]))
    const hosted = (ref: PaneRef): boolean => ref.kind !== 'session'
    expect(shape(reconcile(fromSaved(saved), hosted, []))).toEqual(['>*history'])
  })

  it('folds groups past the limit into the last and drops duplicate tabs', () => {
    const restored = fromSaved({
      groups: [
        { panes: [{ kind: 'history' }], activeId: 'history' },
        { panes: [{ kind: 'settings' }, { kind: 'history' }], activeId: null },
        { panes: [{ kind: 'config' }], activeId: 'config' }
      ],
      focused: 7
    })
    expect(shape(restored)).toEqual([' *history', '>settings *config'])
  })

  it('reads null as the empty window', () => {
    expect(fromSaved(null)).toEqual(EMPTY_LAYOUT)
  })
})

describe('placeRestored', () => {
  /** What the next start draws before anything is reopened: saved, then reconciled with no sessions hosted. */
  const startedFrom = (saved: SavedPaneLayout, reopened: number[] = []): PaneLayout => {
    const drawn = reconcile(fromSaved(saved), (ref) => ref.kind !== 'session', [])
    return reconcile(drawn, (ref) => ref.kind !== 'session' || reopened.includes(ref.id), reopened.map(session))
  }

  it('puts each session back between the tabs it sat between, in the pane it was in', () => {
    const saved = toSaved(
      activateTab(layoutOf([project('C:\\a'), session(1), HISTORY], [session(2), SETTINGS]), 'session:1')
    )
    const now = startedFrom(saved, [11, 12])
    // `reconcile` gave the reopened sessions tabs in the focused pane.
    expect(shape(now)).toEqual(['>project:C:\\a *history session:11 session:12', ' *settings'])

    const pairs = new Map([
      [1, 11],
      [2, 12]
    ])
    expect(shape(placeRestored(now, saved, pairs))).toEqual([
      '>project:C:\\a *session:11 history',
      ' session:12 *settings'
    ])
  })

  it('opens a pane of only sessions again, on the side it was on', () => {
    const saved = toSaved(activateTab(layoutOf([session(1), session(2)], [HISTORY]), 'session:2'))
    const now = startedFrom(saved, [21, 22])
    expect(shape(now)).toEqual(['>*history session:21 session:22'])

    const placed = placeRestored(now, saved, new Map([[1, 21], [2, 22]]))
    expect(shape(placed)).toEqual(['>session:21 *session:22', ' *history'])
  })

  it('keeps the order of what came back when a neighbour did not', () => {
    const saved = toSaved(layoutOf([session(1), project('C:\\a'), session(2), session(3), HISTORY]))
    const now = startedFrom(saved, [33])
    expect(shape(placeRestored(now, saved, new Map([[3, 33]])))).toEqual([
      '>project:C:\\a session:33 *history'
    ])
  })

  it('reopens into an empty window', () => {
    const saved = toSaved(layoutOf([session(1)], [session(2)]))
    const now = startedFrom(saved, [5, 6])
    expect(shape(placeRestored(now, saved, new Map([[1, 5], [2, 6]])))).toEqual([' *session:5', '>*session:6'])
  })

  it('leaves a session the saved layout does not name where it is, and does nothing without a layout', () => {
    const saved = toSaved(layoutOf([HISTORY, session(1)]))
    const now = startedFrom(saved, [8, 9])
    const placed = placeRestored(now, saved, new Map([[1, 8], [4, 9]]))
    expect(shape(placed)).toEqual(['>history *session:8 session:9'])
    expect(placeRestored(now, null, new Map([[1, 8]]))).toBe(now)
    expect(placeRestored(now, saved, new Map())).toBe(now)
  })
})

describe('openFile', () => {
  const file = (name: string): FileRef => ({ kind: 'file', root: '/p', path: `/p/${name}` })

  it('opens beside a session in front, in a pane of its own when there is only one', () => {
    const { layout, preview } = openFile(layoutOf([session(1)]), file('a.ts'), null, false)
    expect(shape(layout)).toEqual([' *session:1', '>*file:/p/a.ts'])
    expect(preview).toBe('file:/p/a.ts')
  })

  it('opens in the other pane when two are open and a session is in front of the focused one', () => {
    const start = focusGroup(layoutOf([session(1)], [HISTORY]), 0)
    const { layout } = openFile(start, file('a.ts'), null, true)
    expect(shape(layout)).toEqual([' *session:1', '>history *file:/p/a.ts'])
  })

  it('opens in the focused pane when what is in front is not a session', () => {
    const { layout } = openFile(layoutOf([session(1)], [HISTORY]), file('a.ts'), null, true)
    expect(shape(layout)).toEqual([' *session:1', '>history *file:/p/a.ts'])
    const alone = openFile(layoutOf([HISTORY]), file('a.ts'), null, true).layout
    expect(shape(alone)).toEqual(['>history *file:/p/a.ts'])
  })

  it('replaces the preview in place on the next single click, and keeps a tab opened to stay', () => {
    let state = openFile(layoutOf([session(1)]), file('a.ts'), null, false)
    state = openFile(focusGroup(state.layout, 1), file('b.ts'), state.preview, false)
    expect(shape(state.layout)).toEqual([' *session:1', '>*file:/p/b.ts'])
    expect(state.preview).toBe('file:/p/b.ts')

    state = openFile(state.layout, file('c.ts'), state.preview, true)
    expect(shape(state.layout)).toEqual([' *session:1', '>file:/p/b.ts *file:/p/c.ts'])
    expect(state.preview).toBe('file:/p/b.ts')
  })

  it('brings an open file forward, and keeping the preview ends it being one', () => {
    let state = openFile(layoutOf([session(1)]), file('a.ts'), null, false)
    const back = focusGroup(state.layout, 0)
    state = openFile(back, file('a.ts'), state.preview, false)
    expect(shape(state.layout)).toEqual([' *session:1', '>*file:/p/a.ts'])
    expect(state.preview).toBe('file:/p/a.ts')
    expect(openFile(state.layout, file('a.ts'), state.preview, true).preview).toBeNull()
  })

  it('forgets a preview whose tab has been closed', () => {
    const state = openFile(layoutOf([HISTORY]), file('a.ts'), null, false)
    const closed = closeTab(state.layout, 'file:/p/a.ts')
    const next = openFile(closed, file('b.ts'), state.preview, true)
    expect(next.preview).toBeNull()
  })
})
