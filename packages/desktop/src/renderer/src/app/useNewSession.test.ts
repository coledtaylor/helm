import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryPage, HistoryProject, HistorySession, SessionRecord } from '@helm/core'
import type { LaunchedSession } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useNewSession } from './useNewSession'

vi.mock('./bridge', () => import('./bridge.testkit'))

const ALPHA = 'C:\\work\\Alpha'

function folder(project: string, lastAt: number): HistoryProject {
  return { project, name: project, sessions: 1, prompts: 1, lastAt, resumable: 1, exists: true }
}

const conversation = { sessionId: 'c1', project: ALPHA, title: 'fix the export' } as HistorySession
const session = { id: 7, name: 'Alpha', cwd: ALPHA } as SessionRecord

beforeEach(() => {
  bridge.reset()
  bridge.answer('history:projects', () => [folder(ALPHA, 500), folder('C:\\work\\beta', 300)])
  bridge.answer('history:sessions', (): HistoryPage => ({ sessions: [conversation], total: 1, tookMs: 1 }))
})

describe('useNewSession', () => {
  it('opens on a folder and reads when each folder was last used, keyed by lower-cased path', async () => {
    const { result } = renderHook(() => useNewSession())
    expect(result.current.open).toBe(false)

    act(() => result.current.show(ALPHA))
    expect(result.current.open).toBe(true)
    expect(result.current.initialPath).toBe(ALPHA)
    await waitFor(() =>
      expect([...result.current.recency]).toEqual([
        ['c:\\work\\alpha', 500],
        ['c:\\work\\beta', 300]
      ])
    )
  })

  it('reads a folder’s conversations once per opening, and again after the next one', async () => {
    const { result } = renderHook(() => useNewSession())
    act(() => result.current.show(null))
    act(() => {
      result.current.loadResumable([ALPHA])
      result.current.loadResumable([ALPHA.toUpperCase()])
    })
    await waitFor(() => expect(result.current.resumable.get('c:\\work\\alpha')).toEqual([conversation]))
    expect(bridge.invoked('history:sessions')).toEqual([{ project: ALPHA, resumableOnly: true, limit: 3 }])

    act(() => result.current.hide())
    act(() => result.current.show(null))
    expect(result.current.resumable.size).toBe(0)
    act(() => result.current.loadResumable([ALPHA]))
    await waitFor(() => expect(bridge.invoked('history:sessions')).toHaveLength(2))
  })

  it('launches at the pane’s grid, and says what could not be composed', async () => {
    const launched: LaunchedSession = {
      session,
      overlays: [],
      composedInstructions: false,
      warnings: ['Overlay skipped - C:\\gone is not there any more.']
    }
    bridge.answer('session:launch', () => launched)
    const { result } = renderHook(() => useNewSession())

    let answer: LaunchedSession | null = null
    await act(async () => {
      answer = await result.current.launch(
        { cwd: ALPHA, projectPath: ALPHA, profileId: 3, permissionMode: 'plan', resume: null },
        null
      )
    })
    expect(answer).toEqual(launched)
    expect(bridge.invoked('session:launch')).toEqual([
      expect.objectContaining({ cwd: ALPHA, profileId: 3, permissionMode: 'plan', resume: null, cols: expect.any(Number) })
    ])
    expect(result.current.warning).toBe('Overlay skipped - C:\\gone is not there any more.')
    expect(result.current.busy).toBe(false)
  })

  it('hands back the sentence main refused with, without the channel Electron puts on it', async () => {
    bridge.answer('session:launch', () => {
      throw new Error("Error invoking remote method 'session:launch': Error: That profile no longer exists.")
    })
    const { result } = renderHook(() => useNewSession())
    let answer: LaunchedSession | null = session as never
    await act(async () => {
      answer = await result.current.launch(
        { cwd: ALPHA, profileId: 9, permissionMode: null, resume: null },
        null
      )
    })
    expect(answer).toBeNull()
    expect(result.current.error).toBe('That profile no longer exists.')
    act(() => result.current.dismissError())
    expect(result.current.error).toBeNull()
  })
})
