import type { ChildMember, SessionRecord, UrgentState } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { confirmChildren, confirmRows, hostQuestionMessage } from './hostTabs'

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

describe('the close question as the window draws it', () => {
  it('S18: words the host’s question with the host named, as the window words its own, and leaves other questions as they are', () => {
    expect(hostQuestionMessage('“lead” is still running.', 'this PC’s host')).toBe('“lead” is still running on this PC’s host.')
    expect(hostQuestionMessage('“lead” is still running.', 'build box')).toBe('“lead” is still running on build box.')
    expect(hostQuestionMessage('“lead” is still running on build box.', 'build box')).toBe('“lead” is still running on build box.')
    expect(hostQuestionMessage('Quitting ends 3 sessions.', 'build box')).toBe('Quitting ends 3 sessions.')
  })

  it('S18: rows each child with its mark, name and what it is, a command as command', () => {
    const records = [
      { ...child(8), role: 'reviewer', branch: 'main', cwd: '/r', name: 'rev', label: null },
      { ...child(10, { command: true }), role: null, branch: 'main', cwd: '/r', name: 'tests', label: null }
    ] as unknown as Array<SessionRecord & ChildMember>
    const plan = confirmChildren({ endingIds: [8, 10] }, records, () => 'busy')
    const rows = confirmRows(plan)
    expect(rows.ends.map(({ id, mark, meta }) => [id, mark.glyph, meta])).toEqual([
      [8, 'dot', 'reviewer · main'],
      [10, 'command', 'command']
    ])
    expect(rows.outlives).toEqual([])
  })
})
