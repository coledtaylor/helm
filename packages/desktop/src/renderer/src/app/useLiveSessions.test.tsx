import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSession, SessionResources, SessionsOverview } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { useLiveSessions } from './useLiveSessions'

vi.mock('./bridge', () => import('./bridge.testkit'))

function live(pid: number, helmSessionId: number | null): LiveSession {
  return {
    helmSessionId,
    pid,
    registered: true,
    cwd: 'C:\\work\\shop',
    name: `session ${String(pid)}`,
    activity: 'idle',
    waitingFor: null,
    statusSinceMs: null,
    version: null,
    entrypoint: null,
    startedAtMs: null,
    claudeSessionId: null
  }
}

function held(id: number): SessionResources {
  return { id, rootPid: id * 100, processes: [], rootSeen: true, ports: [], opaque: 0, atMs: 1 }
}

describe('useLiveSessions', () => {
  it('adopts the machine’s sessions and their trees on mount, takes each push whole, and asks for the pass only while watched', async () => {
    const overview: SessionsOverview = { sessions: [live(4100, 1)], readAtMs: 5 }
    bridge.answer('sessions:overview', () => overview)
    bridge.answer('sessions:resources', () => [held(1)])

    const { result } = renderHook(() => useLiveSessions())
    // Before main has answered, nothing has been read - not "nothing is running".
    expect(result.current.readAtMs).toBeNull()

    await waitFor(() => expect(result.current.sessions).toEqual(overview.sessions))
    expect(result.current.readAtMs).toBe(5)
    await waitFor(() => expect([...result.current.resources.keys()]).toEqual([1]))

    act(() => bridge.emit('sessions:overview', { sessions: [live(4100, 1), live(5100, null)], readAtMs: 9 }))
    expect(result.current.sessions.map((s) => s.pid)).toEqual([4100, 5100])
    act(() => bridge.emit('sessions:resources', [held(2)]))
    expect([...result.current.resources.keys()]).toEqual([2])

    expect(bridge.sends).toEqual([])
    result.current.watch(true)
    result.current.watch(false)
    expect(bridge.sends).toEqual([
      { channel: 'sessions:watch', payload: { watching: true } },
      { channel: 'sessions:watch', payload: { watching: false } }
    ])
  })
})
