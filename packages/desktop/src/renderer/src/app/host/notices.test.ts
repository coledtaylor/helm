import type { StandingNotice } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import type { RequestChannel, RequestPayload, RequestResult } from '../../../../shared/ipc'
import { createNoticesAdapter } from './notices'
import type { HostAdapter } from './router'

const UNREACHABLE = 'No local host answered on its socket.'

function ask<K extends RequestChannel>(adapter: HostAdapter, channel: K, payload: RequestPayload<K>): Promise<RequestResult<K>> {
  const route = adapter.requests?.[channel]
  if (route === undefined) throw new Error(`no route for ${channel}`)
  return route(payload)
}

const needsYou: P.StandingNotice = {
  id: 'n-1',
  kind: 'needs-you',
  parentId: 12,
  parentName: 'lead',
  childId: 13,
  childName: 'reviewer',
  text: 'a permission prompt',
  since: '2026-11-06T10:00:00Z'
}

const limit: P.StandingNotice = {
  id: 'n-2',
  kind: 'limit',
  parentId: 12,
  parentName: 'lead',
  text: 'lead has made 16 starts, the most it may.',
  since: '2026-11-06T10:05:00Z',
  limit: 'starts',
  allowMore: 16
}

describe('the notices standing on a host, over the window’s own connection', () => {
  it('hands the window the host’s list at connect and again at every change, with what a notice leaves out said as null', async () => {
    const connection = new FakeConnection()
    const link = fakeReach(connection, UNREACHABLE)
    const adapter = createNoticesAdapter(link)
    const lists: StandingNotice[][] = []
    adapter.events?.['notices:changed']?.((listed) => lists.push(listed))
    await link.connect()

    connection.snapshot('notices:changed', [needsYou])
    connection.push('notices:changed', [needsYou, limit])
    connection.push('notices:changed', [])

    expect(lists).toEqual([
      [
        {
          id: 'n-1',
          kind: 'needs-you',
          parentId: 12,
          parentName: 'lead',
          childId: 13,
          childName: 'reviewer',
          text: 'a permission prompt',
          since: '2026-11-06T10:00:00Z',
          limit: null,
          allowMore: null
        }
      ],
      [
        expect.objectContaining({ id: 'n-1' }),
        {
          id: 'n-2',
          kind: 'limit',
          parentId: 12,
          parentName: 'lead',
          childId: null,
          childName: null,
          text: 'lead has made 16 starts, the most it may.',
          since: '2026-11-06T10:05:00Z',
          limit: 'starts',
          allowMore: 16
        }
      ],
      []
    ])
  })

  it('gives a page that starts listening after the host answered the list that stands, and stops when it stops', async () => {
    const connection = new FakeConnection()
    const link = fakeReach(connection, UNREACHABLE)
    const adapter = createNoticesAdapter(link)
    await link.connect()
    connection.snapshot('notices:changed', [limit])

    const late: string[][] = []
    const stop = adapter.events?.['notices:changed']?.((listed) => late.push(listed.map((n) => n.id)))
    expect(late).toEqual([['n-2']])

    stop?.()
    connection.push('notices:changed', [needsYou, limit])
    expect(late).toEqual([['n-2']])
  })

  it('S15: knows which notices stood when the connection opened, lists those still standing as While you were away, and a notice that began later is not among them', async () => {
    const connection = new FakeConnection()
    const link = fakeReach(connection, UNREACHABLE)
    const adapter = createNoticesAdapter(link)
    await link.connect()
    expect(adapter.store.get().away).toEqual([])

    connection.snapshot('notices:changed', [needsYou, limit])
    expect(adapter.store.get().away.map((notice) => notice.id)).toEqual(['n-1', 'n-2'])

    const later: P.StandingNotice = { ...needsYou, id: 'n-3', childId: 14, since: '2026-11-06T10:30:00Z' }
    connection.push('notices:changed', [needsYou, limit, later])
    expect(adapter.store.get().notices.map((notice) => notice.id)).toEqual(['n-1', 'n-2', 'n-3'])
    expect(adapter.store.get().away.map((notice) => notice.id)).toEqual(['n-1', 'n-2'])

    // Updates as they resolve.
    connection.push('notices:changed', [limit, later])
    expect(adapter.store.get().away.map((notice) => notice.id)).toEqual(['n-2'])
    expect(adapter.store.get().atConnect.size).toBe(2)
  })

  it('S15: tells a watcher at every change, and closes the list in this window until the connection opens again', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const link = reconnectingReach(first)
    const adapter = createNoticesAdapter(link)
    await link.connection()
    let told = 0
    adapter.store.subscribe(() => told++)
    first.snapshot('notices:changed', [limit])
    expect(adapter.store.get().away).toHaveLength(1)
    const before = told

    adapter.store.closeAway()
    expect(adapter.store.get().away).toEqual([])
    expect(adapter.store.get().notices).toHaveLength(1)
    expect(told).toBe(before + 1)
    adapter.store.closeAway()
    expect(told).toBe(before + 1)

    await link.reconnect(second)
    second.snapshot('notices:changed', [limit])
    expect(adapter.store.get().away.map((notice) => notice.id)).toEqual(['n-2'])
  })

  it('dismisses a notice by its id and allows a parent more starts, each by asking the host', async () => {
    const connection = new FakeConnection()
      .answer('notices:dismiss', () => null)
      .answer('notices:allowMore', () => ({ added: 16 }))
    const adapter = createNoticesAdapter(fakeReach(connection, UNREACHABLE))

    await ask(adapter, 'notices:dismiss', { id: 'n-2' })
    await expect(ask(adapter, 'notices:allowMore', { parentId: 12 })).resolves.toEqual({ added: 16 })
    expect(connection.payloads('notices:dismiss')).toEqual([{ id: 'n-2' }])
    expect(connection.payloads('notices:allowMore')).toEqual([{ parentId: 12 }])
  })

  it('says the link’s sentence when the host cannot be reached, never that a notice was dismissed', async () => {
    const adapter = createNoticesAdapter(fakeReach(null, UNREACHABLE))

    await expect(ask(adapter, 'notices:dismiss', { id: 'n-2' })).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'notices:allowMore', { parentId: 12 })).rejects.toThrow(UNREACHABLE)
  })
})
