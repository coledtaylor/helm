import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type AgentWorktree, type AgentWorktreeRemoval, type Project } from '@helm/core/types'
import { ProjectPane } from './ProjectPane'

const repo: Project = {
  path: 'C:\\Work\\My Repos\\ledger',
  name: 'ledger',
  kind: 'repo',
  harnessPath: null,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
}

const worktree = (name: string, overrides: Partial<AgentWorktree> = {}): AgentWorktree => ({
  name,
  folder: `${repo.path}\\.floti\\worktrees\\${name}`,
  branch: `agent/${name}`,
  child: { name, parent: 'lead', running: false },
  uncommitted: false,
  ...overrides
})

function renderPane(
  agentWorktrees: readonly AgentWorktree[] | undefined,
  onRemoveAgentWorktree?: (worktree: AgentWorktree) => Promise<AgentWorktreeRemoval>
): void {
  render(
    <ProjectPane
      project={repo}
      onLaunch={vi.fn()}
      agentWorktrees={agentWorktrees}
      onRemoveAgentWorktree={onRemoveAgentWorktree}
    />
  )
}

const section = (): HTMLElement => document.querySelector('[data-project-panel="agent-worktrees"]') as HTMLElement
const row = (name: string): HTMLElement => document.querySelector(`[data-agent-worktree="${name}"]`) as HTMLElement

describe('ProjectPane - Agent worktrees', () => {
  it('lists each worktree by name and branch with the child that worked there and its state', () => {
    renderPane([
      worktree('ledger-store', { child: { name: 'ledger-store', parent: 'lead', running: true } }),
      worktree('docs', { child: { name: 'writer', parent: null, running: false } }),
      worktree('hand-made', { child: null, branch: null })
    ])

    expect(screen.getByRole('heading', { name: 'Agent worktrees' })).toBeTruthy()
    expect(within(section()).getAllByRole('listitem')).toHaveLength(3)

    const store = row('ledger-store')
    expect(store.querySelector('[data-agent-worktree-name]')?.textContent).toBe('ledger-store')
    expect(store.querySelector('[data-agent-worktree-branch]')?.textContent).toBe('agent/ledger-store')
    expect(store.querySelector('[data-agent-worktree-child]')?.textContent).toBe('ledger-store is running')

    expect(row('docs').querySelector('[data-agent-worktree-child]')?.textContent).toBe('writer ended')

    expect(row('hand-made').querySelector('[data-agent-worktree-child]')?.textContent).toBe('No session worked here')
    expect(row('hand-made').querySelector('[data-agent-worktree-branch]')?.textContent).toBe('detached')
  })

  it('marks the worktrees with uncommitted changes, and says so when git could not be asked', () => {
    renderPane([
      worktree('clean', { uncommitted: false }),
      worktree('dirty', { uncommitted: true }),
      worktree('unknown', { uncommitted: null })
    ])

    expect(row('clean').querySelector('[data-agent-worktree-uncommitted]')).toBeNull()
    expect(row('clean').querySelector('[data-agent-worktree-unchecked]')).toBeNull()
    expect(row('dirty').querySelector('[data-agent-worktree-uncommitted]')?.textContent).toBe('Uncommitted changes')
    // Unknown is not clean: it is neither marked as changed nor left unmarked.
    expect(row('unknown').querySelector('[data-agent-worktree-uncommitted]')).toBeNull()
    expect(row('unknown').querySelector('[data-agent-worktree-unchecked]')?.textContent).toBe('Changes not checked')
  })

  it('shows no such section for a project with none, or where the list is not given', () => {
    renderPane([])
    expect(screen.queryByRole('heading', { name: 'Agent worktrees' })).toBeNull()
    expect(section()).toBeNull()
    cleanup()

    renderPane(undefined)
    expect(screen.queryByRole('heading', { name: 'Agent worktrees' })).toBeNull()
  })

  it('asks the host to remove the worktree whose Remove was pressed, and asks nothing first', async () => {
    const onRemove = vi.fn(async (): Promise<AgentWorktreeRemoval> => ({ removed: true, refusal: null }))
    const clean = worktree('ledger-store')
    renderPane([clean, worktree('docs')], onRemove)

    await userEvent.click(screen.getByRole('button', { name: 'Remove the ledger-store worktree' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledWith(clean)
    // No refusal is shown for a removal that went through.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove the ledger-store worktree' })).toHaveProperty('disabled', false))
    expect(document.querySelector('[data-agent-worktree-refusal]')).toBeNull()
  })

  it('shows the host’s refusal on that row and keeps the row', async () => {
    const sentence = 'ledger-store has uncommitted changes, so it stays.'
    const onRemove = vi.fn(async (): Promise<AgentWorktreeRemoval> => ({ removed: false, refusal: sentence }))
    renderPane([worktree('ledger-store', { uncommitted: true }), worktree('docs')], onRemove)

    await userEvent.click(screen.getByRole('button', { name: 'Remove the ledger-store worktree' }))

    const refusal = await within(row('ledger-store')).findByRole('alert')
    expect(refusal.textContent).toBe(sentence)
    expect(row('ledger-store')).toBeTruthy()
    // The other row says nothing, and the button is pressable again.
    expect(within(row('docs')).queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove the ledger-store worktree' })).toHaveProperty('disabled', false)
  })

  it('shows why when the host cannot be asked, and clears the sentence on the next press', async () => {
    const onRemove = vi
      .fn<(worktree: AgentWorktree) => Promise<AgentWorktreeRemoval>>()
      .mockRejectedValueOnce(new Error('The host is not reachable.'))
      .mockResolvedValueOnce({ removed: false, refusal: 'A session is running there.' })
    renderPane([worktree('ledger-store')], onRemove)
    const press = (): Promise<void> =>
      userEvent.click(screen.getByRole('button', { name: 'Remove the ledger-store worktree' }))

    await press()
    expect((await within(row('ledger-store')).findByRole('alert')).textContent).toBe('The host is not reachable.')

    await press()
    await waitFor(() =>
      expect(within(row('ledger-store')).getByRole('alert').textContent).toBe('A session is running there.')
    )
  })

  it('offers no Remove where nothing can remove', () => {
    renderPane([worktree('ledger-store')])
    expect(screen.queryByRole('button', { name: /^Remove the/ })).toBeNull()
    expect(row('ledger-store')).toBeTruthy()
  })
})
