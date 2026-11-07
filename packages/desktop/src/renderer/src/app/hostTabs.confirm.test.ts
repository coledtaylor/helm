import type { ChildMember, UrgentState } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { confirmChildren } from './hostTabs'

const child = (id: number, extra: Partial<ChildMember> = {}): ChildMember => ({
  id,
  status: 'running',
  parentId: 7,
  parentName: 'lead',
  ...extra
})

describe('the children a close question names', () => {
  const sessions = [child(8), child(9, { outlive: true }), child(10, { command: true })]
  const stateOf = (session: ChildMember): UrgentState | null => (session.id === 8 ? 'waiting' : 'running')

  it('S18: lists those that end and those that outlive, each with its dot or its glyph and its state', () => {
    const plan = confirmChildren({ endingIds: [8, 10], outlivingIds: [9] }, sessions, stateOf)
    expect(plan.ends.map(({ child: each, mark }) => [each.id, mark])).toEqual([
      [8, { glyph: 'dot', state: 'waiting' }],
      [10, { glyph: 'command', state: 'running' }]
    ])
    expect(plan.outlives.map(({ child: each, mark }) => [each.id, mark])).toEqual([[9, { glyph: 'dot', state: 'running' }]])
  })

  it('S19: reads the host’s ids for a close another client made, leaving out a session this window does not list', () => {
    const plan = confirmChildren({ endingIds: [8, 99] }, sessions, stateOf)
    expect(plan.ends.map(({ child: each }) => each.id)).toEqual([8])
    expect(plan.outlives).toEqual([])
  })

  it('names nothing for a question from a host before protocol 2.1', () => {
    expect(confirmChildren({}, sessions, stateOf)).toEqual({ ends: [], outlives: [] })
  })
})
