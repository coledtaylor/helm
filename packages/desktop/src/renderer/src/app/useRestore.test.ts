import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RestoreOffer, SessionRecord } from '@helm/core'
import type { LaunchedSession, RestoreSessionsResult } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { restoreReport, useRestore } from './useRestore'

vi.mock('./bridge', () => import('./bridge.testkit'))

const OFFER: RestoreOffer = {
  sessions: [
    {
      id: 4,
      name: 'tab baseline',
      cwd: 'C:\\work\\helm',
      branch: 'main',
      profile: null,
      profileGone: false,
      lastAt: 1,
      blocked: null
    }
  ],
  elsewhere: 0,
  layout: null
}

const launched = (id: number, warnings: string[] = []): LaunchedSession => ({
  session: { id, name: `s${String(id)}` } as SessionRecord,
  overlays: [],
  composedInstructions: false,
  warnings
})

beforeEach(() => {
  bridge.reset()
  bridge.answer('session:restorable', () => OFFER)
})

describe('useRestore', () => {
  it('reads the offer once, reopens what it is asked to, and is then answered', async () => {
    const result: RestoreSessionsResult = { restored: [{ from: 4, launched: launched(11) }], failed: [] }
    bridge.answer('session:restore', () => result)
    const { result: hook } = renderHook(() => useRestore())
    await waitFor(() => expect(hook.current.offer).toEqual(OFFER))

    let answer: RestoreSessionsResult | null = null
    await act(async () => {
      answer = await hook.current.restore([{ id: 4, cols: 100, rows: 30 }])
    })
    expect(answer).toEqual(result)
    expect(bridge.invoked('session:restore')).toEqual([{ sessions: [{ id: 4, cols: 100, rows: 30 }] }])
    expect(bridge.invoked('session:restorable')).toHaveLength(1)
    expect(hook.current.offer).toBeNull()
    expect(hook.current.busy).toBe(false)
    // Asked, and everything came back as it was: nothing to say.
    expect(hook.current.report).toBeNull()
  })

  it('answers not now with nothing', async () => {
    bridge.answer('session:restore', () => ({ restored: [], failed: [] }))
    const { result: hook } = renderHook(() => useRestore())
    await waitFor(() => expect(hook.current.offer).not.toBeNull())
    act(() => hook.current.dismiss())
    expect(hook.current.offer).toBeNull()
    await waitFor(() => expect(bridge.invoked('session:restore')).toEqual([{ sessions: [] }]))
  })

  it('says why main refused, without the channel Electron puts on it', async () => {
    bridge.answer('session:restore', () => {
      throw new Error(
        "Error invoking remote method 'session:restore': Error: The sessions from before Helm closed have already been answered for."
      )
    })
    const { result: hook } = renderHook(() => useRestore())
    await waitFor(() => expect(hook.current.offer).not.toBeNull())
    await act(async () => {
      expect(await hook.current.restore([{ id: 4, cols: 80, rows: 24 }])).toBeNull()
    })
    expect(hook.current.report).toEqual({
      text: 'The sessions from before Helm closed have already been answered for.',
      failed: true
    })
    expect(hook.current.offer).toBeNull()
    act(() => hook.current.dismissReport())
    expect(hook.current.report).toBeNull()
  })
})

describe('restoreReport', () => {
  it('leads with what did not come back, then what came back short, then that anything happened unasked', () => {
    expect(
      restoreReport(
        {
          restored: [{ from: 1, launched: launched(5) }],
          failed: [{ id: 2, name: 'quiet', reason: 'Claude Code has removed its transcript.' }]
        },
        true
      )
    ).toEqual({
      text: 'Reopened 1 session. “quiet” could not be reopened: Claude Code has removed its transcript.',
      failed: true
    })
    expect(
      restoreReport({ restored: [{ from: 1, launched: launched(5, ['Overlay skipped.']) }], failed: [] }, false)
    ).toEqual({ text: 'Overlay skipped.', failed: false })
    expect(
      restoreReport(
        { restored: [{ from: 1, launched: launched(5) }, { from: 2, launched: launched(6) }], failed: [] },
        true
      )
    ).toEqual({ text: 'Reopened 2 sessions Helm was running when it closed.', failed: false })
    expect(restoreReport({ restored: [], failed: [] }, true)).toBeNull()
  })
})
