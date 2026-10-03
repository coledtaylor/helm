import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile, ProfileDraft, SessionRecord } from '@helm/core'
import type { LaunchedProfile } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useProfiles } from './useProfiles'

vi.mock('./bridge', () => import('./bridge.testkit'))
// The grid a launch is sized to; measuring a pane is the terminal's business.
vi.mock('./terminals', () => ({ estimateGrid: () => ({ cols: 132, rows: 41 }) }))

const HUB = 'C:\\work\\hub'
const TOOLS = 'C:\\work\\hub\\repos\\tools'

const DRAFT: ProfileDraft = {
  name: 'hub dev',
  root: HUB,
  overlays: [TOOLS],
  access: [TOOLS],
  model: 'sonnet',
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: '/recap',
  pinnedOrder: null
}
const stamp = { createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z' }
const DEV: Profile = { ...DRAFT, id: 1, ...stamp }
const OTHER: Profile = { ...DRAFT, id: 2, name: 'other', overlays: [], access: [], ...stamp }

const SESSION: SessionRecord = {
  id: 10,
  name: 'hub dev',
  label: null,
  cwd: HUB,
  branch: null,
  projectPath: null,
  profileId: DEV.id,
  argv: [],
  claudeSessionId: null,
  status: 'running',
  startedAt: '2026-10-02T00:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null
}

describe('useProfiles', () => {
  beforeEach(() => {
    bridge.reset()
    bridge.answer('profile:list', () => [OTHER])
  })

  it('lists what main has, and takes the whole list main sends after a save', async () => {
    // Main's half: a save is written, then the list goes out to every window.
    bridge.answer('profile:save', ({ draft }) => {
      queueMicrotask(() => bridge.emit('profiles:changed', [DEV, OTHER]))
      return { profile: { ...draft, id: DEV.id, ...stamp }, problems: [] }
    })
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles).toEqual([OTHER]))

    let saved: { profile: Profile | null; problems: string[] } | undefined
    await act(async () => {
      saved = await result.current.save(DRAFT)
    })

    expect(saved).toEqual({ profile: { ...DRAFT, id: DEV.id, ...stamp }, problems: [] })
    expect(bridge.invoked('profile:save')).toEqual([{ draft: DRAFT }])
    await waitFor(() => expect(result.current.profiles).toEqual([DEV, OTHER]))
  })

  it('hands the form main’s problems when a save is refused, and lists nothing new', async () => {
    bridge.answer('profile:save', () => ({ profile: null, problems: ['A profile named “other” already exists.'] }))
    const { result } = renderHook(() => useProfiles())
    await waitFor(() => expect(result.current.profiles).toEqual([OTHER]))

    let saved: { profile: Profile | null; problems: string[] } | undefined
    await act(async () => {
      saved = await result.current.save({ ...DRAFT, name: 'other' }, null)
    })
    expect(saved).toEqual({ profile: null, problems: ['A profile named “other” already exists.'] })
    expect(result.current.profiles).toEqual([OTHER])
  })

  it('launches a profile by id at the pane’s grid, and says what it composed', async () => {
    let finish: (launched: LaunchedProfile) => void = () => undefined
    bridge.answer('profile:launch', () => new Promise<LaunchedProfile>((resolve) => (finish = resolve)))
    const { result } = renderHook(() => useProfiles())

    let launched: Promise<SessionRecord | null> = Promise.resolve(null)
    act(() => {
      launched = result.current.launch(DEV, null)
    })
    await waitFor(() => expect(result.current.launching).toEqual([DEV.id]))
    expect(bridge.invoked('profile:launch')).toEqual([{ profileId: DEV.id, cols: 132, rows: 41 }])

    await act(async () => {
      finish({ session: SESSION, profile: DEV, overlays: ['tools'], composedInstructions: true, warnings: [] })
      expect(await launched).toEqual(SESSION)
    })
    expect(result.current.launching).toEqual([])
    expect(result.current.notice).toBe('Composed tools: with their CLAUDE.md instructions')
    expect(result.current.error).toBeNull()
  })

  it('keeps a failed launch as an error rather than a notice', async () => {
    bridge.answer('profile:launch', () => {
      throw new Error("Error invoking remote method 'profile:launch': That profile no longer exists.")
    })
    const { result } = renderHook(() => useProfiles())

    let launched: SessionRecord | null | undefined
    await act(async () => {
      launched = await result.current.launch(DEV, null)
    })
    expect(launched).toBeNull()
    expect(result.current.error).toBe('That profile no longer exists.')
    expect(result.current.notice).toBeNull()
    expect(result.current.launching).toEqual([])
  })
})
