import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentWorktree, SessionRecord } from '@helm/core'
import { bridge } from './bridge.testkit'
import { sessionActivityIn, useAgentWorktrees } from './useAgentWorktrees'

vi.mock('./bridge', () => import('./bridge.testkit'))

const REPO = 'C:\\Work\\My Repos\\ledger'

const worktree = (name: string, overrides: Partial<AgentWorktree> = {}): AgentWorktree => ({
  name,
  folder: `${REPO}\\.floti\\worktrees\\${name}`,
  branch: `agent/${name}`,
  child: { name, parent: 'lead', running: false },
  uncommitted: false,
  ...overrides
})

afterEach(() => {
  bridge.reset()
})

describe('useAgentWorktrees', () => {
  it('reads the project’s agent worktrees when the page opens', async () => {
    bridge.answer('worktrees:list', () => [worktree('ledger-store')])

    const { result } = renderHook(() => useAgentWorktrees(REPO, ''))

    expect(result.current.worktrees).toEqual([])
    await waitFor(() => expect(result.current.worktrees.map((w) => w.name)).toEqual(['ledger-store']))
    expect(bridge.invoked('worktrees:list')).toEqual([{ project: REPO }])
  })

  it('reads again when a session in the project starts or ends, and not when nothing changed', async () => {
    let listed = [worktree('ledger-store', { child: { name: 'ledger-store', parent: 'lead', running: true } })]
    bridge.answer('worktrees:list', () => listed)

    const { result, rerender } = renderHook(({ activity }) => useAgentWorktrees(REPO, activity), {
      initialProps: { activity: '1:running' }
    })
    await waitFor(() => expect(result.current.worktrees[0]?.child?.running).toBe(true))

    rerender({ activity: '1:running' })
    expect(bridge.invoked('worktrees:list')).toHaveLength(1)

    listed = [worktree('ledger-store')]
    rerender({ activity: '1:exited' })
    await waitFor(() => expect(result.current.worktrees[0]?.child?.running).toBe(false))
    expect(bridge.invoked('worktrees:list')).toHaveLength(2)
  })

  it('removes through the host, reads the list again, and returns the host’s answer', async () => {
    let listed = [worktree('ledger-store'), worktree('docs')]
    bridge.answer('worktrees:list', () => listed)
    bridge.answer('worktrees:remove', ({ folder }) => {
      listed = listed.filter((w) => w.folder !== folder)
      return { removed: true, refusal: null }
    })
    const { result } = renderHook(() => useAgentWorktrees(REPO, ''))
    await waitFor(() => expect(result.current.worktrees).toHaveLength(2))

    let removal: Awaited<ReturnType<typeof result.current.remove>> | undefined
    await act(async () => {
      removal = await result.current.remove(worktree('ledger-store'))
    })

    expect(removal).toEqual({ removed: true, refusal: null })
    expect(bridge.invoked('worktrees:remove')).toEqual([{ project: REPO, folder: worktree('ledger-store').folder }])
    expect(result.current.worktrees.map((w) => w.name)).toEqual(['docs'])
  })

  it('keeps a worktree the host refuses to remove listed, with the host’s sentence', async () => {
    const dirty = worktree('ledger-store', { uncommitted: true })
    bridge.answer('worktrees:list', () => [dirty])
    bridge.answer('worktrees:remove', () => ({
      removed: false,
      refusal: 'ledger-store has uncommitted changes.'
    }))
    const { result } = renderHook(() => useAgentWorktrees(REPO, ''))
    await waitFor(() => expect(result.current.worktrees).toHaveLength(1))

    let removal: Awaited<ReturnType<typeof result.current.remove>> | undefined
    await act(async () => {
      removal = await result.current.remove(dirty)
    })

    expect(removal).toEqual({ removed: false, refusal: 'ledger-store has uncommitted changes.' })
    expect(result.current.worktrees).toEqual([dirty])
  })

  it('says why when the host cannot be asked to remove, and keeps the list it had when it cannot be read', async () => {
    const one = worktree('ledger-store')
    let readable = true
    bridge.answer('worktrees:list', () => {
      if (!readable) throw new Error('The host is not reachable.')
      return [one]
    })
    bridge.answer('worktrees:remove', () => {
      throw new Error("Error invoking remote method 'worktrees:remove': Error: The host is not reachable.")
    })
    const { result, rerender } = renderHook(({ activity }) => useAgentWorktrees(REPO, activity), {
      initialProps: { activity: 'a' }
    })
    await waitFor(() => expect(result.current.worktrees).toEqual([one]))

    let removal: Awaited<ReturnType<typeof result.current.remove>> | undefined
    await act(async () => {
      removal = await result.current.remove(one)
    })
    expect(removal).toEqual({ removed: false, refusal: 'The host is not reachable.' })

    readable = false
    rerender({ activity: 'b' })
    await waitFor(() => expect(bridge.invoked('worktrees:list')).toHaveLength(2))
    expect(result.current.worktrees).toEqual([one])
  })

  it('a slow read for a project the page has left does not paint on the next', async () => {
    const OTHER = 'C:\\Work\\My Repos\\api'
    const resolvers = new Map<string, (list: AgentWorktree[]) => void>()
    bridge.answer(
      'worktrees:list',
      ({ project }) => new Promise<AgentWorktree[]>((resolve) => resolvers.set(project, resolve))
    )
    const { result, rerender } = renderHook(({ project }) => useAgentWorktrees(project, ''), {
      initialProps: { project: REPO }
    })
    await waitFor(() => expect(resolvers.has(REPO)).toBe(true))
    rerender({ project: OTHER })
    await waitFor(() => expect(resolvers.has(OTHER)).toBe(true))

    await act(async () => {
      resolvers.get(OTHER)?.([worktree('api-work')])
      resolvers.get(REPO)?.([worktree('ledger-store')])
    })

    expect(result.current.worktrees.map((w) => w.name)).toEqual(['api-work'])
  })
})

describe('sessionActivityIn', () => {
  const session = (id: number, cwd: string, status: SessionRecord['status']): SessionRecord =>
    ({ id, cwd, status }) as SessionRecord

  it('is the id and state of each session in the project or below it, and nothing of any other folder', () => {
    const sessions = [
      session(1, REPO, 'running'),
      session(2, `${REPO}\\.floti\\worktrees\\ledger-store`, 'exited'),
      session(3, `${REPO}-old`, 'running'),
      session(4, 'C:\\Work\\My Repos\\api', 'running')
    ]
    expect(sessionActivityIn(sessions, REPO)).toBe('1:running,2:exited')
  })

  it('reads a path however it is spelled', () => {
    const sessions = [session(7, 'c:/work/my repos/ledger/.floti/worktrees/x/', 'running')]
    expect(sessionActivityIn(sessions, `${REPO}\\`)).toBe('7:running')
  })

  it('changes when a session ends, which is what makes the list be read again', () => {
    const running = [session(2, `${REPO}\\.floti\\worktrees\\ledger-store`, 'running')]
    const ended = [session(2, `${REPO}\\.floti\\worktrees\\ledger-store`, 'exited')]
    expect(sessionActivityIn(running, REPO)).not.toBe(sessionActivityIn(ended, REPO))
    expect(sessionActivityIn([], REPO)).toBe('')
  })
})
