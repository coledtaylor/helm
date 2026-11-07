import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveryResult, SessionActivityState, SessionRecord } from '@helm/core'
import { DEFAULT_SETTINGS, EMPTY_INVENTORY } from '@helm/core/types'
import { bridge, remoteBridge } from './bridge.testkit'
import { useHostWorkspaces } from './useHostWorkspaces'

vi.mock('./bridge', () => import('./bridge.testkit'))

const BOX = 'h1'
const API = '/home/you/work/infra/repos/api'

const SCANNED: DiscoveryResult = {
  roots: ['/home/you/work'],
  harnesses: [],
  projects: [
    { path: API, name: 'api', kind: 'repo', harnessPath: null, hasClaudeDir: false, inventory: EMPTY_INVENTORY, git: null }
  ],
  errors: [],
  scannedAt: '2026-11-03T00:00:00.000Z',
  durationMs: 1
}

const deploy = { id: 3, name: 'deploy', label: null, cwd: API, status: 'running' } as SessionRecord

beforeEach(() => {
  bridge.reset()
  bridge.whenUnanswered('pending')
  const box = remoteBridge(BOX)
  box.reset()
  box.answer('settings:read', () => ({ ...DEFAULT_SETTINGS, pinnedProjects: [] }))
  box.answer('discovery:cached', () => [])
  box.answer('discovery:scan', () => SCANNED)
  box.answer('session:list', () => [deploy])
  box.answer('session:activity', () => [])
  box.answer('settings:write', (patch) => ({ ...DEFAULT_SETTINGS, ...patch }))
})

describe('useHostWorkspaces', () => {
  it('reads build-box’s folders, pins and sessions through its own bridge once connected, and keeps them while it is not', async () => {
    const box = remoteBridge(BOX)
    const { result, rerender } = renderHook(({ connected }) => useHostWorkspaces([BOX], connected), {
      initialProps: { connected: [] as string[] }
    })
    expect(box.invocations).toEqual([])

    rerender({ connected: [BOX] })
    await waitFor(() => expect(result.current.byHost.get(BOX)?.discovery).toEqual(SCANNED))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy]))
    expect(result.current.byHost.get(BOX)?.listed).toBe(true)

    // Dropped: what was read stays, for the sidebar to list dimmed.
    rerender({ connected: [] })
    expect(result.current.byHost.get(BOX)?.discovery).toEqual(SCANNED)
    expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy])

    // Back: read afresh.
    box.clearRecords()
    rerender({ connected: [BOX] })
    await waitFor(() => expect(box.invoked('discovery:scan')).toHaveLength(1))
    expect(box.invoked('session:list')).toHaveLength(1)

    // A session that ends there is heard on its bridge.
    act(() => box.emit('session:exit', { ...deploy, status: 'exited' }))
    expect(result.current.byHost.get(BOX)?.sessions[0]?.status).toBe('exited')

    // Nothing was asked of this PC's host.
    expect(bridge.invocations).toEqual([])
  })

  it('adds a command child of build-box that exited before the window heard of it, as an ended session', async () => {
    const box = remoteBridge(BOX)
    const { result } = renderHook(() => useHostWorkspaces([BOX], [BOX]))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy]))

    const lint = { id: 4, name: 'lint', label: null, cwd: API, status: 'exited', exitCode: 0, parentId: 3, command: 'pnpm lint' } as SessionRecord
    act(() => box.emit('session:exit', lint))
    expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy, lint])

    // An agent session nothing listed is not added.
    act(() => box.emit('session:exit', { ...deploy, id: 9, status: 'exited' }))
    expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy, lint])
  })

  it('lists build-box’s sessions again when its activity names one the window does not know, however its pushes arrive together', async () => {
    const box = remoteBridge(BOX)
    const { result } = renderHook(() => useHostWorkspaces([BOX], [BOX]))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy]))
    const state = (id: number): SessionActivityState => ({
      id,
      activity: 'busy',
      waitingFor: null,
      message: null,
      claudeSessionId: null
    })
    const child = { ...deploy, id: 4, name: 'reviewer' } as SessionRecord
    box.answer('session:list', () => [deploy, child])
    box.clearRecords()

    // Pushes that land in one batch: the second names a session started by
    // the first's parent, which the window has not listed.
    act(() => {
      box.emit('session:activity', [state(3)])
      box.emit('session:activity', [state(3), state(4)])
    })

    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy, child]))
    expect(box.invoked('session:list')).toHaveLength(1)
  })

  it('takes a child’s report from build-box’s listing when its activity moves, and drops it when the host clears it', async () => {
    const box = remoteBridge(BOX)
    const child = { ...deploy, id: 4, name: 'scout', parentId: 3, parentName: 'deploy' } as SessionRecord
    box.answer('session:list', () => [deploy, child])
    const { result } = renderHook(() => useHostWorkspaces([BOX], [BOX]))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions).toEqual([deploy, child]))
    const parent = result.current.byHost.get(BOX)?.sessions[0]

    const lastReport = { state: 'done', text: 'Both bugs are fixed.', at: '2026-11-06T10:00:00.000Z' }
    box.answer('session:list', () => [deploy, { ...child, lastReport }])
    act(() => box.emit('session:activity', []))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions[1]).toMatchObject({ id: 4, lastReport }))
    expect(result.current.byHost.get(BOX)?.sessions[0]).toBe(parent)

    box.answer('session:list', () => [deploy, child])
    act(() => box.emit('session:activity', []))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.sessions[1]).not.toHaveProperty('lastReport'))
  })

  it('writes a pin on build-box through its bridge only', async () => {
    const box = remoteBridge(BOX)
    const { result } = renderHook(() => useHostWorkspaces([BOX], [BOX]))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.discovery).toEqual(SCANNED))

    act(() => result.current.togglePin(BOX, API))
    expect(result.current.byHost.get(BOX)?.pinnedProjects).toEqual([API])
    await waitFor(() => expect(box.invoked('settings:write')).toEqual([{ pinnedProjects: [API] }]))
    expect(bridge.invocations).toEqual([])
  })

  it('says why build-box’s folders could not be read', async () => {
    remoteBridge(BOX).answer('discovery:scan', () => {
      throw new Error('Its scan roots could not be read.')
    })
    const { result } = renderHook(() => useHostWorkspaces([BOX], [BOX]))
    await waitFor(() => expect(result.current.byHost.get(BOX)?.scanError).toBe('Its scan roots could not be read.'))
    expect(result.current.byHost.get(BOX)?.discovery).toBeNull()
  })
})
