import { describe, expect, it } from 'vitest'
import {
  activateTab,
  activeRef,
  besideOf,
  closeGroup,
  closeTab,
  cycleTab,
  EMPTY_LAYOUT,
  findTab,
  focusGroup,
  fromSaved,
  isSplit,
  moveTab,
  neighbourAt,
  openFile,
  openTab,
  paneId,
  placeBeside,
  placeIn,
  placeRestored,
  reconcile,
  resizeSplit,
  retitleTab,
  savedGroups,
  sendBeside,
  splitWith,
  toSaved,
  upgradeSavedLayout,
  visibleTabs,
  type FileRef,
  type PaneLayout,
  type PaneNode,
  type PaneRef,
  type SavedPane,
  type SavedPaneGroup,
  type SavedPaneLayout,
  type SavedPaneNode
} from './panes'

const session = (id: number): PaneRef => ({ kind: 'session', id })
const project = (path: string): PaneRef => ({ kind: 'project', path })
const browser = (id: number): PaneRef => ({ kind: 'browser', id })
const HISTORY: PaneRef = { kind: 'history' }
const SETTINGS: PaneRef = { kind: 'settings' }
const CONFIG: PaneRef = { kind: 'config' }
const SESSIONS: PaneRef = { kind: 'sessions' }
const plugin = (tab: string, params: Record<string, string | number | boolean> = {}, title: string | null = null): PaneRef => ({
  kind: 'plugin',
  plugin: 'sample',
  tab,
  params,
  title
})

/** A group of tabs, as a saved tree spells one. Browser tabs are let in for building live layouts. */
const g = (...tabs: PaneRef[]): SavedPaneGroup => ({ panes: tabs as SavedPane[], activeId: null })
const row = (children: SavedPaneNode[], sizes = children.map(() => 1 / children.length)): SavedPaneNode => ({
  axis: 'row',
  children,
  sizes
})
const column = (children: SavedPaneNode[], sizes = children.map(() => 1 / children.length)): SavedPaneNode => ({
  axis: 'column',
  children,
  sizes
})

/** A live layout, its groups numbered 1, 2, ... in reading order, focused on the one at `focused`. */
const layoutOf = (root: SavedPaneNode, focused = 0): PaneLayout => fromSaved({ root, focused })

/** The ids in each group in reading order, front tab marked with `*`, focused group with `>`. */
function shape(layout: PaneLayout): string[] {
  return layout.groups.map((group) => {
    const front = activeRef(group)
    const ids = group.tabs.map((ref) => (ref === front ? `*${paneId(ref)}` : paneId(ref)))
    return `${group.id === layout.focused ? '>' : ' '}${ids.join(' ')}`
  })
}

/** The tree by group id: `row(1, column(2, 3))`. */
function tree(node: PaneNode): string {
  return isSplit(node) ? `${node.axis}(${node.children.map(tree).join(', ')})` : String(node.group)
}

/** Every split's shares, depth first, to three places. */
function sizes(node: PaneNode): number[][] {
  if (!isSplit(node)) return []
  return [node.sizes.map((size) => Math.round(size * 1000) / 1000), ...node.children.flatMap(sizes)]
}

describe('paneId', () => {
  it('keeps the shapes the drivers address tabs by', () => {
    expect(paneId(session(12))).toBe('session:12')
    expect(paneId(project('C:\\work\\a#b:c'))).toBe('project:C:\\work\\a#b:c')
    expect(paneId(browser(3))).toBe('browser:3')
    expect(paneId(HISTORY)).toBe('history')
  })

  it('names a plugin tab by its parameters, in one spelling whatever order they were given in', () => {
    expect(paneId(plugin('detail'))).toBe('plugin:sample/detail')
    expect(paneId(plugin('run', { run: 7, live: true }))).toBe('plugin:sample/run?{"live":true,"run":7}')
    expect(paneId(plugin('run', { live: true, run: 7 }))).toBe(paneId(plugin('run', { run: 7, live: true })))
    expect(paneId(plugin('run', { run: 8 }))).not.toBe(paneId(plugin('run', { run: 7 })))
    // The title is what the tab is called, not which tab it is.
    expect(paneId(plugin('detail', {}, 'Renamed'))).toBe('plugin:sample/detail')
  })
})

