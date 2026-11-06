import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SessionActivityState, SessionRecord } from '@helm/core/types'
import { EMPTY_INVENTORY } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { disposeTerminal } from './terminals'
import { useSessions } from './useSessions'

vi.mock('./bridge', () => import('./bridge.testkit'))
vi.mock('./terminals', () => ({
  disposeTerminal: vi.fn(),
  estimateGrid: () => ({ cols: 120, rows: 40 })
}))

function record(id: number, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    name: `session ${String(id)}`,
    label: null,
    cwd: `C:\\work\\${String(id)}`,
    branch: 'main',
    projectPath: null,
    profileId: null,
    argv: [],
    claudeSessionId: null,
    status: 'running',
    startedAt: '2026-10-02T10:00:00.000Z',
    endedAt: null,
    durationMs: null,
    exitCode: null,
    ...over
  }
}

/** Main's answers: what it is hosting, and what each one is doing. */
let hosting: SessionRecord[] = []
let activity: SessionActivityState[] = []

beforeEach(() => {
  hosting = []
  activity = []
  vi.mocked(disposeTerminal).mockClear()
  bridge.reset()
  bridge.answer('session:list', () => hosting)
  bridge.answer('session:activity', () => activity)
})

async function mounted() {
  const hook = renderHook(() => useSessions(vi.fn()))
  await waitFor(() => expect(bridge.invoked('session:activity')).not.toHaveLength(0))
  return hook
}

