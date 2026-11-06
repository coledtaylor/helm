import { describe, expect, it } from 'vitest'
import { resolveFamilyPress, type FamilyMember } from '@helm/core/types'
import type { TreeSession } from '@helm/ui'
import { treeEntries } from './treeFamilies'

/**
 * What the Sessions tree is given for sessions that started sessions: a child's
 * row nested under its parent's whatever folder it runs in, a child whose parent
 * has ended listed on its own and naming it, and where pressing a child goes.
 */

interface Listed extends FamilyMember {
  name: string
  cwd: string
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