describe('retitleTab', () => {
  it('renames a plugin tab in place, moving nothing', () => {
    const layout = layoutOf(row([g(HISTORY, plugin('run', { run: 1 })), g(SETTINGS)]), 1)
    const renamed = retitleTab(layout, 'plugin:sample/run?{"run":1}', 'Run 1')
    expect(renamed.groups[0]!.tabs[1]).toEqual(plugin('run', { run: 1 }, 'Run 1'))
    expect(shape(renamed)).toEqual(shape(layout))
    expect(retitleTab(renamed, 'plugin:sample/run?{"run":1}', null).groups[0]!.tabs[1]).toEqual(plugin('run', { run: 1 }))
  })

  it('leaves every other tab, a missing one and an unchanged title alone', () => {
    const layout = layoutOf(row([g(HISTORY, plugin('detail', {}, 'Same'))]))
    expect(retitleTab(layout, 'history', 'Nope')).toBe(layout)
    expect(retitleTab(layout, 'plugin:sample/gone', 'Nope')).toBe(layout)
    expect(retitleTab(layout, 'plugin:sample/detail', 'Same')).toBe(layout)
  })
})

describe('openTab', () => {
  it('appends to the focused group and brings the tab to the front', () => {
    const layout = openTab(openTab(EMPTY_LAYOUT, HISTORY), session(1))
    expect(shape(layout)).toEqual(['>history *session:1'])
  })

  it('activates a tab that is already open instead of opening it twice', () => {
    const layout = layoutOf(row([g(HISTORY, session(1)), g(SETTINGS)]), 1)
    expect(shape(openTab(layout, HISTORY))).toEqual(['>*history session:1', ' *settings'])
  })

  it('opens into the group asked for by id, and the focused one when that group is gone', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS)]), 0)
    expect(shape(openTab(layout, CONFIG, 2))).toEqual([' *history', '>settings *config'])
    expect(shape(openTab(layout, CONFIG, 9))).toEqual(['>history *config', ' *settings'])
  })
})

describe('closeTab', () => {
  it('hands the front to the neighbour that slides into its place', () => {
    const layout = activateTab(layoutOf(g(HISTORY, SETTINGS, CONFIG)), 'settings')
    expect(shape(closeTab(layout, 'settings'))).toEqual(['>history *config'])
  })

  it('takes the left neighbour when the last tab closes', () => {
    const layout = layoutOf(g(HISTORY, SETTINGS))
    expect(shape(closeTab(layout, 'settings'))).toEqual(['>*history'])
  })

  it('leaves the front alone when a background tab closes', () => {
    const layout = layoutOf(g(HISTORY, SETTINGS, CONFIG))
    expect(shape(closeTab(layout, 'history'))).toEqual(['>settings *config'])
  })

  it('drops a group that empties, giving its room and the focus to the pane before it', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS), g(CONFIG)], [0.2, 0.3, 0.5]), 1)
    const closed = closeTab(layout, 'settings')
    expect(shape(closed)).toEqual(['>*history', ' *config'])
    expect(tree(closed.root)).toBe('row(1, 3)')
    expect(sizes(closed.root)).toEqual([[0.5, 0.5]])
  })

  it('gives a first pane’s room to the one after it', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS), g(CONFIG)], [0.2, 0.3, 0.5]), 0)
    const closed = closeTab(layout, 'history')
    expect(shape(closed)).toEqual(['>*settings', ' *config'])
    expect(sizes(closed.root)).toEqual([[0.5, 0.5]])
  })

  it('collapses a split left holding one pane into that pane', () => {
    const layout = layoutOf(row([g(HISTORY), column([g(SETTINGS), g(CONFIG)])]))
    const closed = closeTab(layout, 'config')
    expect(tree(closed.root)).toBe('row(1, 2)')
    expect(shape(closed)).toEqual(['>*history', ' *settings'])
  })

  it('leaves one empty group, keeping its id, when the last tab in the window closes', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS)]), 1)
    const closed = closeTab(closeTab(layout, 'history'), 'settings')
    expect(closed.groups).toEqual([{ id: 2, tabs: [], activeId: null }])
    expect(closed.root).toEqual({ group: 2 })
    expect(closed.focused).toBe(2)
  })
})

