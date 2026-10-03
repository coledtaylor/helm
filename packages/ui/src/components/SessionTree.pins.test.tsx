import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps } from './SessionTree'

const project = (path: string, harnessPath: string | null, kind: Project['kind'] = 'repo'): Project => ({
  path,
  name: path.split('\\').pop() ?? path,
  kind,
  harnessPath,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

/** Two harnesses, a repo in each that will be pinned, and one that stays put. */
const DISCOVERY: DiscoveryResult = {
  roots: ['C:\\work'],
  harnesses: [
    { path: 'C:\\work\\north', name: 'north', template: null, version: null, repoPaths: ['C:\\work\\north\\repos\\zeta', 'C:\\work\\north\\repos\\stay'] },
    { path: 'C:\\work\\south', name: 'south', template: null, version: null, repoPaths: ['C:\\work\\south\\repos\\alpha'] }
  ],
  projects: [
    project('C:\\work\\north\\repos\\zeta', 'C:\\work\\north'),
    project('C:\\work\\north\\repos\\stay', 'C:\\work\\north'),
    project('C:\\work\\south\\repos\\alpha', 'C:\\work\\south')
  ],
  errors: [],
  scannedAt: '2026-10-02T00:00:00.000Z',
  durationMs: 1
}

const GONE = 'E:\\unplugged\\tools'

function renderTree(overrides: Partial<SessionTreeProps> = {}) {
  const props: SessionTreeProps = {
    discovery: DISCOVERY,
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
    onAddRoot: vi.fn(),
    ...overrides
  }
  const view = render(<SessionTree {...props} />)
  return { props, rerender: (next: Partial<SessionTreeProps>) => view.rerender(<SessionTree {...props} {...next} />) }
}

const pinned = (): HTMLElement => screen.getByRole('region', { name: 'Pinned' })
/** Project rows are the buttons titled with their path. */
const rowsIn = (container: HTMLElement): string[] =>
  within(container)
    .queryAllByRole('button')
    .map((button) => button.getAttribute('title'))
    .filter((title): title is string => title !== null)

describe('SessionTree pins', () => {
  it('has no Pinned section while nothing is pinned, and pins from a row’s star', async () => {
    const { props } = renderTree({ pinnedPaths: [] })
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Pin zeta' }))
    expect(props.onTogglePin).toHaveBeenCalledWith('C:\\work\\north\\repos\\zeta')
  })

  it('lifts pins from different harnesses into one flat section, by name, each drawn once', () => {
    renderTree({ pinnedPaths: ['C:\\work\\north\\repos\\zeta', 'c:\\WORK\\south\\repos\\alpha'] })

    expect(rowsIn(pinned())).toEqual(['C:\\work\\south\\repos\\alpha', 'C:\\work\\north\\repos\\zeta'])
    const nav = screen.getByRole('navigation', { name: 'Projects and sessions' })
    expect(rowsIn(nav).filter((path) => path.endsWith('\\zeta'))).toHaveLength(1)
    expect(rowsIn(nav).filter((path) => path.endsWith('\\alpha'))).toHaveLength(1)
    expect(rowsIn(nav)).toContain('C:\\work\\north\\repos\\stay')
    // South had only the pinned repo, so it has no group left to draw.
    expect(screen.queryByRole('button', { name: /^south, / })).toBeNull()
    expect(screen.getByRole('button', { name: 'Unpin zeta' })).toBeTruthy()
  })

  it('keeps a pin whose folder is gone, says so, and offers only the unpin', async () => {
    const { props } = renderTree({ pinnedPaths: [GONE] })

    expect(within(pinned()).getByText('tools')).toBeTruthy()
    expect(within(pinned()).getByText('folder gone')).toBeTruthy()
    expect(within(pinned()).queryByRole('button', { name: /^Start a session/ })).toBeNull()
    expect(rowsIn(pinned())).toEqual([])

    await userEvent.click(within(pinned()).getByRole('button', { name: 'Unpin tools' }))
    expect(props.onTogglePin).toHaveBeenCalledWith(GONE)
  })

  it('keeps every pin across a rescan, the unresolvable one included', () => {
    const pins = ['C:\\work\\north\\repos\\zeta', GONE]
    const { rerender } = renderTree({ pinnedPaths: pins })
    expect(within(pinned()).getByText('folder gone')).toBeTruthy()

    rerender({ discovery: { ...DISCOVERY, scannedAt: '2026-10-02T00:05:00.000Z', projects: [...DISCOVERY.projects] } })
    expect(rowsIn(pinned())).toEqual(['C:\\work\\north\\repos\\zeta'])
    expect(within(pinned()).getByText('folder gone')).toBeTruthy()
  })

  it('filters the Pinned section too, and clearing the filter brings every pin back', async () => {
    const user = userEvent.setup()
    renderTree({ pinnedPaths: ['C:\\work\\north\\repos\\zeta', 'C:\\work\\south\\repos\\alpha', GONE] })
    const filter = screen.getByRole('textbox', { name: 'Filter projects and sessions' })

    await user.type(filter, 'zet')
    expect(rowsIn(pinned())).toEqual(['C:\\work\\north\\repos\\zeta'])
    expect(within(pinned()).queryByText('folder gone')).toBeNull()

    await user.clear(filter)
    expect(rowsIn(pinned())).toEqual(['C:\\work\\south\\repos\\alpha', 'C:\\work\\north\\repos\\zeta'])
    expect(within(pinned()).getByText('folder gone')).toBeTruthy()
  })
})
