import { describe, expect, it } from 'vitest'
import { FakeConnection, reconnectingReach } from '../../../../../test/fake-connection'
import { createHostState } from './hostState'

describe('whether the window has its host', () => {
  it('says the host is lost, and whether Helm starts another, until the window is connected again', async () => {
    const first = new FakeConnection()
    const link = reconnectingReach(first)
    const state = createHostState(link)
    let changes = 0
    state.subscribe(() => (changes += 1))
    await link.connection()
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 0 })

    link.lose({ planned: false, restarts: true })
    expect(state.get()).toEqual({ lost: { restarts: true }, restarting: false, reconnects: 0 })

    await link.reconnect(new FakeConnection())
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 1 })
    expect(changes).toBe(2)
  })

  it('says nothing when the host was stopped on purpose', async () => {
    const link = reconnectingReach(new FakeConnection())
    const state = createHostState(link)
    await link.connection()

    link.lose({ planned: true, restarts: false })
    await link.reconnect(new FakeConnection())

    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 0 })
  })

  it('S12: a restart for an update marks nothing lost, and the new host is asked for what it offers back', async () => {
    const link = reconnectingReach(new FakeConnection())
    const state = createHostState(link)
    await link.connection()

    link.lose({ planned: true, restarts: true, restarting: true })
    expect(state.get()).toEqual({ lost: null, restarting: true, reconnects: 0 })

    await link.reconnect(new FakeConnection())
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 1 })
  })
})