describe('moveTab', () => {
  it('reorders within a group, counting the target after the tab has left', () => {
    const layout = layoutOf(g(HISTORY, SETTINGS, CONFIG))
    expect(shape(moveTab(layout, 'history', 1, 2))).toEqual(['>settings config *history'])
    expect(shape(moveTab(layout, 'config', 1, 0))).toEqual(['>*config history settings'])
  })

  it('moves a tab to another group, in front there, and focuses it', () => {
    const layout = layoutOf(row([g(HISTORY, SETTINGS), g(CONFIG)]), 0)
    expect(shape(moveTab(layout, 'history', 2, 0))).toEqual([' *settings', '>*history config'])
  })

  it('collapses when the tab leaves a group empty', () => {
    const layout = layoutOf(row([g(HISTORY), g(CONFIG)]), 0)
    const moved = moveTab(layout, 'history', 2, 1)
    expect(shape(moved)).toEqual(['>config *history'])
    expect(moved.root).toEqual({ group: 2 })
  })

  it('ignores a tab nobody holds and a group that does not exist', () => {
    const layout = layoutOf(g(HISTORY))
    expect(moveTab(layout, 'settings', 1, 0)).toBe(layout)
    expect(moveTab(layout, 'history', 5, 0)).toBe(layout)
  })
})

describe('splitWith', () => {
  const lone = layoutOf(g(HISTORY, SETTINGS))

  it('opens a new pane on the side the tab was dropped, holding it, focused', () => {
    const right = splitWith(lone, 'settings', 1, 'right')
    expect(tree(right.root)).toBe('row(1, 2)')
    expect(shape(right)).toEqual([' *history', '>*settings'])
    expect(sizes(right.root)).toEqual([[0.5, 0.5]])

    expect(tree(splitWith(lone, 'settings', 1, 'left').root)).toBe('row(2, 1)')
    expect(tree(splitWith(lone, 'settings', 1, 'bottom').root)).toBe('column(1, 2)')
    expect(tree(splitWith(lone, 'settings', 1, 'top').root)).toBe('column(2, 1)')
  })

  it('takes half of the room the pane it was dropped on had, in the same split', () => {
    const layout = layoutOf(row([g(HISTORY, SETTINGS), g(CONFIG)], [0.6, 0.4]))
    const split = splitWith(layout, 'settings', 2, 'right')
    expect(tree(split.root)).toBe('row(1, 2, 3)')
    expect(sizes(split.root)).toEqual([[0.6, 0.2, 0.2]])
  })

  it('nests a split across the other axis', () => {
    const layout = layoutOf(row([g(HISTORY, SETTINGS), g(CONFIG)]))
    const split = splitWith(layout, 'settings', 2, 'bottom')
    expect(tree(split.root)).toBe('row(1, column(2, 3))')
    expect(shape(split)).toEqual([' *history', ' *config', '>*settings'])
  })

  it('will not split a pane’s only tab off from that pane', () => {
    const layout = layoutOf(row([g(HISTORY), g(CONFIG)]))
    expect(splitWith(layout, 'config', 2, 'left')).toBe(layout)
  })

  it('moves another pane’s only tab, and that pane’s room goes beside it', () => {
    const layout = layoutOf(row([g(HISTORY), g(CONFIG)]))
    const split = splitWith(layout, 'config', 1, 'left')
    expect(tree(split.root)).toBe('row(3, 1)')
    expect(sizes(split.root)).toEqual([[0.25, 0.75]])
    expect(shape(split)).toEqual(['>*config', ' *history'])
  })

  it('never reuses an id, so a pane held across an await cannot become another', () => {
    const layout = layoutOf(row([g(HISTORY), g(CONFIG, SETTINGS)]))
    const closed = closeGroup(layout, 1)
    const split = splitWith(closed, 'settings', 2, 'right')
    expect(split.groups.map((group) => group.id)).toEqual([2, 3])
  })

  it('ignores a tab nobody holds and a pane that does not exist', () => {
    expect(splitWith(lone, 'config', 1, 'right')).toBe(lone)
    expect(splitWith(lone, 'settings', 7, 'right')).toBe(lone)
  })
})

describe('neighbourAt and besideOf', () => {
  // 1 | 2
  //   |---
  //   | 3
  const grid = layoutOf(row([g(HISTORY), column([g(SETTINGS), g(CONFIG)], [0.3, 0.7])]))

  it('finds the pane across each side, preferring the one sharing most of it', () => {
    expect(neighbourAt(grid, 1, 'right')).toBe(3)
    expect(neighbourAt(grid, 2, 'left')).toBe(1)
    expect(neighbourAt(grid, 3, 'left')).toBe(1)
    expect(neighbourAt(grid, 2, 'bottom')).toBe(3)
    expect(neighbourAt(grid, 3, 'top')).toBe(2)
    expect(neighbourAt(grid, 2, 'top')).toBeNull()
    expect(neighbourAt(grid, 1, 'left')).toBeNull()
  })

  it('takes the first in reading order on a tie', () => {
    const even = layoutOf(row([g(HISTORY), column([g(SETTINGS), g(CONFIG)])]))
    expect(neighbourAt(even, 1, 'right')).toBe(2)
  })

  it('means right, then left, then below, then above, and nothing for a pane alone', () => {
    expect(besideOf(grid, 1)).toBe(3)
    expect(besideOf(grid, 2)).toBe(1)
    const stacked = layoutOf(column([g(HISTORY), g(SETTINGS)]))
    expect(besideOf(stacked, 1)).toBe(2)
    expect(besideOf(stacked, 2)).toBe(1)
    expect(besideOf(layoutOf(g(HISTORY)), 1)).toBeNull()
  })
})

