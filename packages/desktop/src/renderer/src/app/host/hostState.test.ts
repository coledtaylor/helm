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

  it('S15: the first connect after a host refused the window counts as getting a host back, so the carried host’s sessions and offer are asked for', () => {
    const connected: Array<() => void> = []
    const refusals: Array<() => void> = []
    const state = createHostState({
      onEnded: () => undefined,
      onConnected: (listener) => connected.push(() => listener(undefined as never)),
      onRefused: (listener) =>
        refusals.push(() => listener({ host: { major: 1, minor: 4 }, client: { major: 2, minor: 0 }, update: 'host' }))
    })
    const connect = (): void => connected.forEach((listener) => listener())
    const refuse = (): void => refusals.forEach((listener) => listener())

    // A first connect with no refusal before it is the window's ordinary start.
    connect()
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 0 })

    // The protocol-1.x host refused it, twice; then the carried floti's host welcomed it.
    refuse()
    refuse()
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 0 })
    connect()
    expect(state.get()).toEqual({ lost: null, restarting: false, reconnects: 1 })
    connect()
    expect(state.get().reconnects).toBe(1)
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
