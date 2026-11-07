import { describe, expect, it } from 'vitest'
import {
  commandState,
  foldedState,
  isCommandChild,
  mostPressingState,
  resolveFamilyPress,
  SESSION_URGENCY,
  sessionFamilies,
  type FamilyMember,
  type FamilyRow,
  type UrgentState
} from './family'

interface Listed extends FamilyMember {
  cwd: string
  state?: UrgentState
}

const running = (id: number, cwd: string, patch: Partial<Listed> = {}): Listed => ({
  id,
  cwd,
  status: 'running',
  ...patch
})

const child = (id: number, cwd: string, parentId: number, parentName: string, patch: Partial<Listed> = {}): Listed =>
  running(id, cwd, { parentId, parentName, ...patch })

/** The tree as indented ids, with a marked top-level child's parent after it. */
function drawn(rows: readonly FamilyRow<Listed>[], depth = 0): string[] {
  return rows.flatMap((row) => [
    `${'  '.repeat(depth)}${String(row.session.id)}${row.parentName === null ? '' : ` (of ${row.parentName})`}`,
    ...drawn(row.children, depth + 1)
  ])
}

describe('sessionFamilies', () => {
  it('nests each child under its parent whatever folder either runs in', () => {
    const rows = sessionFamilies([
      running(1, 'C:\\work\\hub'),
      running(2, 'C:\\work\\other'),
      child(3, 'C:\\work\\docs', 1, 'lead'),
      child(4, 'D:\\elsewhere', 1, 'lead'),
      child(5, 'C:\\work\\hub', 2, 'planner')
    ])
    expect(drawn(rows)).toEqual(['1', '  3', '  4', '2', '  5'])
  })

  it('nests a grandchild under its own parent, one more step in', () => {
    const rows = sessionFamilies([running(1, 'a'), child(2, 'b', 1, 'lead'), child(3, 'c', 2, 'reviewer')])
    expect(drawn(rows)).toEqual(['1', '  2', '    3'])
  })

  it('keeps the order it was given, children included, and a session with no parent at the top', () => {
    const rows = sessionFamilies([
      child(4, 'a', 1, 'lead'),
      running(2, 'a'),
      running(1, 'a'),
      child(3, 'a', 1, 'lead')
    ])
    expect(drawn(rows)).toEqual(['2', '1', '  4', '  3'])
  })

  it('draws a child whose parent has ended as a top-level row marked with the parent’s name', () => {
    const rows = sessionFamilies([
      running(1, 'a', { status: 'exited' }),
      child(2, 'b', 1, 'lead'),
      child(3, 'c', 2, 'reviewer')
    ])
    expect(drawn(rows)).toEqual(['1', '2 (of lead)', '  3'])
  })

  it('draws a child whose parent is not listed at all as a top-level row marked with the parent’s name', () => {
    const rows = sessionFamilies([child(2, 'b', 9, 'lead')])
    expect(drawn(rows)).toEqual(['2 (of lead)'])
  })

  it('marks nothing for a child that names no parent, which is all a top-level row can say', () => {
    const rows = sessionFamilies([running(2, 'b', { parentId: 9, parentName: null })])
    expect(rows[0]?.parentName).toBeNull()
    expect(drawn(rows)).toEqual(['2'])
  })

  it('draws a parent link that loops as top-level rows rather than losing the sessions on it', () => {
    const rows = sessionFamilies([child(1, 'a', 2, 'two'), child(2, 'a', 1, 'one'), child(3, 'a', 2, 'two')])
    // Session 3 hangs off the loop without being on it, so it stays nested.
    expect(drawn(rows)).toEqual(['1 (of two)', '2 (of one)', '  3'])
  })

  it('draws a session that names itself as its parent at the top level', () => {
    const rows = sessionFamilies([child(1, 'a', 1, 'itself')])
    expect(drawn(rows)).toEqual(['1 (of itself)'])
  })

  it('keeps an ended child under a parent that still runs', () => {
    const rows = sessionFamilies([running(1, 'a'), child(2, 'a', 1, 'lead', { status: 'exited' })])
    expect(drawn(rows)).toEqual(['1', '  2'])
  })
})

describe('isCommandChild', () => {
  it('is a session that carries a command line, and no other', () => {
    expect(isCommandChild({ command: 'pnpm test' })).toBe(true)
    expect(isCommandChild({ command: null })).toBe(false)
    expect(isCommandChild({ command: '' })).toBe(false)
    expect(isCommandChild({})).toBe(false)
  })
})

describe('commandState', () => {
  it('runs while the command runs, whatever the exit code field holds', () => {
    expect(commandState({ status: 'running', exitCode: null })).toBe('running')
    expect(commandState({ status: 'running' })).toBe('running')
  })

  it('has ended after exit 0, and when its code was never observed as an agent would', () => {
    expect(commandState({ status: 'exited', exitCode: 0 })).toBe('ended')
    expect(commandState({ status: 'exited', exitCode: null })).toBe('ended')
    expect(commandState({ status: 'lost' })).toBe('ended')
  })

  it('has failed after any other exit code', () => {
    expect(commandState({ status: 'exited', exitCode: 1 })).toBe('failed')
    expect(commandState({ status: 'exited', exitCode: 137 })).toBe('failed')
    expect(commandState({ status: 'exited', exitCode: -1 })).toBe('failed')
  })
})