describe('sendBeside', () => {
  it('splits the focused front tab into a new pane on the right', () => {
    const layout = layoutOf(g(HISTORY, SETTINGS))
    const sent = sendBeside(layout)
    expect(shape(sent)).toEqual([' *history', '>*settings'])
    expect(tree(sent.root)).toBe('row(1, 2)')
  })

  it('appends to the other pane when there are two, from either side', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS, CONFIG)]), 1)
    expect(shape(sendBeside(layout))).toEqual(['>history *config', ' *settings'])
    expect(shape(sendBeside(focusGroup(layout, 1)))).toEqual(['>settings config *history'])
  })

  it('goes to the pane on the right of the middle one of three', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS, SESSIONS), g(CONFIG)]), 1)
    expect(shape(sendBeside(layout))).toEqual([' *history', ' *settings', '>config *sessions'])
  })

  it('does nothing to a lone tab in a lone pane', () => {
    const layout = layoutOf(g(HISTORY))
    expect(sendBeside(layout)).toBe(layout)
  })
})

describe('placeBeside', () => {
  it('opens a pane on the right for the tab when there is one', () => {
    const layout = layoutOf(g(HISTORY))
    expect(shape(placeBeside(layout, session(1)))).toEqual([' *history', '>*session:1'])
  })

  it('appends to the pane beside the focused one when there are two', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS)]), 1)
    expect(shape(placeBeside(layout, session(1)))).toEqual(['>history *session:1', ' *settings'])
  })

  it('moves a tab reconcile already put in the focused pane', () => {
    const layout = reconcile(layoutOf(g(HISTORY)), () => true, [session(1)])
    expect(shape(placeBeside(layout, session(1)))).toEqual([' *history', '>*session:1'])
  })

  it('leaves a tab alone in an otherwise empty window', () => {
    expect(shape(placeBeside(EMPTY_LAYOUT, session(1)))).toEqual(['>*session:1'])
  })
})

describe('placeIn', () => {
  const layout = layoutOf(row([g(HISTORY), g(SETTINGS)]), 0)

  it('lands in the pane asked for, not the focused one, and focuses it', () => {
    expect(shape(placeIn(layout, session(1), 2))).toEqual([' *history', '>settings *session:1'])
  })

  it('lands in the focused pane when that is the one asked for', () => {
    expect(shape(placeIn(layout, session(1), 1))).toEqual(['>history *session:1', ' *settings'])
  })

  it('moves a tab reconcile already put in the focused pane', () => {
    const reconciled = reconcile(layout, () => true, [session(1)])
    expect(shape(placeIn(reconciled, session(1), 2))).toEqual([' *history', '>settings *session:1'])
  })

  it('opens into a lone empty pane', () => {
    expect(shape(placeIn(EMPTY_LAYOUT, session(1), 1))).toEqual(['>*session:1'])
  })

  it('falls back to the focused pane when the one asked for has gone', () => {
    expect(shape(placeIn(layout, session(1), 9))).toEqual(['>history *session:1', ' *settings'])
  })
})

