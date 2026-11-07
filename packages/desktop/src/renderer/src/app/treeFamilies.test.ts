import { describe, expect, it } from 'vitest'
import {
  LOCAL_HOST_KEY,
  activeRef,
  familyEntries,
  familyOf,
  fromSaved,
  openTab,
  paneId,
  resolveFamilyPress,
  sessionTabIds,
  shrinkFamilyChild,
  type FamilyMember,
  type PaneLayout,
  type PaneRef,
  type SavedPane,
  type SavedPaneLayout
} from '@helm/core/types'
import type { TreeSession } from '@helm/ui'
import { commandRow, pressTreeSession, treeEntries } from './treeFamilies'

/**
 * What the Sessions tree is given for sessions that started sessions: a child's
 * row nested under its parent's whatever folder it runs in, a child whose parent
 * has ended listed on its own and naming it, and where pressing a child goes.
 */

interface Listed extends FamilyMember {
  name: string
  cwd: string
  stopped?: boolean
}

const session = (
  id: number,
  name: string,
  cwd: string,
  extra: Partial<Listed> = {}
): Listed => ({ id, name, cwd, status: 'running', ...extra })

const rowOf = (listed: Listed): TreeSession => ({
  id: `session:${String(listed.id)}`,
  label: listed.name,
  state: 'idle',
  note: '',
  hint: listed.cwd,
  outside: false,
  shown: null
})

const ids = (rows: readonly TreeSession[] | undefined): string[] => (rows ?? []).map((row) => row.id)

describe('commandRow', () => {
  const record = (extra: Partial<Listed>): Listed =>
    session(3, 'tests', '/work/helm', { parentId: 1, parentName: 'api-refactor', ...extra })

  it('S24: marks a command child with its command and a state of running, ended or failed from its record', () => {
    const command = 'pnpm test'
    expect(commandRow(record({ command, exitCode: null }))).toEqual({ command: true, state: 'running', note: 'running' })
    expect(commandRow(record({ command, status: 'exited', exitCode: 0 }))).toEqual({
      command: true,
      state: 'ended',
      note: 'exited 0'
    })
    expect(commandRow(record({ command, status: 'exited', exitCode: 1 }))).toEqual({
      command: true,
      state: 'failed',
      note: 'exited 1'
    })
    expect(commandRow(record({ command, status: 'exited', exitCode: 130 }))).toEqual({
      command: true,
      state: 'failed',
      note: 'exited 130'
    })
  })

  it('reads a command child the host stopped as stopped, not as the number the system gave it', () => {
    expect(commandRow(record({ command: 'pnpm test', status: 'exited', exitCode: 2147483647, stopped: true }))).toEqual({
      command: true,
      state: 'ended',
      note: 'stopped'
    })
  })

  it('reads a command child that ended with no code observed as ended, as an agent would be', () => {
    expect(commandRow(record({ command: 'make', status: 'lost', exitCode: null }))).toEqual({
      command: true,
      state: 'ended',
      note: 'ended'
    })
  })

  it('marks no agent child, and none whose command is empty', () => {
    expect(commandRow(record({}))).toBeNull()
    expect(commandRow(record({ command: null }))).toBeNull()
    expect(commandRow(record({ command: '' }))).toBeNull()
  })

  it('carries the mark into the row a command child is nested as under its parent', () => {
    const entries = treeEntries(
      [
        session(1, 'api-refactor', '/work/helm'),
        record({ command: 'pnpm test', status: 'exited', exitCode: 1 })
      ],
      (listed) => ({ ...rowOf(listed), ...commandRow(listed) })
    )
    const nested = entries[0]?.row.nested ?? []
    expect(nested).toHaveLength(1)
    expect(nested[0]).toMatchObject({ id: 'session:3', command: true, state: 'failed' })
    expect(entries[0]?.row.command).toBeUndefined()
  })
})

