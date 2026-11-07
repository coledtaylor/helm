import {
  LOCAL_HOST_KEY,
  fromSaved,
  openTab,
  paneId,
  sessionRef,
  shrinkFamilyChild,
  type ChildMember,
  type PaneLayout,
  type PlaceScope,
  type StandingNotice
} from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { noticeKey, type NoticesView } from './host/notices'
import { needsYouAlerts, needsYouKeys, needsYouToasts, pruneClosed, type HostAttention } from './needsYou'

const session = (id: number, parentId?: number, status = 'running'): ChildMember => ({
  id,
  status,
  ...(parentId === undefined ? {} : { parentId, parentName: 'lead' })
})

/** The parent, 1, running four children, 2 to 5. */
const FAMILY = [session(1), session(2, 1), session(3, 1), session(4, 1), session(5, 1)]

const waiting = (childId: number, over: Partial<StandingNotice> = {}): StandingNotice => ({
  id: `needs-you-${childId}`,
  kind: 'needs-you',
  parentId: 1,
  parentName: 'lead',
  childId,
  childName: `worker-${childId}`,
  text: 'permission prompt',
  since: '2026-11-06T10:00:00Z',
  limit: null,
  allowMore: null,
  ...over
})

const view = (notices: StandingNotice[], atConnect: StandingNotice[] = []): NoticesView => ({
  notices,
  away: notices.filter((notice) => atConnect.some((each) => noticeKey(each) === noticeKey(notice))),
  atConnect: new Set(atConnect.map(noticeKey))
})

const hostOf = (notices: StandingNotice[], atConnect: StandingNotice[] = [], sessions = FAMILY): HostAttention<ChildMember> => ({
  host: LOCAL_HOST_KEY,
  notices: view(notices, atConnect),
  sessions
})

/** The parent's tab alone in the window. */
const parentOnly = (): PaneLayout => fromSaved({ root: { panes: [sessionRef(1)], activeId: null }, focused: 0 })
const scope = (over: Partial<PlaceScope> = {}): PlaceScope => ({
  enabled: true,
  roomOf: () => true,
  capacityOf: () => 2,
  ...over
})