describe('closeGroup', () => {
  it('merges the closed pane into the other rather than closing its tabs', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS, CONFIG)]), 0)
    const closed = closeGroup(layout, 2)
    expect(shape(closed)).toEqual(['>*history settings config'])
    expect(closed.root).toEqual({ group: 1 })
  })

  it('hands a pane’s tabs to the same side its room goes to', () => {
    const layout = layoutOf(row([g(HISTORY), g(SETTINGS), g(CONFIG)], [0.2, 0.3, 0.5]), 2)
    const closed = closeGroup(layout, 2)
    expect(shape(closed)).toEqual(['>*history settings', ' *config'])
    expect(sizes(closed.root)).toEqual([[0.5, 0.5]])
  })

  it('hands a first pane to the one after it, across a split by the most shared edge', () => {
    const layout = layoutOf(row([g(HISTORY), column([g(SETTINGS), g(CONFIG)], [0.3, 0.7])]))
    const closed = closeGroup(layout, 1)
    expect(tree(closed.root)).toBe('column(2, 3)')
    expect(shape(closed)).toEqual([' *settings', '>*config history'])
  })

  it('does nothing with one pane, or a pane that does not exist', () => {
    const layout = layoutOf(g(HISTORY))
    expect(closeGroup(layout, 1)).toBe(layout)
    const two = layoutOf(row([g(HISTORY), g(SETTINGS)]))
    expect(closeGroup(two, 9)).toBe(two)
  })
})

describe('resizeSplit', () => {
  const layout = layoutOf(row([g(HISTORY), column([g(SETTINGS), g(CONFIG)])]))

  it('sets the shares of the split a path names', () => {
    expect(sizes(resizeSplit(layout, [], [0.3, 0.7]).root)).toEqual([[0.3, 0.7], [0.5, 0.5]])
    expect(sizes(resizeSplit(layout, [1], [0.25, 0.75]).root)).toEqual([[0.5, 0.5], [0.25, 0.75]])
  })

  it('leaves the layout alone when the path no longer names a split of that many', () => {
    expect(resizeSplit(layout, [0], [0.5, 0.5])).toBe(layout)
    expect(resizeSplit(layout, [], [0.2, 0.3, 0.5])).toBe(layout)
    expect(resizeSplit(layout, [4], [0.5, 0.5])).toBe(layout)
  })
})

describe('reconcile', () => {
  it('drops tabs whose thing is gone and appends what has no tab to the focused group', () => {
    const layout = layoutOf(row([g(HISTORY, session(1)), g(session(2))]), 0)
    const reconciled = reconcile(
      layout,
      (ref) => ref.kind !== 'session' || ref.id !== 1,
      [session(2), session(3), browser(4)]
    )
    expect(shape(reconciled)).toEqual(['>history session:3 *browser:4', ' *session:2'])
  })

  it('appends each extra once, however often it is offered', () => {
    const reconciled = reconcile(EMPTY_LAYOUT, () => true, [session(1), session(1)])
    expect(shape(reconciled)).toEqual(['>*session:1'])
  })

  it('closes a group whose every tab is gone, and its room goes beside it', () => {
    const layout = layoutOf(row([g(HISTORY), g(session(2)), g(SETTINGS)], [0.2, 0.3, 0.5]), 0)
    const reconciled = reconcile(layout, (ref) => ref.kind !== 'session', [])
    expect(shape(reconciled)).toEqual(['>*history', ' *settings'])
    expect(sizes(reconciled.root)).toEqual([[0.5, 0.5]])
  })
})

describe('cycleTab', () => {
  it('walks every group in reading order as one ring and takes the focus with it', () => {
    const layout = layoutOf(row([g(HISTORY, SETTINGS), column([g(CONFIG), g(SESSIONS)])]), 0)
    const steps = [1, 1, 1, 1] as const
    const seen = steps.reduce<PaneLayout[]>((acc, step) => [...acc, cycleTab(acc.at(-1)!, step)], [
      activateTab(layout, 'history')
    ])
    expect(seen.map((step) => paneId(activeRef(step.groups.find((group) => group.id === step.focused)!)!))).toEqual([
      'history',
      'settings',
      'config',
      'sessions',
      'history'
    ])
    expect(paneId(activeRef(cycleTab(seen[0]!, -1).groups[2]!)!)).toBe('sessions')
  })

  it('does nothing with fewer than two tabs', () => {
    const layout = layoutOf(g(HISTORY))
    expect(cycleTab(layout, 1)).toBe(layout)
  })
})

describe('visibleTabs and findTab', () => {
  it('reports the front tab of each group and where any tab is, by group id', () => {
    const layout = layoutOf(row([g(HISTORY, SETTINGS), column([g(CONFIG), g(SESSIONS)])]))
    expect(visibleTabs(layout).map(paneId)).toEqual(['settings', 'config', 'sessions'])
    expect(findTab(layout, 'sessions')).toEqual({ group: 3, index: 0 })
    expect(findTab(layout, 'history')).toEqual({ group: 1, index: 0 })
    expect(findTab(layout, 'nothing')).toBeNull()
  })
})