describe('treeEntries', () => {
  it('S18: nests a child under its parent whatever folder either runs in', () => {
    const entries = treeEntries(
      [
        session(1, 'api-refactor', 'C:\\work\\helm'),
        session(2, 'reviewer', 'C:\\work\\trackr', { parentId: 1, parentName: 'api-refactor' }),
        session(3, 'worker', 'C:\\work\\almanac', { parentId: 1, parentName: 'api-refactor' }),
        session(4, 'docs pass', 'C:\\work\\helm')
      ],
      rowOf
    )

    // Two top-level entries, listed by the folder each one runs in; the
    // children are inside the parent's row and not entries of their own.
    expect(entries.map((entry) => [entry.session.id, entry.session.cwd])).toEqual([
      [1, 'C:\\work\\helm'],
      [4, 'C:\\work\\helm']
    ])
    expect(ids(entries[0]?.row.nested)).toEqual(['session:2', 'session:3'])
    expect(entries[0]?.row.parentName).toBeUndefined()
    expect(entries[1]?.row.nested).toBeUndefined()
  })

  it('S18: lists a child whose parent has ended on its own, naming the parent', () => {
    const entries = treeEntries(
      [
        session(1, 'api-refactor', 'C:\\work\\helm', { status: 'exited' }),
        session(2, 'worker', 'C:\\work\\trackr', { parentId: 1, parentName: 'api-refactor' })
      ],
      rowOf
    )
    expect(entries.map((entry) => entry.session.id)).toEqual([1, 2])
    const worker = entries[1]?.row
    expect(worker?.parentName).toBe('api-refactor')
    expect(worker?.nested).toBeUndefined()
    // The ended parent holds nothing.
    expect(entries[0]?.row.nested).toBeUndefined()
  })

  it('S18: lists a child whose parent is not among the sessions it was given on its own', () => {
    const entries = treeEntries(
      [session(2, 'worker', 'C:\\work\\trackr', { parentId: 9, parentName: 'api-refactor' })],
      rowOf
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.row.parentName).toBe('api-refactor')
  })

  it('nests a grandchild under the child that started it', () => {
    const entries = treeEntries(
      [
        session(1, 'api-refactor', 'C:\\work\\helm'),
        session(2, 'lead', 'C:\\work\\trackr', { parentId: 1, parentName: 'api-refactor' }),
        session(3, 'helper', 'C:\\work\\almanac', { parentId: 2, parentName: 'lead' })
      ],
      rowOf
    )
    expect(entries).toHaveLength(1)
    const lead = entries[0]?.row.nested?.[0]
    expect(lead?.id).toBe('session:2')
    expect(ids(lead?.nested)).toEqual(['session:3'])
  })

  it('keeps every session when the links loop back on themselves', () => {
    const entries = treeEntries(
      [
        session(1, 'a', 'C:\\work\\helm', { parentId: 2, parentName: 'b' }),
        session(2, 'b', 'C:\\work\\helm', { parentId: 1, parentName: 'a' })
      ],
      rowOf
    )
    expect(entries.map((entry) => entry.session.id).sort()).toEqual([1, 2])
  })
})

describe('where pressing a child’s row goes', () => {
  const family = [
    session(1, 'api-refactor', 'C:\\work\\helm'),
    session(2, 'reviewer', 'C:\\work\\trackr', { parentId: 1, parentName: 'api-refactor' })
  ]

  it('S20: brings the child’s own tab forward when it has one in this window', () => {
    expect(resolveFamilyPress(family, 2, new Set([1, 2]))).toEqual({ to: 'own-tab', id: 2 })
  })

  it('S20: brings its parent’s tab forward when the child has none here', () => {
    expect(resolveFamilyPress(family, 2, new Set([1]))).toEqual({ to: 'parent-tab', id: 1 })
  })

  it('S20: opens the child’s tab, on this press, only when neither has one', () => {
    expect(resolveFamilyPress(family, 2, new Set())).toEqual({ to: 'open', id: 2 })
  })
})

