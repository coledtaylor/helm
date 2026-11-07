import {
  LOCAL_HOST_KEY,
  fromSaved,
  sessionRef,
  type ChildMember,
  type PaneLayout,
  type PlaceScope
} from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../test/fake-connection'
import type * as P from '../../../shared/host/protocol'
import { createNoticesAdapter, type NoticesAdapter } from './host/notices'
import { needsYouToasts } from './needsYou'
import { createHostNotices } from './useNotices'

/**
 * The window's whole path from the host's answer to what it draws: the adapter
 * over the connection, the store that joins the hosts, and the rules for the
 * toasts. A window that connects to a host holding notices lists them under
 * While you were away every time it connects, and toasts only what began after.
 */

const UNREACHABLE = 'No local host answered on its socket.'

const child = (id: number): ChildMember => ({ id, status: 'running', parentId: 1, parentName: 'lead' })
const FAMILY: ChildMember[] = [{ id: 1, status: 'running' }, child(2), child(3), child(4)]

const standing = (childId: number, since: string): P.StandingNotice => ({
  id: `needs-you-${String(childId)}`,
  kind: 'needs-you',
  parentId: 1,
  parentName: 'lead',
  childId,
  childName: `worker-${String(childId)}`,
  text: 'permission prompt',
  since
})

const BEFORE = [standing(2, '2026-11-07T10:00:00Z'), standing(3, '2026-11-07T10:01:00Z')]
const AFTER = standing(4, '2026-11-07T10:30:00Z')

/** The parent's tab is on another device's screen: every child shown here has nowhere, so each would toast. */
const elsewhere = (): PaneLayout => fromSaved({ root: { panes: [sessionRef(9)], activeId: null }, focused: 0 })
const scope: PlaceScope = { enabled: true, roomOf: () => true, capacityOf: () => 2 }

/** One window's view of this PC's host, through its own adapter. */
function window(adapter: NoticesAdapter) {
  const source = createHostNotices({
    each: (listener) => {
      listener(LOCAL_HOST_KEY, adapter.store)
      return () => undefined
    },
    dismiss: async () => undefined,
    allowMore: async () => ({ added: 0 })
  })
  const stop = source.subscribe(() => undefined)
  return {
    away: () => (source.get().get(LOCAL_HOST_KEY)?.away ?? []).map((notice) => notice.id),
    toasts: () => {
      const notices = source.get().get(LOCAL_HOST_KEY)
      if (notices === undefined) return []
      return needsYouToasts([{ host: LOCAL_HOST_KEY, notices, sessions: FAMILY }], elsewhere(), scope, new Set()).map(
        (toast) => toast.childId
      )
    },
    stop
  }
}

describe('a window that connects to a host holding notices', () => {
  it('S15: lists them under While you were away and toasts none of them, and toasts one that begins after', async () => {
    const connection = new FakeConnection()
    const link = fakeReach(connection, UNREACHABLE)
    const there = window(createNoticesAdapter(link))
    await link.connect()

    connection.snapshot('notices:changed', BEFORE)
    expect(there.away()).toEqual(['needs-you-2', 'needs-you-3'])
    expect(there.toasts()).toEqual([])

    connection.push('notices:changed', [...BEFORE, AFTER])
    expect(there.away()).toEqual(['needs-you-2', 'needs-you-3'])
    expect(there.toasts()).toEqual([4])
    there.stop()
  })

  it('S15: lists them again in a page that opens afterwards, each page with its own adapter', async () => {
    for (const opened of [1, 2, 3]) {
      const connection = new FakeConnection()
      const link = fakeReach(connection, UNREACHABLE)
      const there = window(createNoticesAdapter(link))
      await link.connect()
      connection.snapshot('notices:changed', [...BEFORE, AFTER])
      expect({ opened, away: there.away(), toasts: there.toasts() }).toEqual({
        opened,
        away: ['needs-you-2', 'needs-you-3', 'needs-you-4'],
        toasts: []
      })
      there.stop()
    }
  })

  it('S15: lists them again each time its connection to the host opens again, whatever the host had before', async () => {
    const first = new FakeConnection()
    const link = reconnectingReach(first)
    const there = window(createNoticesAdapter(link))
    await link.connection()
    first.snapshot('notices:changed', [])
    first.push('notices:changed', BEFORE)
    expect(there.toasts()).toEqual([2, 3])

    // The host went and came back holding the same notices, begun again.
    const second = new FakeConnection()
    await link.reconnect(second)
    second.snapshot('notices:changed', [standing(2, '2026-11-07T10:40:00Z'), standing(3, '2026-11-07T10:40:00Z')])
    expect(there.away()).toEqual(['needs-you-2', 'needs-you-3'])
    expect(there.toasts()).toEqual([])

    // Nothing the first connection says reaches the window any more.
    first.push('notices:changed', [])
    expect(there.away()).toEqual(['needs-you-2', 'needs-you-3'])
    there.stop()
  })
})