describe('toSaved and fromSaved', () => {
  it('writes a plugin tab down with its parameters and title, and reads it back the same', () => {
    const layout = layoutOf(row([g(HISTORY, plugin('run', { run: 4 }, 'Run 4'))]))
    const saved = toSaved(layout)
    expect(saved.root).toEqual({
      panes: [HISTORY, plugin('run', { run: 4 }, 'Run 4')],
      activeId: 'plugin:sample/run?{"run":4}'
    })
    expect(shape(fromSaved(saved))).toEqual(shape(layout))
  })

  it('writes down the tree, its shares, and pages and sessions in their groups', () => {
    const layout = activateTab(
      layoutOf(
        row([g(project('C:\\a'), session(4), browser(9)), column([g(HISTORY, { kind: 'restore' }), g(SETTINGS)], [0.4, 0.6])], [0.7, 0.3]),
        0
      ),
      'browser:9'
    )
    expect(toSaved(layout)).toEqual({
      root: {
        axis: 'row',
        children: [
          { panes: [project('C:\\a'), session(4)], activeId: null },
          {
            axis: 'column',
            children: [
              { panes: [HISTORY], activeId: null },
              { panes: [SETTINGS], activeId: 'settings' }
            ],
            sizes: [0.4, 0.6]
          }
        ],
        sizes: [0.7, 0.3]
      },
      focused: 0
    })
  })

  it('writes down no group with nothing in it worth keeping, its room and focus going beside it', () => {
    const layout = layoutOf(row([g(HISTORY), g(browser(1)), g(SETTINGS)], [0.2, 0.3, 0.5]), 1)
    expect(toSaved(layout)).toEqual({
      root: {
        axis: 'row',
        children: [
          { panes: [HISTORY], activeId: 'history' },
          { panes: [SETTINGS], activeId: 'settings' }
        ],
        sizes: [0.5, 0.5]
      },
      focused: 0
    })
  })

  it('writes the empty window as one empty group', () => {
    expect(toSaved(EMPTY_LAYOUT)).toEqual({ root: { panes: [], activeId: null }, focused: 0 })
    expect(toSaved(layoutOf(g(browser(1))))).toEqual({ root: { panes: [], activeId: null }, focused: 0 })
  })

  it('reads back what it wrote, and writes that again unchanged', () => {
    const layout = layoutOf(
      row([g(HISTORY, SESSIONS), column([g(SETTINGS), row([g(CONFIG), g(project('C:\\b'))], [0.3, 0.7])], [0.45, 0.55])], [0.37, 0.63]),
      3
    )
    const saved = toSaved(layout)
    const again = toSaved(fromSaved(JSON.parse(JSON.stringify(saved)) as SavedPaneLayout))
    expect(JSON.stringify(again)).toBe(JSON.stringify(saved))
    expect(saved.focused).toBe(3)
  })

  it('tidies a hand-edited tree: a split of one, a split inside its own axis, shares not summing to one', () => {
    const layout = fromSaved({
      root: {
        axis: 'row',
        children: [
          { axis: 'column', children: [g(HISTORY)], sizes: [1] },
          { axis: 'row', children: [g(SETTINGS), g(CONFIG)], sizes: [1, 3] }
        ],
        sizes: [2, 2]
      },
      focused: 0
    } as SavedPaneLayout)
    expect(tree(layout.root)).toBe('row(1, 2, 3)')
    expect(sizes(layout.root)).toEqual([[0.5, 0.125, 0.375]])
  })

  it('shares a split evenly when its shares are missing or unusable', () => {
    const layout = fromSaved({
      root: { axis: 'row', children: [g(HISTORY), g(SETTINGS)], sizes: [0.5] },
      focused: 0
    })
    expect(sizes(layout.root)).toEqual([[0.5, 0.5]])
  })

  it('drops tab kinds an older build wrote and keeps the rest of its group', () => {
    const retired = [
      { kind: 'content' },
      { kind: 'pulls' },
      { kind: 'pr', repoPath: 'C:\\r', number: 7 }
    ] as unknown as SavedPane[]
    const layout = fromSaved({
      root: { panes: [HISTORY, ...retired, SETTINGS], activeId: 'pulls' },
      focused: 0
    })
    expect(shape(layout)).toEqual(['>history *settings'])
  })

  it('restores a group of only sessions as no group at all, once nothing hosts them', () => {
    const layout = fromSaved({ root: row([g(HISTORY), g(session(4))]), focused: 1 })
    const reconciled = reconcile(layout, (ref) => ref.kind !== 'session', [])
    expect(shape(reconciled)).toEqual(['>*history'])
  })

  it('reads null as the empty window', () => {
    expect(fromSaved(null)).toEqual(EMPTY_LAYOUT)
  })

  it('lists a saved layout’s groups in reading order', () => {
    const saved = { root: row([g(HISTORY), column([g(SETTINGS), g(CONFIG)])]), focused: 0 }
    expect(savedGroups(saved).map((group) => group.panes.map((pane) => paneId(pane)))).toEqual([
      ['history'],
      ['settings'],
      ['config']
    ])
    expect(savedGroups(null)).toEqual([])
  })
})