describe('pressing a child’s row when its parent’s tab is here', () => {
  const parentTab: PaneRef = { kind: 'session', id: 1 }
  const children = [3, 4, 5, 6]
  const family = [
    session(1, 'lead', 'C:\\work\\helm'),
    ...children.map((id) =>
      session(id, `worker ${String(id)}`, 'C:\\work\\trackr', { parentId: 1, parentName: 'lead' })
    )
  ]
  /** The panes as the window keeps them, with the parent’s tab behind History and a second pane beside it. */
  const panes = (): { layout: PaneLayout } => {
    const saved: SavedPaneLayout = {
      root: {
        axis: 'row',
        children: [
          { panes: [parentTab as SavedPane, { kind: 'history' }], activeId: 'history' },
          { panes: [{ kind: 'settings' }], activeId: 'settings' }
        ],
        sizes: [0.6, 0.4]
      },
      focused: 1
    }
    return { layout: fromSaved(saved) }
  }
  const press = (
    id: number,
    options: { enabled?: boolean; capacity?: number | null; layout?: PaneLayout; roomOf?: () => boolean } = {}
  ): { to: number; how: string; layout: PaneLayout; start: PaneLayout } => {
    const world = panes()
    const start = options.layout ?? world.layout
    let layout = start
    const pressed = pressTreeSession(LOCAL_HOST_KEY, family, id, {
      layout: start,
      enabled: options.enabled ?? true,
      capacityOf: () => (options.capacity === undefined ? 2 : options.capacity),
      ...(options.roomOf === undefined ? {} : { roomOf: options.roomOf }),
      commit: (op) => {
        layout = op(layout)
      }
    })
    return { to: pressed.id, how: pressed.to, layout, start }
  }

  it('brings the parent’s tab forward and shows the child as a card, the last card shrinking in its place, with no tab added', () => {
    const { to, layout, start } = press(5)
    expect(to).toBe(1)
    expect(activeRef(layout.groups[0]!)).toEqual(parentTab)
    expect(layout.focused).toBe(layout.groups[0]!.id)
    const state = familyOf(layout, paneId(parentTab))
    expect(familyEntries(family.slice(1), state, 2).map((e) => `${e.shape}${String(e.child.id)}`)).toEqual([
      'card3',
      'card5',
      'header4',
      'header6'
    ])
    expect(layout.groups.map((group) => group.tabs)).toEqual(start.groups.map((group) => group.tabs))
    expect(sessionTabIds(layout)).toEqual(new Set([1]))
  })

  it('shows a shrunk child as a card the same way', () => {
    const shrunk = shrinkFamilyChild(panes().layout, paneId(parentTab), family[1]!)
    const { layout } = press(3, { layout: shrunk })
    const state = familyOf(layout, paneId(parentTab))
    expect(familyEntries(family.slice(1), state, 2).map((e) => `${e.shape}${String(e.child.id)}`)).toEqual([
      'card4',
      'card3',
      'header5',
      'header6'
    ])
  })

  it('moves no card when the child is already one, and only brings the parent’s tab forward', () => {
    const { layout, start } = press(4)
    expect(layout.families).toEqual({})
    expect(activeRef(layout.groups[0]!)).toEqual(parentTab)
    expect(layout.groups.map((group) => group.tabs)).toEqual(start.groups.map((group) => group.tabs))
  })

  it('puts the child first in a pane that has not been drawn yet, so it is a card whatever the pane holds', () => {
    const { layout } = press(6, { capacity: null })
    expect(familyOf(layout, paneId(parentTab)).order[0]).toBe(6)
  })

  it('S3: brings the parent’s tab forward, not a peek, for a child its family view shows', () => {
    const { to, how } = press(5)
    expect([how, to]).toEqual(['parent-tab', 1])
  })

  it('S1: peeks at a running child, and changes nothing in the panes, while the setting is off', () => {
    const { to, how, layout, start } = press(5, { enabled: false })
    expect([how, to]).toEqual(['peek', 5])
    expect(layout).toBe(start)
  })

  it('S1: peeks at a running child whose parent’s pane has no room for the family view', () => {
    const { to, how, layout, start } = press(5, { roomOf: () => false })
    expect([how, to]).toEqual(['peek', 5])
    expect(layout).toBe(start)
  })

  it('asks nothing of the panes for a child with a tab of its own, or for one whose parent has none here', () => {
    const own = openTab(panes().layout, { kind: 'session', id: 5 })
    const owned = press(5, { layout: own })
    expect(owned.to).toBe(5)
    expect(owned.layout).toBe(own)

    const parentless = pressTreeSession(
      LOCAL_HOST_KEY,
      [session(8, 'x', 'C:\\work', { parentId: 7, parentName: 'gone' })],
      8,
      {
        layout: panes().layout,
        enabled: true,
        capacityOf: () => 2,
        commit: () => {
          throw new Error('the panes are not changed for a press that opens a tab')
        }
      }
    )
    expect(parentless).toEqual({ to: 'open', id: 8 })
  })

  it('S24: peeks at a running command child as at an agent child, where its parent’s pane has no room or its tab is not here', () => {
    const withCommand = [
      ...family,
      session(9, 'tests', 'C:\\work', { parentId: 1, parentName: 'lead', command: 'pnpm test' }),
      session(10, 'orphan', 'C:\\work', { parentId: 7, parentName: 'lead', command: 'pnpm test' })
    ]
    const pressed = (id: number, roomOf?: () => boolean): { to: string; id: number } =>
      pressTreeSession(LOCAL_HOST_KEY, [...withCommand, session(7, 'lead', 'C:\\work')], id, {
        layout: panes().layout,
        enabled: true,
        capacityOf: () => 2,
        ...(roomOf === undefined ? {} : { roomOf }),
        commit: () => {
          throw new Error('the panes are not changed for a press that peeks')
        }
      })
    expect(pressed(9, () => false)).toEqual({ to: 'peek', id: 9 })
    expect(pressed(10)).toEqual({ to: 'peek', id: 10 })
  })

  it('S1: peeks at a running child whose parent is running but has no tab in this window', () => {
    const peeked = pressTreeSession(
      LOCAL_HOST_KEY,
      [session(7, 'lead', 'C:\\work'), session(8, 'x', 'C:\\work', { parentId: 7, parentName: 'lead' })],
      8,
      {
        layout: panes().layout,
        enabled: true,
        capacityOf: () => 2,
        commit: () => {
          throw new Error('the panes are not changed for a press that peeks')
        }
      }
    )
    expect(peeked).toEqual({ to: 'peek', id: 8 })
  })
})