describe('useSessions', () => {
  it('adopts the sessions main is still hosting after a reload, with what each is doing', async () => {
    hosting = [record(1), record(2)]
    activity = [{ id: 2, activity: 'busy', waitingFor: null, message: null, claudeSessionId: 'c' }]
    const { result } = await mounted()
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual([1, 2]))
    expect(result.current.activity.get(2)?.activity).toBe('busy')

    // Every push carries the whole set, so a session that stopped being reported loses its dot.
    act(() => bridge.emit('session:activity', [{ id: 1, activity: 'waiting', waitingFor: 'dialog open', message: null, claudeSessionId: 'c' }]))
    expect([...result.current.activity.keys()]).toEqual([1])
  })

  it('lists a session an agent started once the host’s activity names it, takes no ended one, and asks again for none it holds', async () => {
    hosting = [record(1)]
    const { result } = await mounted()
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual([1]))

    const state = (id: number): SessionActivityState => ({
      id,
      activity: 'idle',
      waitingFor: null,
      message: null,
      claudeSessionId: null
    })
    hosting = [record(1), record(2, { parentId: 1, parentName: 'session 1' }), record(3, { status: 'exited', exitCode: 0 })]
    act(() => bridge.emit('session:activity', [state(1), state(2), state(3)]))
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual([1, 2]))
    expect(result.current.sessions[1]).toMatchObject({ parentId: 1 })

    // Everything it names is held now: another push lists nothing.
    const listed = bridge.invoked('session:list').length
    act(() => bridge.emit('session:activity', [state(1), state(2)]))
    expect(bridge.invoked('session:list')).toHaveLength(listed)
  })

  it('S15: lists the sessions of the host that replaced one that refused the window, once it is connected, and only until listed', async () => {
    bridge.answer('session:list', () => {
      throw new Error('This client speaks Floti protocol 2.0 and the host speaks 1.4.')
    })
    const { result, rerender } = renderHook(({ reconnects }) => useSessions(vi.fn(), reconnects), {
      initialProps: { reconnects: 0 }
    })
    await waitFor(() => expect(bridge.invoked('session:list')).toHaveLength(1))
    expect(result.current.listed).toBe(false)

    // The carried floti's host took the keeper back: 7 and 9 still run.
    hosting = [record(7), record(9)]
    bridge.answer('session:list', () => hosting)
    rerender({ reconnects: 1 })
    await waitFor(() => expect(result.current.sessions.map((s) => s.id)).toEqual([7, 9]))
    expect(result.current.listed).toBe(true)

    // Listed: a later reconnect keeps what the window holds and its pushes.
    rerender({ reconnects: 2 })
    expect(bridge.invoked('session:list')).toHaveLength(2)
  })

  it('keeps an ended session’s tab where it was, with the row main sent', async () => {
    hosting = [record(1), record(2), record(3)]
    const { result } = await mounted()
    await waitFor(() => expect(result.current.sessions).toHaveLength(3))

    act(() => bridge.emit('session:exit', record(2, { status: 'exited', exitCode: 0, durationMs: 5_000 })))
    expect(result.current.sessions.map((s) => [s.id, s.status])).toEqual([
      [1, 'running'],
      [2, 'exited'],
      [3, 'running']
    ])
    expect(disposeTerminal).not.toHaveBeenCalled()
  })

  it('keeps the tab when main says the close was declined, and drops it with its terminal when it was not', async () => {
    hosting = [record(1)]
    const { result } = await mounted()
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    bridge.answer('session:close', () => ({ closed: false }))
    let closed: boolean | undefined
    await act(async () => {
      closed = await result.current.close(1)
    })
    expect(closed).toBe(false)
    expect(bridge.invoked('session:close')).toContainEqual({ id: 1 })
    expect(result.current.sessions.map((s) => s.id)).toEqual([1])
    expect(disposeTerminal).not.toHaveBeenCalled()

    bridge.answer('session:close', () => ({ closed: true }))
    await act(async () => {
      closed = await result.current.close(1)
    })
    expect(closed).toBe(true)
    expect(result.current.sessions).toEqual([])
    expect(disposeTerminal).toHaveBeenCalledWith(1)
  })

  it('paints the row main answers a rename with, not the label it sent', async () => {
    hosting = [record(1)]
    const { result } = await mounted()
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    bridge.answer('session:rename', () => record(1, { label: 'review' }))
    await act(() => result.current.rename(1, '  review  '))
    expect(bridge.invoked('session:rename')).toContainEqual({ id: 1, label: '  review  ' })
    expect(result.current.sessions[0]).toMatchObject({ name: 'session 1', label: 'review' })

    bridge.answer('session:rename', () => record(1, { label: null }))
    await act(() => result.current.rename(1, null))
    expect(result.current.sessions[0]?.label).toBeNull()
  })

  it('opens a tab for a launch at the pane’s grid, and says why one failed in main’s words', async () => {
    const { result } = await mounted()
    const project: Project = {
      path: 'C:\\work\\shop',
      name: 'shop',
      kind: 'repo',
      harnessPath: null,
      hasClaudeDir: false,
      inventory: EMPTY_INVENTORY,
      git: null
    }

    bridge.answer('session:start', () => record(7, { name: 'shop' }))
    let id: number | null = null
    await act(async () => {
      id = await result.current.launch(project, null)
    })
    expect(id).toBe(7)
    expect(bridge.invoked('session:start')).toContainEqual({
      cwd: 'C:\\work\\shop',
      projectPath: 'C:\\work\\shop',
      name: 'shop',
      cols: 120,
      rows: 40
    })
    expect(result.current.sessions.map((s) => s.id)).toEqual([7])

    bridge.answer('session:start', () => {
      throw new Error("Error invoking remote method 'session:start': Could not start a session in C:\\work\\shop: spawn failed")
    })
    await act(async () => {
      id = await result.current.launch(project, null)
    })
    expect(id).toBeNull()
    expect(result.current.launchError).toBe('Could not start a session in C:\\work\\shop: spawn failed')
    expect(result.current.sessions.map((s) => s.id)).toEqual([7])
  })

  it('adopts a session started elsewhere once, and tells main which sessions are on screen', async () => {
    const { result } = await mounted()
    act(() => result.current.adopt(record(4)))
    act(() => result.current.adopt(record(4)))
    expect(result.current.sessions.map((s) => s.id)).toEqual([4])

    result.current.reportFocus([4])
    expect(bridge.sent('session:focus')).toContainEqual({ ids: [4] })
  })
})