describe('the toasts for children that need a person', () => {
  it('S9: gives a child shown as a card its warn edge and no toast', () => {
    expect(needsYouToasts([hostOf([waiting(2)])], parentOnly(), scope(), new Set())).toEqual([])
  })

  it('S9: gives a child with a tab of its own no toast', () => {
    const layout = openTab(parentOnly(), sessionRef(4))
    expect(needsYouToasts([hostOf([waiting(4)])], layout, scope(), new Set())).toEqual([])
  })

  it('S10: names a child shown as a header, what it waits on and who started it, and offers Show', () => {
    expect(needsYouToasts([hostOf([waiting(4, { text: 'question' })])], parentOnly(), scope(), new Set())).toEqual([
      {
        key: `${LOCAL_HOST_KEY}\nneeds-you-4\n2026-11-06T10:00:00Z`,
        host: LOCAL_HOST_KEY,
        childId: 4,
        childName: 'worker-4',
        waitsOn: 'question',
        startedBy: 'lead',
        action: 'show'
      }
    ])
  })

  it('S10: offers Show for a header the user shrank, whatever room the pane has', () => {
    const shrunk = shrinkFamilyChild(parentOnly(), paneId(sessionRef(1)), FAMILY[1]!)
    const [toast] = needsYouToasts([hostOf([waiting(2)])], shrunk, scope({ capacityOf: () => 4 }), new Set())
    expect(toast).toMatchObject({ childId: 2, action: 'show' })
  })

  it('S11: offers Peek for a child with nowhere on screen, whose parent’s tab is not open here', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const [toast] = needsYouToasts([hostOf([waiting(3)])], elsewhere, scope(), new Set())
    expect(toast).toMatchObject({ childId: 3, childName: 'worker-3', startedBy: 'lead', action: 'peek' })
  })

  it('S11: offers Peek for a child that is a chip in a pane with no room, and for every child with the setting off', () => {
    expect(needsYouToasts([hostOf([waiting(3)])], parentOnly(), scope({ roomOf: () => false }), new Set())).toEqual([
      expect.objectContaining({ childId: 3, action: 'peek' })
    ])
    expect(needsYouToasts([hostOf([waiting(2)])], parentOnly(), scope({ enabled: false }), new Set())).toEqual([
      expect.objectContaining({ childId: 2, action: 'peek' })
    ])
  })

  it('is one for each needs-you notice, and none for a limit or an error notice, an ended child or a child not listed', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const family = [...FAMILY.slice(0, 3), session(4, 1, 'exited'), session(5, 1)]
    const notices = [
      waiting(2),
      waiting(3, { id: 'notice-7', kind: 'limit', text: 'lead has made 16 starts' }),
      waiting(4),
      waiting(7),
      waiting(5)
    ]
    const toasts = needsYouToasts([hostOf(notices, [], family)], elsewhere, scope(), new Set())
    expect(toasts.map((toast) => toast.childId)).toEqual([2, 5])
  })

  it('is none for a command child, which has no conversation to wait in, whatever a notice says', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const family = [...FAMILY.slice(0, 2), { ...session(3, 1), command: 'pnpm test' }]
    const sessions = [waiting(2), waiting(3)]
    expect(needsYouToasts([hostOf(sessions, [], family)], elsewhere, scope(), new Set()).map((toast) => toast.childId)).toEqual([2])
  })

  it('is closed for this window by its close button, and a child that waits again is a new toast', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const first = waiting(2)
    const [toast] = needsYouToasts([hostOf([first])], elsewhere, scope(), new Set())
    const closed = new Set([toast!.key])
    expect(needsYouToasts([hostOf([first])], elsewhere, scope(), closed)).toEqual([])
    const again = waiting(2, { since: '2026-11-06T11:00:00Z' })
    expect(needsYouToasts([hostOf([again])], elsewhere, scope(), closed)).toHaveLength(1)
  })

  it('is gone when the child stops waiting, and what was closed is forgotten with it', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const notice = waiting(2)
    const [toast] = needsYouToasts([hostOf([notice])], elsewhere, scope(), new Set())
    expect(needsYouToasts([hostOf([])], elsewhere, scope(), new Set())).toEqual([])
    const closed = new Set([toast!.key, 'devbox\nneeds-you-9\nold'])
    expect(pruneClosed(closed, [hostOf([notice])])).toEqual(new Set([toast!.key]))
    expect(pruneClosed(closed, [hostOf([])])).toEqual(new Set())
    const same = new Set([toast!.key])
    expect(pruneClosed(same, [hostOf([notice])])).toBe(same)
  })

  it('keeps the same notice number on two hosts apart', () => {
    const elsewhere = fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
    const there: HostAttention<ChildMember> = { ...hostOf([waiting(2)]), host: 'devbox' }
    const toasts = needsYouToasts([hostOf([waiting(2)]), there], elsewhere, scope(), new Set())
    expect(toasts.map((toast) => toast.host)).toEqual([LOCAL_HOST_KEY, 'devbox'])
    expect(new Set(toasts.map((toast) => toast.key)).size).toBe(2)
  })
})

describe('the OS notification for a child that begins to need a person', () => {
  it('S12: names the child, what it waits on and who started it, for the child to show on its host', () => {
    expect(needsYouAlerts([hostOf([waiting(3)])], new Set(), false)).toEqual([
      {
        key: `${LOCAL_HOST_KEY}\nneeds-you-3\n2026-11-06T10:00:00Z`,
        host: LOCAL_HOST_KEY,
        id: 3,
        title: 'worker-3 needs you',
        body: 'permission prompt, started by lead'
      }
    ])
  })

  it('S12: shows nothing while the window is in front', () => {
    expect(needsYouAlerts([hostOf([waiting(3)])], new Set(), true)).toEqual([])
  })

  it('does not tell again of what it already told, and tells of the same child waiting again', () => {
    const first = waiting(3)
    const [alert] = needsYouAlerts([hostOf([first])], new Set(), false)
    expect(needsYouAlerts([hostOf([first])], new Set([alert!.key]), false)).toEqual([])
    const again = waiting(3, { since: '2026-11-06T12:00:00Z' })
    expect(needsYouAlerts([hostOf([again])], new Set([alert!.key]), false)).toHaveLength(1)
  })

  it('leaves what stood when the connection opened to While you were away', () => {
    const before = waiting(3)
    const after = waiting(2, { since: '2026-11-06T10:30:00Z' })
    const alerts = needsYouAlerts([hostOf([before, after], [before])], new Set(), false)
    expect(alerts.map((alert) => alert.id)).toEqual([2])
  })

  it('tells nothing of a limit notice or an error notice', () => {
    const limit = waiting(3, { id: 'notice-1', kind: 'limit' })
    expect(needsYouAlerts([hostOf([limit])], new Set(), false)).toEqual([])
    expect(needsYouKeys([hostOf([limit, waiting(2)])])).toEqual([`${LOCAL_HOST_KEY}\nneeds-you-2\n2026-11-06T10:00:00Z`])
  })
})
