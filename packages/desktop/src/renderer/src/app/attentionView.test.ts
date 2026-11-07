import type { StandingNotice } from '@helm/core/types'
import { describe, expect, it, vi } from 'vitest'
import { awayDetail, awayRows, awayTitle, limitNoticesByParent, toastDetail, waitsOnSentence } from './attentionView'

const notice = (overrides: Partial<StandingNotice> = {}): StandingNotice => ({
  id: 'notice-1',
  kind: 'limit',
  parentId: 1,
  parentName: 'api-refactor',
  childId: null,
  childName: null,
  text: 'The limit of 4 starts per parent holds.',
  since: '2026-11-07T14:41:00.000Z',
  limit: 'starts',
  allowMore: 16,
  ...overrides
})

describe('what the notices say', () => {
  it('S10, S11: words what a child waits on and who started it', () => {
    expect(waitsOnSentence('permission prompt')).toBe('It is waiting on a permission prompt.')
    expect(waitsOnSentence('question')).toBe('It is waiting on a question.')
    expect(waitsOnSentence('sign-in')).toBe('It is waiting on a sign-in.')
    expect(waitsOnSentence('waiting for you')).toBe('It is waiting for you.')
    expect(waitsOnSentence('Pick a branch')).toBe('It says: Pick a branch')
    expect(toastDetail({ waitsOn: 'permission prompt', startedBy: 'api-refactor' })).toBe(
      'It is waiting on a permission prompt. Started by api-refactor, which has been told.'
    )
  })

  it('S15: titles each notice by what it is about', () => {
    expect(awayTitle(notice({ kind: 'needs-you', childId: 4, childName: 'worker-2' }))).toBe('worker-2 needs you')
    expect(awayTitle(notice())).toBe('api-refactor was refused a start')
    expect(awayTitle(notice({ kind: 'error', childId: 5, childName: 'docs-check' }))).toBe('docs-check ended in error')
    expect(awayDetail(notice({ kind: 'needs-you', childName: 'worker-2', text: 'permission prompt' }))).toMatch(
      /^Waiting on a permission prompt since \d\d:\d\d\. Started by api-refactor, which was told\.$/
    )
    expect(awayDetail(notice())).toBe('The limit of 4 starts per parent holds.')
  })

  it('S15: Peek and Open for a child that needs you, Dismiss for a refused start or an error', () => {
    const actions = { show: vi.fn(), open: vi.fn(), dismiss: vi.fn() }
    const rows = awayRows(
      [
        notice({ id: 'needs-you-4', kind: 'needs-you', childId: 4, childName: 'worker-2', text: 'permission prompt' }),
        notice(),
        notice({ id: 'notice-2', kind: 'error', childId: 5, childName: 'docs-check', text: 'exit 3', limit: null })
      ],
      actions
    )
    expect(rows.map((row) => row.actions.map((action) => action.label))).toEqual([
      ['Peek', 'Open'],
      ['Dismiss'],
      ['Dismiss']
    ])
    expect(rows.map((row) => row.tone)).toEqual(['needs', 'needs', 'danger'])
    rows[0]!.actions[0]!.onPress()
    rows[0]!.actions[1]!.onPress()
    rows[1]!.actions[0]!.onPress()
    expect(actions.show).toHaveBeenCalledWith(4)
    expect(actions.open).toHaveBeenCalledWith(4)
    expect(actions.dismiss).toHaveBeenCalledWith('notice-1')
  })

  it('S16: a parent limit notice offers Allow only for the starts limit, and the newest refusal stands for the parent', () => {
    const notices = limitNoticesByParent(
      [
        notice({ id: 'old', since: '2026-11-07T10:00:00.000Z', limit: 'children', allowMore: null, text: 'children' }),
        notice({ id: 'new', since: '2026-11-07T11:00:00.000Z' }),
        notice({ id: 'other', parentId: 2, limit: 'heavy', allowMore: null, text: 'heavy' }),
        notice({ id: 'err', parentId: 3, kind: 'error', limit: null }),
        notice({ id: 'wait', parentId: 4, kind: 'needs-you', limit: null })
      ],
      (each) => `host\n${each.id}`
    )
    expect([...notices.keys()]).toEqual([1, 2])
    expect(notices.get(1)).toEqual({ key: 'host\nnew', text: 'The limit of 4 starts per parent holds.', allowMore: 16 })
    expect(notices.get(2)?.allowMore).toBeNull()
  })
})