describe('upgradeSavedLayout', () => {
  const A = g(HISTORY)
  const B = g(SETTINGS)

  it('leaves a tree alone', () => {
    const saved: SavedPaneLayout = { root: row([A, B]), focused: 1 }
    expect(upgradeSavedLayout(saved, 70)).toBe(saved)
  })

  it('reads one or two groups side by side as the row they were', () => {
    expect(upgradeSavedLayout({ groups: [A], focused: 0 }, 70)).toEqual({ root: A, focused: 0 })
    expect(upgradeSavedLayout({ groups: [A, B], focused: 1 }, 70)).toEqual({
      root: { axis: 'row', children: [A, B], sizes: [0.30000000000000004, 0.7] },
      focused: 1
    })
  })

  it('reads an unusable divider as the old default', () => {
    for (const split of [null, '62', 0, 100, Number.NaN]) {
      expect(upgradeSavedLayout({ groups: [A, B], focused: 0 }, split)).toEqual({
        root: { axis: 'row', children: [A, B], sizes: [0.55, 0.45] },
        focused: 0
      })
    }
  })

  it('reads anything else as no layout', () => {
    for (const value of [null, 'history', [], {}, { groups: [] }, { panes: [] }]) {
      expect(upgradeSavedLayout(value, 45)).toBeNull()
    }
  })
})

describe('placeRestored', () => {
  // The saved layout of the crashed run: project a with session 1 behind it and
  // session 2 after it in the first pane, history and session 3 in the second.
  const saved: SavedPaneLayout = {
    root: row([
      { panes: [project('C:\\a') as SavedPane, session(1) as SavedPane, session(2) as SavedPane], activeId: 'session:1' },
      { panes: [HISTORY as SavedPane, session(3) as SavedPane], activeId: 'history' }
    ]),
    focused: 0
  }

  /**
   * The start after the crash: the saved layout drawn with none of its sessions
   * hosted, then the reopened ones given tabs where `reconcile` puts them.
   */
  const restart = (reopened: number[], from: SavedPaneLayout = saved): PaneLayout => {
    const drawn = reconcile(fromSaved(from), (ref) => ref.kind !== 'session', [])
    return reconcile(drawn, (ref) => ref.kind !== 'session' || reopened.includes(ref.id), reopened.map(session))
  }

  it('puts each session back between the tabs it sat between, in the pane it was in', () => {
    const pairs = new Map([
      [1, 11],
      [2, 12],
      [3, 13]
    ])
    const restored = placeRestored(restart([11, 12, 13]), saved, pairs)
    expect(shape(restored)).toEqual(['>project:C:\\a *session:11 session:12', ' *history session:13'])
  })

  it('opens a pane of only sessions again, on the side it was on', () => {
    const left: SavedPaneLayout = { root: row([g(session(1)), g(HISTORY)]), focused: 0 }
    const restoredLeft = placeRestored(restart([11], left), left, new Map([[1, 11]]))
    expect(tree(restoredLeft.root)).toBe('row(3, 2)')
    // It had the focus when the run crashed, and gets it back.
    expect(shape(restoredLeft)).toEqual(['>*session:11', ' *history'])

    // Restored without asking, nothing is drawn first: the reopened session is
    // hosted before the saved layout's own session pane has been dropped.
    const unasked = reconcile(fromSaved(left), (ref) => ref.kind !== 'session' || ref.id === 11, [session(11)])
    expect(shape(placeRestored(unasked, left, new Map([[1, 11]])))).toEqual(shape(restoredLeft))

    const right: SavedPaneLayout = { root: row([g(HISTORY), g(session(1))]), focused: 0 }
    const restoredRight = placeRestored(restart([11], right), right, new Map([[1, 11]]))
    expect(shape(restoredRight)).toEqual(['>*history', ' *session:11'])
  })

  it('opens it beside the nearest pane in the saved tree that is open now, on the side it was on', () => {
    // 1 | 2
    //   |---
    //   | sessions
    const grid: SavedPaneLayout = {
      root: row([g(project('C:\\a')), column([g(HISTORY), g(session(1), session(2))])]),
      focused: 0
    }
    const restored = placeRestored(
      restart([11, 12], grid),
      grid,
      new Map([
        [1, 11],
        [2, 12]
      ])
    )
    expect(tree(restored.root)).toBe('row(1, column(2, 4))')
    expect(shape(restored)).toEqual(['>*project:C:\\a', ' *history', ' session:11 *session:12'])
  })

  it('keeps the order of what came back when a neighbour did not', () => {
    const restored = placeRestored(restart([12]), saved, new Map([[2, 12]]))
    // Its saved front was session 1, which did not come back, so the front stays put.
    expect(shape(restored)).toEqual(['>*project:C:\\a session:12', ' *history'])
  })

  it('reopens into an empty window, a second pane of only sessions beside the first', () => {
    const both: SavedPaneLayout = { root: row([g(session(1)), g(session(2))]), focused: 0 }
    const restored = placeRestored(
      restart([11, 12], both),
      both,
      new Map([
        [1, 11],
        [2, 12]
      ])
    )
    expect(tree(restored.root)).toBe('row(1, 3)')
    expect(shape(restored)).toEqual(['>*session:11', ' *session:12'])
  })

  it('leaves a session the saved layout does not name where it is, and does nothing without a layout', () => {
    const layout = restart([11, 99])
    const restored = placeRestored(layout, saved, new Map([[1, 11]]))
    expect(shape(restored)).toEqual(['>project:C:\\a *session:11 session:99', ' *history'])
    expect(placeRestored(layout, null, new Map([[1, 11]]))).toBe(layout)
  })
})

