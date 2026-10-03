import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type Project } from '@helm/core/types'
import type { PullsSnapshot } from '@helm/core/types'
import { ProjectPane, type ProjectPaneProps } from './ProjectPane'
import { pullRepo, pullsSnapshot, pullSummary } from './pullFixtures.testkit'

/** The project pane's pull-request panel, and the links that scope other panes to the project. */

const alpha: Project = {
  // A different casing from the repository row: Windows paths compare without it.
  path: 'c:\\WORK SPACE\\alpha',
  name: 'alpha',
  kind: 'repo',
  harnessPath: null,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: { branch: 'main', detached: false, dirty: 0, ahead: 0, behind: 0 }
}

function snapshot(patch: Partial<PullsSnapshot> = {}): PullsSnapshot {
  return pullsSnapshot(
    [
      pullRepo('alpha', [pullSummary(7, { title: 'Seven' }), pullSummary(9, { title: 'Nine' })]),
      pullRepo('beta', [pullSummary(3, { title: 'Three' })])
    ],
    patch
  )
}

function renderPane(overrides: Partial<ProjectPaneProps> = {}) {
  const props: ProjectPaneProps = {
    project: alpha,
    onReveal: vi.fn(),
    onLaunch: vi.fn(),
    onOpenConfig: vi.fn(),
    onOpenFiles: vi.fn(),
    pulls: snapshot(),
    onOpenPull: vi.fn(),
    onRefreshPulls: vi.fn(),
    onUnignoreRepo: vi.fn(),
    ...overrides
  }
  const view = render(<ProjectPane {...props} />)
  return { props, ...view }
}

/** The panel under the "Pull requests" label. */
function panel(): HTMLElement {
  const found = screen.getByRole('heading', { name: 'Pull requests' }).closest('section')
  if (found === null) throw new Error('no pull requests panel')
  return found
}

const rowsIn = (scope: HTMLElement): string[] =>
  within(scope)
    .queryAllByRole('button', { name: /^#\d+/ })
    .map((row) => /^#\d+/.exec(row.textContent ?? '')?.[0] ?? '')

describe('ProjectPane pull requests', () => {
  it('lists exactly this repository’s open pull requests, with no source pill and the age of the fetch', () => {
    renderPane()

    expect(rowsIn(panel())).toEqual(['#7', '#9'])
    for (const row of within(panel()).getAllByRole('button', { name: /^#\d+/ })) {
      expect(within(row).queryByText('alpha')).toBeNull()
    }
    expect(within(panel()).getByText('acme/alpha')).toBeTruthy()
    expect(within(panel()).getByText('fetched 4m ago')).toBeTruthy()
  })

  it('opens a pull request from its row and checks this repository again from the panel', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()

    await user.click(within(panel()).getByRole('button', { name: /^#9/ }))
    const [repo, pull] = vi.mocked(props.onOpenPull!).mock.calls[0]!
    expect([repo.slug, pull.number]).toEqual(['acme/alpha', 9])

    await user.click(within(panel()).getByRole('button', { name: 'Check for open pull requests' }))
    expect(props.onRefreshPulls).toHaveBeenCalledWith('C:\\work space\\alpha')
  })

  it('opens the config console and the Files view on this project', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()

    await user.click(screen.getByRole('button', { name: 'Config' }))
    await user.click(screen.getByRole('button', { name: 'Files' }))

    expect(props.onOpenConfig).toHaveBeenCalledWith(alpha)
    expect(props.onOpenFiles).toHaveBeenCalledWith(alpha)
  })

  it('names the slug of an ignored repository with a way back, and paints its cached rows once it is back', async () => {
    const user = userEvent.setup()
    const ignored = snapshot({
      ignored: [{ slug: 'acme/alpha', name: 'alpha', present: true, paths: ['C:\\work space\\alpha'] }]
    })
    ignored.repos = ignored.repos.filter((repo) => repo.slug !== 'acme/alpha')
    const { props, rerender } = renderPane({ pulls: ignored })

    expect(panel().textContent).toMatch(/Pull requests for acme\/alpha are not being fetched/)
    expect(rowsIn(panel())).toEqual([])
    await user.click(within(panel()).getByRole('button', { name: 'Fetch this repository again' }))
    expect(props.onUnignoreRepo).toHaveBeenCalledWith('acme/alpha')

    rerender(<ProjectPane {...props} pulls={snapshot()} />)
    expect(rowsIn(panel())).toEqual(['#7', '#9'])
  })

  it('keeps the rows under a repository’s own failure, and says nothing was fetched when there are none', () => {
    const failing = snapshot()
    failing.repos[0]!.error = 'HTTP 502: unwell'
    const { props, rerender } = renderPane({ pulls: failing })
    expect(within(panel()).getByText('HTTP 502: unwell')).toBeTruthy()
    expect(rowsIn(panel())).toEqual(['#7', '#9'])

    const empty = snapshot()
    empty.repos[0] = pullRepo('alpha', [], { error: 'HTTP 502: unwell' })
    rerender(<ProjectPane {...props} pulls={empty} />)
    expect(within(panel()).getByText('Nothing was fetched.')).toBeTruthy()
  })

  it('has no pull request panel for a folder the surface has nothing to say about', () => {
    renderPane({ project: { ...alpha, path: 'C:\\work space\\notes', name: 'notes' } })
    expect(screen.queryByRole('heading', { name: 'Pull requests' })).toBeNull()
  })
})
