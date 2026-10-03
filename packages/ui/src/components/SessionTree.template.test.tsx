import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps } from './SessionTree'

const HUB = 'C:\\work\\hub'
const TOOLS = 'C:\\work\\hub\\repos\\tools'

const project = (path: string, name: string, kind: Project['kind']): Project => ({
  path,
  name,
  kind,
  harnessPath: HUB,
  hasClaudeDir: true,
  inventory: EMPTY_INVENTORY,
  git: null
})

const discovery = (template: string | null): DiscoveryResult => ({
  roots: ['C:\\work'],
  harnesses: [{ path: HUB, name: 'hub', template, version: null, repoPaths: [TOOLS] }],
  projects: [project(HUB, 'hub', 'harness'), project(TOOLS, 'tools', 'repo')],
  errors: [],
  scannedAt: '2026-10-02T00:00:00.000Z',
  durationMs: 0
})

function renderTree(result: DiscoveryResult): void {
  const props: SessionTreeProps = {
    discovery: result,
    scanning: false,
    selectedPath: null,
    pinnedPaths: [],
    onTogglePin: vi.fn(),
    sessionsByPath: new Map(),
    elsewhere: [],
    onSelect: vi.fn(),
    onLaunch: vi.fn(),
    launchingPath: null,
    onOpenSession: vi.fn(),
    onAddRoot: vi.fn()
  }
  render(<SessionTree {...props} />)
}

describe('SessionTree - harness provenance', () => {
  it('names the template on the harness’s own row', () => {
    renderTree(discovery('client'))
    expect(within(screen.getByRole('button', { name: 'hub, 2 projects' })).getByText('client')).toBeTruthy()
  })

  it('names none for a harness whose manifest records none', () => {
    renderTree(discovery(null))
    expect(screen.getByRole('button', { name: 'hub, 2 projects' }).textContent).toBe('hub2')
  })
})
