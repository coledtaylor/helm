import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { bridge, remoteBridge } from './bridge.testkit'
import { stopChild } from './familyActions'

vi.mock('./bridge', () => import('./bridge.testkit'))

beforeEach(() => {
  bridge.reset()
  remoteBridge('h1').reset()
})

describe('Stop on a child’s card', () => {
  it('S9: asks the host that runs the child to end it by force, keeping the session where it was ended, with no question', () => {
    const closed = vi.fn(() => ({ closed: true }) as never)
    bridge.answer('session:close', closed)

    stopChild(LOCAL_HOST_KEY, 7)

    expect(bridge.invoked('session:close')).toEqual([{ id: 7, force: true, keep: true }])
    expect(closed).toHaveBeenCalledOnce()
  })

  it('goes to the host the child runs on, and to no other', () => {
    remoteBridge('h1').answer('session:close', () => ({ closed: true }) as never)

    stopChild('h1', 3)

    expect(remoteBridge('h1').invoked('session:close')).toEqual([{ id: 3, force: true, keep: true }])
    expect(bridge.invoked('session:close')).toEqual([])
  })

  it('leaves the card running, without an unhandled rejection, when the host cannot be reached', async () => {
    let refuse: (reason: Error) => void = () => undefined
    bridge.answer(
      'session:close',
      () =>
        new Promise<never>((_resolve, reject) => {
          refuse = reject
        })
    )

    stopChild(LOCAL_HOST_KEY, 7)
    refuse(new Error('the connection to the host is gone'))

    // The rejection is taken by Stop's own handler: a later one would fail the run as unhandled.
    await expect(Promise.resolve().then(() => bridge.invoked('session:close'))).resolves.toHaveLength(1)
  })
})
