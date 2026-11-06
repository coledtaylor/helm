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
  it('S9: asks the host that runs the child to end it unforced, so the window asks first, keeping the session where it was ended', async () => {
    const closed = vi.fn(() => ({ closed: true }) as never)
    bridge.answer('session:close', closed)

    await expect(stopChild(LOCAL_HOST_KEY, 7)).resolves.toBe(true)

    expect(bridge.invoked('session:close')).toEqual([{ id: 7, keep: true }])
    expect(closed).toHaveBeenCalledOnce()
  })

  it('settles false when the user declines the question, and ends nothing', async () => {
    bridge.answer('session:close', () => ({ closed: false }) as never)

    await expect(stopChild(LOCAL_HOST_KEY, 7)).resolves.toBe(false)
  })

  it('goes to the host the child runs on, and to no other', async () => {
    remoteBridge('h1').answer('session:close', () => ({ closed: true }) as never)

    await stopChild('h1', 3)

    expect(remoteBridge('h1').invoked('session:close')).toEqual([{ id: 3, keep: true }])
    expect(bridge.invoked('session:close')).toEqual([])
  })

  it('leaves the card running, without an unhandled rejection, when the host cannot be reached', async () => {
    bridge.answer('session:close', () => Promise.reject(new Error('the connection to the host is gone')) as never)

    await expect(stopChild(LOCAL_HOST_KEY, 7)).resolves.toBe(false)
  })
})
