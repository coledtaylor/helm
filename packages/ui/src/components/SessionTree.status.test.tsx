import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps, type TreeSession } from './SessionTree'

/**
 * What a session's row in the tree says about it, from its backend's records
 * or its program's own OSC 7501 reports, and which state a folded project
 * shows for its sessions.
 */

const ZETA = 'C:\\work\\north\\repos\\zeta'

const project = (path: string): Project => ({
  path,
  name: path.split('\\').pop() ?? path,
  kind: 'repo',
  harnessPath: 'C:\\work\\north',
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

const DISCOVERY: DiscoveryResult = {
  roots: ['C:\\work'],
  harnesses: [{ path: 'C:\\work\\north', name: 'north', template: null, version: null, repoPaths: [ZETA] }],
  projects: [project(ZETA)],
  errors: [],
  scannedAt: '2026-10-03T00:00:00.000Z',
  durationMs: 1
}

const session = (id: number, state: TreeSession['state'], note: string): TreeSession => ({
  id: `session:${String(id)}`,
  label: `tab ${String(id)}`,
  state,
  note,
  hint: ZETA,
  outside: false,
  shown: null
})

function renderTree(sessions: TreeSession[]): void {
  const props: SessionTreeProps = {
    discovery: DISCOVERY,
    scanning: false,
    selectedPath: null,
    pinnedPaths: [],
    onTogglePin: vi.fn(),
    sessionsByPath: new Map([[ZETA.toLowerCase(), sessions]]),
    elsewhere: [],
    onSelect: vi.fn(),
    onLaunch: vi.fn(),
    launchingPath: null,
    onOpenSession: vi.fn(),
    onAddRoot: vi.fn(),
    reveal: null
  }
  render(<SessionTree {...props} />)
}

const summary = (): string | null =>
  document.querySelector('[data-project-summary]')?.getAttribute('data-project-summary') ?? null

describe('SessionTree: what a session reports', () => {
  it('names a plain tab that reports an error as such, in the danger tone', () => {
    renderTree([session(1, 'error', 'error')])
    const row = screen.getByRole('button', { name: 'tab 1, reports an error' })
    expect(row.textContent).toContain('error')
    expect([...(row.querySelector('[aria-hidden]')?.classList ?? [])]).toContain('bg-danger')
  })

  it('folds a project to its most urgent state: waiting, then a reported error, then working', async () => {
    renderTree([session(1, 'busy', '4m'), session(2, 'error', 'error'), session(3, 'failed', 'failed')])
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions in zeta' }))
    expect(summary()).toBe('error')
  })

  it('puts a session waiting on you ahead of one reporting an error', async () => {
    renderTree([session(1, 'error', 'error'), session(2, 'waiting', 'needs you')])
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions in zeta' }))
    expect(summary()).toBe('waiting')
  })
})
