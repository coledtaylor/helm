import {
  LOCAL_HOST_KEY,
  fromSaved,
  sessionRef,
  type ChildMember,
  type PaneLayout,
  type PlaceScope,
  type StandingNotice
} from '@helm/core/types'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { noticeKey, type NoticesView } from './host/notices'
import { useNeedsYou, type HostAttention, type NeedsYouAlert } from './needsYou'

const session = (id: number, parentId?: number): ChildMember => ({
  id,
  status: 'running',
  ...(parentId === undefined ? {} : { parentId, parentName: 'lead' })
})
const SESSIONS = [session(1), session(2, 1), session(3, 1)]

const waiting = (childId: number, since = '2026-11-06T10:00:00Z'): StandingNotice => ({
  id: `needs-you-${childId}`,
  kind: 'needs-you',
  parentId: 1,
  parentName: 'lead',
  childId,
  childName: `worker-${childId}`,
  text: 'permission prompt',
  since,
  limit: null,
  allowMore: null
})

const hostWith = (notices: StandingNotice[], atConnect: StandingNotice[] = []): HostAttention<ChildMember>[] => [
  {
    host: LOCAL_HOST_KEY,
    sessions: SESSIONS,
    notices: { notices, away: [], atConnect: new Set(atConnect.map(noticeKey)) } satisfies NoticesView
  }
]

/** The parent's tab is not open here, so every child has nowhere on screen. */
const elsewhere: PaneLayout = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
const scope: PlaceScope = { enabled: true, roomOf: () => true, capacityOf: () => 2 }

function mount(initial: HostAttention<ChildMember>[], front: { value: boolean }) {
  const told: NeedsYouAlert[] = []
  const view = renderHook(
    ({ hosts }) =>
      useNeedsYou({ hosts, layout: elsewhere, scope, inFront: () => front.value, notify: (alert) => told.push(alert) }),
    { initialProps: { hosts: initial } }
  )
  return { ...view, told }
}

describe('the window’s needs-you state', () => {
  it('S12: tells main once of a child that begins to need a person while the window is not in front', () => {
    const front = { value: false }
    const { rerender, told } = mount(hostWith([]), front)
    rerender({ hosts: hostWith([waiting(2)]) })
    expect(told.map((alert) => [alert.host, alert.id, alert.title])).toEqual([[LOCAL_HOST_KEY, 2, 'worker-2 needs you']])
    rerender({ hosts: hostWith([waiting(2)]) })
    expect(told).toHaveLength(1)
  })

  it('S12: tells main of the same child again when it has stopped waiting and waits again', () => {
    const front = { value: false }
    const { rerender, told } = mount(hostWith([]), front)
    rerender({ hosts: hostWith([waiting(2)]) })
    rerender({ hosts: hostWith([]) })
    rerender({ hosts: hostWith([waiting(2, '2026-11-06T11:00:00Z')]) })
    expect(told).toHaveLength(2)
  })

  it('tells main nothing of a child that began to need a person while the window was in front, when it is left', () => {
    const front = { value: true }
    const { rerender, told } = mount(hostWith([]), front)
    rerender({ hosts: hostWith([waiting(2)]) })
    front.value = false
    rerender({ hosts: hostWith([waiting(2), waiting(3)]) })
    expect(told.map((alert) => alert.id)).toEqual([3])
  })

  it('tells main nothing of what stood when the connection opened', () => {
    const front = { value: false }
    const standing = waiting(2)
    const { told } = mount(hostWith([standing], [standing]), front)
    expect(told).toEqual([])
  })

  it('S10, S11: closes a toast in this window only, for as long as that notice stands', () => {
    const front = { value: true }
    const { result, rerender } = mount(hostWith([waiting(2)]), front)
    expect(result.current.toasts.map((toast) => toast.childId)).toEqual([2])
    act(() => result.current.closeToast(result.current.toasts[0]!.key))
    expect(result.current.toasts).toEqual([])
    rerender({ hosts: hostWith([waiting(2), waiting(3)]) })
    expect(result.current.toasts.map((toast) => toast.childId)).toEqual([3])
    // It stops waiting: the toast goes by itself, and waiting again is a new toast.
    rerender({ hosts: hostWith([]) })
    expect(result.current.toasts).toEqual([])
    rerender({ hosts: hostWith([waiting(2, '2026-11-06T11:00:00Z')]) })
    expect(result.current.toasts.map((toast) => toast.childId)).toEqual([2])
  })
})
