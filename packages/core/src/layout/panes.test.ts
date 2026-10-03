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
  openTab,
  paneId,
  placeBeside,
  reconcile,
  sendToOtherGroup,
  toSaved,
  visibleTabs,
  type PaneLayout,
  type PaneRef
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
  it('keeps the persistable tabs in their groups and drops what does not survive a restart', () => {
    const layout = layoutOf([project('C:\\a'), session(1)], [HISTORY, { kind: 'browser', id: 2 }])
    const saved = toSaved(layout)
    expect(saved).toEqual({
      groups: [
        { panes: [project('C:\\a')], activeId: null },
        { panes: [HISTORY], activeId: null }
      ],
      focused: 1
    })
    // The fronts were tabs that are not written down, so neither is named, and
    // each group restores with its last tab in front.
    expect(shape(fromSaved(saved))).toEqual([' *project:C:\\a', '>*history'])
  })

  it('restores a group of only sessions as no group at all', () => {
    const saved = toSaved(layoutOf([HISTORY], [session(1)]))
    expect(shape(fromSaved(saved))).toEqual(['>*history'])
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
