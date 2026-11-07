import type { StandingNotice } from '@helm/core/types'
import { describe, expect, it } from 'vitest'
import type { NoticesStore, NoticesView } from './host/notices'
import { createHostNotices } from './useNotices'

const limit: StandingNotice = {
  id: 'notice-1',
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

/** A host's notices store as `host/notices.ts` keeps it, driven by the test. */
function fakeStore(initial: readonly StandingNotice[] = []) {
  let view: NoticesView = { notices: initial, away: initial, atConnect: new Set() }
  const watchers = new Set<() => void>()
  let closedAway = 0
  const store: NoticesStore = {
    get: () => view,
    subscribe: (listener) => {
      watchers.add(listener)
      return () => watchers.delete(listener)
    },
    closeAway: () => {
      closedAway++
    }
  }
  return {
    store,
    set(next: NoticesView) {
      view = next
      for (const watcher of [...watchers]) watcher()
    },
    watchers,
    closedAway: () => closedAway
  }
}

function world() {
  const stores = new Map<string, ReturnType<typeof fakeStore>>()
  const calls: string[] = []
  const eachCalls = { count: 0, stops: 0 }
  const source = createHostNotices({
    each: (listener) => {
      eachCalls.count++
      for (const [host, each] of stores) listener(host, each.store)
      return () => {
        eachCalls.stops++
      }
    },
    dismiss: async (host, id) => {
      calls.push(`dismiss ${host} ${id}`)
    },
    allowMore: async (host, parentId) => {
      calls.push(`allowMore ${host} ${parentId}`)
      return { added: 16 }
    }
  })
  return { source, stores, calls, eachCalls }
}

describe('the notices standing on every host the window reaches', () => {
  it('S15: gives a view for each host from its store, and follows each change', () => {
    const { source, stores } = world()
    stores.set('this-pc', fakeStore([limit]))
    stores.set('devbox', fakeStore())
    const seen: number[] = []
    const stop = source.subscribe(() => seen.push(source.get().size))
    expect([...source.get().keys()]).toEqual(['this-pc', 'devbox'])
    expect(source.get().get('this-pc')?.notices).toEqual([limit])

    const before = source.get()
    stores.get('devbox')!.set({ notices: [limit], away: [], atConnect: new Set() })
    expect(source.get()).not.toBe(before)
    expect(source.get().get('devbox')?.notices).toEqual([limit])
    expect(source.get().get('this-pc')?.notices).toEqual([limit])
    stop()
  })

  it('stops following the hosts when nothing listens, and starts again for the next listener', () => {
    const { source, stores, eachCalls } = world()
    const fake = fakeStore([limit])
    stores.set('this-pc', fake)
    const stop = source.subscribe(() => undefined)
    expect(fake.watchers.size).toBe(1)
    stop()
    expect(fake.watchers.size).toBe(0)
    expect(eachCalls.stops).toBe(1)
    source.subscribe(() => undefined)
    expect(eachCalls.count).toBe(2)
  })

  it('S16: dismisses a notice on its host, and allows a parent more starts there, answering how many it added', async () => {
    const { source, calls } = world()
    await source.dismiss('devbox', 'notice-1')
    await expect(source.allowMore('devbox', 12)).resolves.toBe(16)
    expect(calls).toEqual(['dismiss devbox notice-1', 'allowMore devbox 12'])
  })

  it('S15: closes While you were away on the host named, and no other', () => {
    const { source, stores } = world()
    const pc = fakeStore([limit])
    const devbox = fakeStore([limit])
    stores.set('this-pc', pc)
    stores.set('devbox', devbox)
    source.subscribe(() => undefined)
    source.closeAway('devbox')
    expect([pc.closedAway(), devbox.closedAway()]).toEqual([0, 1])
  })
})