describe('openFile', () => {
  const file = (name: string): FileRef => ({ kind: 'file', root: 'C:\\r', path: `C:\\r\\${name}` })

  it('opens beside a session in front, in a pane of its own when there is only one', () => {
    const layout = layoutOf(g(session(1)))
    const { layout: opened, preview } = openFile(layout, file('a.ts'), null, false)
    expect(shape(opened)).toEqual([' *session:1', '>*file:C:\\r\\a.ts'])
    expect(preview).toBe('file:C:\\r\\a.ts')
  })

  it('opens in the pane beside when a session is in front of the focused one', () => {
    const layout = layoutOf(column([g(session(1)), g(HISTORY)]), 0)
    const { layout: opened } = openFile(layout, file('a.ts'), null, true)
    expect(shape(opened)).toEqual([' *session:1', '>history *file:C:\\r\\a.ts'])
  })

  it('opens in the focused pane when what is in front is not a session', () => {
    const layout = layoutOf(row([g(HISTORY), g(session(1))]), 0)
    const { layout: opened } = openFile(layout, file('a.ts'), null, true)
    expect(shape(opened)).toEqual(['>history *file:C:\\r\\a.ts', ' *session:1'])
  })

  it('replaces the preview in place on the next single click, and keeps a tab opened to stay', () => {
    const first = openFile(layoutOf(g(HISTORY)), file('a.ts'), null, false)
    const second = openFile(first.layout, file('b.ts'), first.preview, false)
    expect(shape(second.layout)).toEqual(['>history *file:C:\\r\\b.ts'])
    expect(second.preview).toBe('file:C:\\r\\b.ts')
    const kept = openFile(second.layout, file('c.ts'), second.preview, true)
    expect(shape(kept.layout)).toEqual(['>history file:C:\\r\\b.ts *file:C:\\r\\c.ts'])
    expect(kept.preview).toBe('file:C:\\r\\b.ts')
  })

  it('brings an open file forward, and keeping the preview ends it being one', () => {
    const first = openFile(layoutOf(g(HISTORY)), file('a.ts'), null, false)
    const away = activateTab(first.layout, 'history')
    const back = openFile(away, file('a.ts'), first.preview, true)
    expect(shape(back.layout)).toEqual(['>history *file:C:\\r\\a.ts'])
    expect(back.preview).toBeNull()
  })

  it('forgets a preview whose tab has been closed', () => {
    const first = openFile(layoutOf(g(HISTORY)), file('a.ts'), null, false)
    const closed = closeTab(first.layout, 'file:C:\\r\\a.ts')
    const next = openFile(closed, file('b.ts'), first.preview, true)
    expect(next.preview).toBeNull()
  })
})
