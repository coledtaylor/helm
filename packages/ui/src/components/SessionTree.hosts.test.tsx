import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps, type TreeHost, type TreeHostActions, type TreeSession } from './SessionTree'

const project = (path: string, harnessPath: string | null, kind: Project['kind'] = 'repo'): Project => ({
  path,
  name: path.split(/[\\/]/).pop() ?? path,
  kind,
  harnessPath,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

const discovery = (roots: string[], harness: string, repos: string[]): DiscoveryResult => ({
  roots,
  harnesses: [{ path: harness, name: harness.split(/[\\/]/).pop() ?? harness, template: null, version: null, repoPaths: repos }],
  projects: [project(harness, harness, 'harness'), ...repos.map((repo) => project(repo, harness))],
  errors: [],
  scannedAt: '2026-11-03T00:00:00.000Z',
  durationMs: 1
})

const THIS_PC = discovery(['C:\\work'], 'C:\\work\\my-work', ['C:\\work\\my-work\\repos\\notes'])
const BUILD_BOX = discovery(['/home/you/work'], '/home/you/work/infra', ['/home/you/work/infra/repos/api'])

const session = (id: string, label: string): TreeSession => ({
  id,
  label,
  state: 'idle',
  note: '',
  hint: '',
  outside: false,
  shown: null
})

const buildBox = (overrides: Partial<TreeHost> = {}): TreeHost => ({
  id: 'h1',
  name: 'build-box',
  connected: true,
  discovery: BUILD_BOX,
  scanning: false,
  pinnedPaths: [],
  sessionsByPath: new Map([['/home/you/work/infra/repos/api', [session('host:h1/session:3', 'deploy')]]]),
  elsewhere: [],
  selectedPath: null,
  launchingPath: null,
  ...overrides
})

const actions = (): TreeHostActions => ({
  onSelect: vi.fn(),
  onLaunch: vi.fn(),
  onOpenSession: vi.fn(),
  onTogglePin: vi.fn(),
  onNewSession: vi.fn(),
  onNewHarness: vi.fn(),
  onRescan: vi.fn(),
  onAddHost: vi.fn()
})

function renderTree(overrides: Partial<SessionTreeProps> = {}) {
  const props: SessionTreeProps = {
    discovery: THIS_PC,
    scanning: false,
    selectedPath: null,
    pinnedPaths: [],
    onTogglePin: vi.fn(),
    sessionsByPath: new Map([['c:\\work\\my-work\\repos\\notes', [session('session:3', 'my-work')]]]),
    elsewhere: [],
    onSelect: vi.fn(),
    onLaunch: vi.fn(),
    launchingPath: null,
    onOpenSession: vi.fn(),
    onAddRoot: vi.fn(),
    ...overrides
  }
  const view = render(<SessionTree {...props} />)
  return { props, view, rerender: (next: Partial<SessionTreeProps>) => view.rerender(<SessionTree {...props} {...next} />) }
}

const group = (container: HTMLElement, host: string): HTMLElement => {
  const found = container.querySelector<HTMLElement>(`[data-host-group="${host}"]`)
  if (found === null) throw new Error(`no group for ${host}`)
  return found
}

describe('SessionTree with hosts on other computers', () => {
  it('with only this PC, lists its projects and sessions as it always has: no host header and no Add a host line', () => {
    const { view } = renderTree({ hosts: [] })
    expect(view.container.querySelector('[data-host-header]')).toBeNull()
    expect(view.container.querySelector('[data-host-group]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add a host' })).toBeNull()
    expect(screen.getByTitle('C:\\work\\my-work\\repos\\notes')).toBeTruthy()
    expect(view.container.querySelector('[data-session-row="session:3"]')).not.toBeNull()
  })

  it('lists this PC first, then build-box under its name with its own rows, and ends with Add a host', async () => {
    const hostActions = actions()
    const { view } = renderTree({ hosts: [buildBox()], hostActions, localName: 'This PC', localKey: 'local' })

    const headers = [...view.container.querySelectorAll('[data-host-header]')].map((header) => header.textContent)
    expect(headers[0]).toMatch(/^This PC/)
    expect(headers[1]).toMatch(/^build-box/)
    const local = group(view.container, 'local')
    const remote = group(view.container, 'h1')
    expect(within(local).getByTitle('C:\\work\\my-work\\repos\\notes')).toBeTruthy()
    expect(within(local).queryByTitle('/home/you/work/infra/repos/api')).toBeNull()
    expect(within(remote).getByTitle('/home/you/work/infra/repos/api')).toBeTruthy()
    expect(within(remote).getByRole('button', { name: /^deploy, / })).toBeTruthy()
    // The host's name is machine data, and a remote host's is set in mono.
    expect(remote.querySelector('[data-host-header] .font-mono')?.textContent).toBe('build-box')

    const nav = screen.getByRole('navigation', { name: 'Projects and sessions' })
    const last = [...nav.children].at(-1)
    expect(last?.textContent).toBe('Add a host')
    await userEvent.click(screen.getByRole('button', { name: 'Add a host' }))
    expect(hostActions.onAddHost).toHaveBeenCalledOnce()

    await userEvent.click(within(remote).getByRole('button', { name: 'Start a session in api' }))
    expect(hostActions.onLaunch).toHaveBeenCalledWith('h1', expect.objectContaining({ path: '/home/you/work/infra/repos/api' }))
    await userEvent.click(within(remote).getByRole('button', { name: /^deploy, / }))
    expect(hostActions.onOpenSession).toHaveBeenCalledWith('h1', 'host:h1/session:3')
  })

  it('filters rows in every group', async () => {
    const { view } = renderTree({ hosts: [buildBox()], hostActions: actions() })
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter projects and sessions' }), 'deploy')
    expect(within(group(view.container, 'h1')).getByTitle('/home/you/work/infra/repos/api')).toBeTruthy()
    expect(within(group(view.container, 'local')).queryByTitle('C:\\work\\my-work\\repos\\notes')).toBeNull()

    await userEvent.clear(screen.getByRole('textbox', { name: 'Filter projects and sessions' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter projects and sessions' }), 'notes')
    expect(within(group(view.container, 'local')).getByTitle('C:\\work\\my-work\\repos\\notes')).toBeTruthy()
    expect(within(group(view.container, 'h1')).queryByTitle('/home/you/work/infra/repos/api')).toBeNull()
  })

  it('says build-box is retrying while it is not connected, keeps its rows dimmed, and shows them live once it is back', () => {
    const { view, rerender } = renderTree({ hosts: [buildBox({ connected: false })], hostActions: actions() })
    const remote = (): HTMLElement => group(view.container, 'h1')
    expect(remote().querySelector('[data-host-header]')?.getAttribute('data-host-state')).toBe('retrying')
    expect(within(remote()).getByText('retrying')).toBeTruthy()
    expect(remote().querySelector('[data-host-rows]')?.getAttribute('data-host-rows')).toBe('dimmed')
    expect(within(remote()).getByTitle('/home/you/work/infra/repos/api')).toBeTruthy()
    expect(within(remote()).getByRole('button', { name: /^deploy, / })).toBeTruthy()

    rerender({ hosts: [buildBox({ connected: true })] })
    expect(remote().querySelector('[data-host-header]')?.getAttribute('data-host-state')).toBe('connected')
    expect(within(remote()).queryByText('retrying')).toBeNull()
    expect(remote().querySelector('[data-host-rows]')?.getAttribute('data-host-rows')).toBe('live')
  })

  it('offers New session, New harness and Rescan on each host header, under the pointer and in its right-click menu', async () => {
    const hostActions = actions()
    const { view } = renderTree({ hosts: [buildBox()], hostActions })
    const header = group(view.container, 'h1').querySelector<HTMLElement>('[data-host-header]')!

    await userEvent.click(within(header).getByRole('button', { name: 'New session on build-box' }))
    expect(hostActions.onNewSession).toHaveBeenCalledWith('h1')
    await userEvent.click(within(header).getByRole('button', { name: 'Rescan build-box' }))
    expect(hostActions.onRescan).toHaveBeenCalledWith('h1')

    fireEvent.contextMenu(header, { clientX: 20, clientY: 30 })
    await userEvent.click(screen.getByRole('menuitem', { name: 'New harness' }))
    expect(hostActions.onNewHarness).toHaveBeenCalledWith('h1')

    const localHeader = group(view.container, 'local').querySelector<HTMLElement>('[data-host-header]')!
    await userEvent.click(within(localHeader).getByRole('button', { name: 'New harness on This PC' }))
    expect(hostActions.onNewHarness).toHaveBeenLastCalledWith('local')
  })

  it('shows the empty state under a host whose scan found nothing, offering New harness there', async () => {
    const hostActions = actions()
    const empty: DiscoveryResult = { ...BUILD_BOX, harnesses: [], projects: [] }
    const { view } = renderTree({
      hosts: [buildBox({ discovery: empty, sessionsByPath: new Map() })],
      hostActions
    })
    const remote = group(view.container, 'h1')
    expect(remote.querySelector('[data-empty-state="host-empty:h1"]')).not.toBeNull()
    expect(within(remote).getByText('No harnesses on build-box yet')).toBeTruthy()
    expect(within(remote).getByText('A harness there is a folder on build-box, and its sessions run there.')).toBeTruthy()
    await userEvent.click(within(remote).getByRole('button', { name: 'New harness' }))
    expect(hostActions.onNewHarness).toHaveBeenCalledWith('h1')
  })

  it('says Unknown and why, never the empty state, while the host’s folders cannot be read', async () => {
    const hostActions = actions()
    const { view } = renderTree({
      hosts: [buildBox({ discovery: null, sessionsByPath: new Map(), scanError: 'Its scan roots could not be read.' })],
      hostActions
    })
    const remote = group(view.container, 'h1')
    expect(remote.querySelector('[data-empty-state^="host-empty"]')).toBeNull()
    expect(within(remote).getByText('Unknown')).toBeTruthy()
    expect(within(remote).getByText(/Its scan roots could not be read\./)).toBeTruthy()
    await userEvent.click(within(remote).getByRole('button', { name: 'Try again' }))
    expect(hostActions.onRescan).toHaveBeenCalledWith('h1')
  })

  it('S20: the Add a host line at the end of the list opens the add-a-host dialog', async () => {
    const hostActions = actions()
    renderTree({ hosts: [buildBox()], hostActions })
    await userEvent.click(screen.getByRole('button', { name: 'Add a host' }))
    expect(hostActions.onAddHost).toHaveBeenCalledOnce()
  })

  it('S21: with this PC the only host, the list’s right-click menu has Add a host…, which opens the dialog', async () => {
    const onAddHostMenu = vi.fn()
    renderTree({ hosts: [], onAddHostMenu })
    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Projects and sessions' }), { clientX: 40, clientY: 80 })
    const item = await screen.findByRole('menuitem', { name: 'Add a host…' })
    await userEvent.click(item)
    expect(onAddHostMenu).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menuitem', { name: 'Add a host…' })).toBeNull()
  })

  it('S21: with the setting off (no menu handler given), the list’s right-click menu has no Add a host… item', () => {
    renderTree({ hosts: [] })
    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Projects and sessions' }), { clientX: 40, clientY: 80 })
    expect(screen.queryByRole('menuitem', { name: 'Add a host…' })).toBeNull()
  })
})