describe('mostPressingState', () => {
  it('is the state that most wants you, in the order waiting, error, working, failed, then the rest', () => {
    const order: UrgentState[] = ['waiting', 'error', 'busy', 'failed', 'running', 'shell', 'idle', 'ended']
    expect([...SESSION_URGENCY]).toEqual(order)
    for (let i = 0; i < order.length; i++) {
      expect(mostPressingState([...order.slice(i)].reverse())).toBe(order[i])
    }
  })

  it('has none when no session has a state', () => {
    expect(mostPressingState([])).toBeNull()
    expect(mostPressingState([null, null])).toBeNull()
    expect(mostPressingState([null, 'ended'])).toBe('ended')
  })
})

describe('foldedState', () => {
  const stateOf = (session: Listed): UrgentState | null => session.state ?? null

  const family = (...sessions: Listed[]): FamilyRow<Listed> => sessionFamilies(sessions)[0]!

  it('gives a folded parent its most pressing child’s state', () => {
    const row = family(
      running(1, 'a', { state: 'idle' }),
      child(2, 'b', 1, 'lead', { state: 'busy' }),
      child(3, 'c', 1, 'lead', { state: 'waiting' }),
      child(4, 'd', 1, 'lead', { state: 'idle' })
    )
    expect(foldedState(row, stateOf)).toBe('waiting')
  })

  it('reads the grandchildren as well, because they are folded in too', () => {
    const row = family(
      running(1, 'a', { state: 'idle' }),
      child(2, 'b', 1, 'lead', { state: 'idle' }),
      child(3, 'c', 2, 'reviewer', { state: 'error' })
    )
    expect(foldedState(row, stateOf)).toBe('error')
  })

  it('leaves the parent’s own state out, which its own dot shows', () => {
    const row = family(running(1, 'a', { state: 'waiting' }), child(2, 'b', 1, 'lead', { state: 'idle' }))
    expect(foldedState(row, stateOf)).toBe('idle')
  })

  it('has none for a parent with no children, or whose children have no state', () => {
    expect(foldedState(family(running(1, 'a', { state: 'busy' })), stateOf)).toBeNull()
    expect(foldedState(family(running(1, 'a'), child(2, 'b', 1, 'lead')), stateOf)).toBeNull()
  })
})

describe('resolveFamilyPress', () => {
  const sessions = [
    running(1, 'a'),
    child(2, 'b', 1, 'lead'),
    child(3, 'c', 2, 'reviewer'),
    running(4, 'd'),
    child(5, 'e', 4, 'lead')
  ]
  const tabs = (...ids: number[]): ReadonlySet<number> => new Set(ids)

  it('brings the child’s own tab forward when it has one in this window', () => {
    expect(resolveFamilyPress(sessions, 2, tabs(1, 2))).toEqual({ to: 'own-tab', id: 2 })
  })

  it('brings its parent’s tab forward when the child has none', () => {
    expect(resolveFamilyPress(sessions, 2, tabs(1))).toEqual({ to: 'parent-tab', id: 1 })
  })

  it('brings the nearest parent with a tab forward when the one above has none', () => {
    expect(resolveFamilyPress(sessions, 3, tabs(1))).toEqual({ to: 'parent-tab', id: 1 })
    expect(resolveFamilyPress(sessions, 3, tabs(1, 2))).toEqual({ to: 'parent-tab', id: 2 })
  })

  it('does what pressing any running session not open here does when no tab of the family is here', () => {
    expect(resolveFamilyPress(sessions, 2, tabs(4))).toEqual({ to: 'open', id: 2 })
    expect(resolveFamilyPress(sessions, 5, tabs())).toEqual({ to: 'open', id: 5 })
  })

  it('does not reach through a parent that ended, which no longer holds the child in its tab', () => {
    const ended = [running(1, 'a', { status: 'exited' }), child(2, 'b', 1, 'lead')]
    expect(resolveFamilyPress(ended, 2, tabs(1))).toEqual({ to: 'open', id: 2 })
  })

  it('opens a session with no parent as it always has', () => {
    expect(resolveFamilyPress(sessions, 4, tabs(1))).toEqual({ to: 'open', id: 4 })
    expect(resolveFamilyPress(sessions, 4, tabs(4))).toEqual({ to: 'own-tab', id: 4 })
  })

  it('stops at a loop in the parent links', () => {
    const looped = [child(1, 'a', 2, 'two'), child(2, 'a', 1, 'one')]
    expect(resolveFamilyPress(looped, 1, tabs())).toEqual({ to: 'open', id: 1 })
  })
})
