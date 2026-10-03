import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GhProblem, PullsSnapshot } from '@helm/core/types'
import { PullsPane, pullsSummaryLine, type PullsPaneProps } from './PullsPane'
import { DAY, HOUR, pullRepo, pullsSnapshot, pullSummary } from './pullFixtures.testkit'
import { expectOnThePane } from './page.testkit'

/**
 * Five open pull requests over three repositories, with a two-day cutoff:
 * alpha #7 (an hour old), #9 (five days, red CI) and #11 (no readable time);
 * beta #3 (three hours, a bot's) and #4 (ten days); gamma has nothing open.
 */
function planted(patch: Partial<PullsSnapshot> = {}): PullsSnapshot {
  const now = Date.now()
  return pullsSnapshot(
    [
      pullRepo('alpha', [
        pullSummary(7, { updatedAt: now - HOUR }),
        pullSummary(9, { updatedAt: now - 5 * DAY, author: 'mona', checks: { total: 3, failing: 1, pending: 0 } }),
        pullSummary(11, { updatedAt: null })
      ]),
      pullRepo('beta', [
        pullSummary(3, { updatedAt: now - 3 * HOUR, author: 'app/dependabot', authorIsBot: true }),
        pullSummary(4, { updatedAt: now - 10 * DAY, author: 'mona' })
      ]),
      pullRepo('gamma', [])
    ],
    patch
  )
}

function renderPane(overrides: Partial<PullsPaneProps> = {}) {
  const props: PullsPaneProps = {
    snapshot: planted(),
    onRefresh: vi.fn(),
    refreshing: false,
    onOpenPull: vi.fn(),
    onUnignoreRepo: vi.fn(),
    staleDays: 2,
    ...overrides
  }
  const view = render(<PullsPane {...props} />)
  return { props, ...view }
}

/** A section of the list, found by its heading. */
function section(label: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: new RegExp(`^${label}\\d`) })
  const found = heading.closest('section')
  if (found === null) throw new Error(`no section around ${label}`)
  return found
}

/** The count a section's heading carries, which sits straight after its label. */
function countOf(label: string): number {
  const name = screen.getByRole('heading', { level: 2, name: new RegExp(`^${label}\\d`) }).textContent ?? ''
  return Number(new RegExp(`^${label}(\\d+)`).exec(name)?.[1])
}

/** The pull request numbers painted in a section, rows and chips alike, in order. */
function rowsIn(scope: HTMLElement): number[] {
  return within(scope)
    .queryAllByRole('button', { name: /^#\d+/ })
    .map((row) => Number(/^#(\d+)/.exec(row.textContent ?? '')?.[1]))
}

const row = (number: number): HTMLElement => screen.getByRole('button', { name: new RegExp(`^#${String(number)}\\D`) })

describe('PullsPane', () => {
  it('splits Open into ACTIVE and STALE at the cutoff, and every count is the rows under it', () => {
    renderPane()

    expect(rowsIn(section('Active'))).toEqual([7, 3, 11])
    expect(countOf('Active')).toBe(3)
    expect(rowsIn(section('Stale'))).toEqual([9, 4])
    expect(countOf('Stale')).toBe(2)
    expect(within(section('Stale')).getByText('No motion in 2+ days.')).toBeTruthy()
    // A stale chip keeps its check tally: red CI is a signal, not a rule.
    expect(within(row(9)).getByTitle('3 checks, 1 failing, 0 pending').textContent).toBe('1/3')
    // The header counts every open pull request, whichever section it is in.
    expect(screen.getByText('5 open')).toBeTruthy()
    expect(screen.getByText('fetched 4m ago')).toBeTruthy()
    expect(within(section('Quiet repos')).getByRole('button', { name: /^gamma/ })).toBeTruthy()
  })

  it('is one Open section, newest first and unreadable last, when the cutoff is off', () => {
    renderPane({ staleDays: 0 })

    expect(rowsIn(section('Open'))).toEqual([7, 3, 9, 4, 11])
    expect(countOf('Open')).toBe(5)
    expect(screen.queryByRole('heading', { name: /^Active/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /^Stale/ })).toBeNull()
  })

  it('collapses STALE to its heading and back, leaving ACTIVE and the header alone, and forgets it on remount', async () => {
    const user = userEvent.setup()
    const { unmount } = renderPane()

    await user.click(within(section('Stale')).getByRole('button', { name: 'Hide' }))
    expect(rowsIn(section('Stale'))).toEqual([])
    expect(countOf('Stale')).toBe(2)
    expect(within(section('Stale')).getByText('No motion in 2+ days.')).toBeTruthy()
    expect(within(section('Stale')).getByRole('button', { name: 'Show' }).getAttribute('aria-expanded')).toBe('false')
    expect(rowsIn(section('Active'))).toEqual([7, 3, 11])
    expect(screen.getByText('5 open')).toBeTruthy()

    await user.click(within(section('Stale')).getByRole('button', { name: 'Show' }))
    expect(rowsIn(section('Stale'))).toEqual([9, 4])

    await user.click(within(section('Stale')).getByRole('button', { name: 'Hide' }))
    unmount()
    renderPane()
    expect(rowsIn(section('Stale'))).toEqual([9, 4])
  })

  it('filters by number, title, branch, author and repository, with shown/total by the field and section counts that follow', async () => {
    const user = userEvent.setup()
    renderPane()
    const filter = screen.getByRole('textbox', { name: 'Filter pull requests' })

    await user.type(filter, 'mona')
    expect(screen.getByText('2/5')).toBeTruthy()
    expect(rowsIn(section('Stale'))).toEqual([9, 4])
    expect(countOf('Stale')).toBe(2)
    expect(rowsIn(section('Active'))).toEqual([])
    expect(countOf('Active')).toBe(0)
    expect(within(section('Active')).getByText(/What matches is below\./)).toBeTruthy()
    expect(screen.getByText('5 open')).toBeTruthy()

    await user.clear(filter)
    await user.type(filter, '#3')
    expect(screen.getByText('1/5')).toBeTruthy()
    expect(rowsIn(section('Active'))).toEqual([3])
    expect(countOf('Active')).toBe(1)
    expect(screen.queryByRole('heading', { name: /^Stale/ })).toBeNull()

    for (const [query, expected] of [
      ['feature/pr-11', [11]],
      ['beta', [3, 4]]
    ] as const) {
      await user.clear(filter)
      await user.type(filter, query)
      expect([...rowsIn(section('Active')), ...(screen.queryByRole('heading', { name: /^Stale/ }) ? rowsIn(section('Stale')) : [])].sort()).toEqual(
        [...expected].sort()
      )
    }
  })

  it('says a query matched nothing, rather than that nothing is open', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: 'Filter pull requests' }), 'no such thing')

    expect(screen.getByText(/Nothing open matches that\./).textContent).toMatch(/5 pull requests are hidden by the filter\./)
    expect(screen.queryByText(/Nothing open in/)).toBeNull()
    expect(screen.getByText('0/5')).toBeTruthy()
  })

  it('groups by repository with a heading each and no pill, by author with the pill on every row, and never changes the rows', async () => {
    const user = userEvent.setup()
    renderPane()
    const all = (): number[] => rowsIn(screen.getByRole('group', { name: 'Open pull requests' })).sort()
    const before = all()
    // Flat, every row names the repository it came from.
    expect(within(row(7)).getByText('alpha')).toBeTruthy()
    expect(within(row(4)).getByText('beta')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Repo' }))
    expect(screen.getByRole('button', { name: 'Repo' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(section('Active')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'alpha2acme/alpha',
      'beta1acme/beta'
    ])
    expect(within(section('Stale')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'alpha1acme/alpha',
      'beta1acme/beta'
    ])
    for (const number of [7, 9, 11]) expect(within(row(number)).queryByText('alpha')).toBeNull()
    for (const number of [3, 4]) expect(within(row(number)).queryByText('beta')).toBeNull()
    expect(all()).toEqual(before)

    await user.click(screen.getByRole('button', { name: 'Author' }))
    // #7 and #11 are octocat's, #3 the bot's: busiest first.
    expect(within(section('Active')).getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'octocat2',
      'dependabotbot1'
    ])
    for (const number of [7, 9, 11]) expect(within(row(number)).getByText('alpha')).toBeTruthy()
    for (const number of [3, 4]) expect(within(row(number)).getByText('beta')).toBeTruthy()
    expect(all()).toEqual(before)
  })

  it('resets the filter and the grouping when it remounts, and writes neither anywhere', async () => {
    const user = userEvent.setup()
    const { props, unmount } = renderPane()

    await user.type(screen.getByRole('textbox', { name: 'Filter pull requests' }), 'mona')
    await user.click(screen.getByRole('button', { name: 'Author' }))
    unmount()

    renderPane(props)
    expect((screen.getByRole('textbox', { name: 'Filter pull requests' }) as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true')
    expect(props.onRefresh).not.toHaveBeenCalled()
    expect(props.onOpenPull).not.toHaveBeenCalled()
    expect(props.onUnignoreRepo).not.toHaveBeenCalled()
  })

  it('opens a pull request from a row and from a stale chip', async () => {
    const user = userEvent.setup()
    const { props } = renderPane()

    await user.click(row(7))
    await user.click(row(4))

    expect(vi.mocked(props.onOpenPull!).mock.calls.map(([repo, pull]) => [repo.name, pull.number])).toEqual([
      ['alpha', 7],
      ['beta', 4]
    ])
  })

  it('shows an ignored repository as a chip of its own, not a quiet one, and clicking it takes it off the list', async () => {
    const user = userEvent.setup()
    const { props } = renderPane({
      snapshot: planted({
        ignored: [
          { slug: 'acme/delta', name: 'delta', present: true, paths: ['C:\\work space\\delta'] },
          { slug: 'acme/gone', name: 'gone', present: false, paths: [] }
        ]
      })
    })

    const ignored = section('Ignored')
    expect(countOf('Ignored')).toBe(1)
    expect(within(section('Quiet repos')).queryByText('delta')).toBeNull()
    expect(within(ignored).queryByText('gone')).toBeNull()

    await user.click(within(ignored).getByRole('button', { name: /^delta/ }))
    expect(props.onUnignoreRepo).toHaveBeenCalledWith('acme/delta')
  })

  it('names a repository that could not be fetched with its reason, keeps its rows, and retries just that one', async () => {
    const user = userEvent.setup()
    const snapshot = planted()
    const beta = snapshot.repos[1]!
    beta.error = 'HTTP 403: Resource not accessible'
    const { props } = renderPane({ snapshot })

    const failed = section('Could not fetch')
    expect(countOf('Could not fetch')).toBe(1)
    await user.click(within(failed).getByRole('button', { name: /^beta.*HTTP 403: Resource not accessible/ }))
    expect(props.onRefresh).toHaveBeenCalledWith(beta.path)
    expect(rowsIn(section('Active'))).toContain(3)
  })

  describe('when gh has a problem', () => {
    const withProblem = (problem: GhProblem): PullsSnapshot =>
      planted({ gh: { path: 'C:\\gh\\gh.exe', source: 'discovered', version: null, authenticated: false, problem } })

    it('signed out, says gh auth login in the pane and the sidebar, and keeps the rows and their age', () => {
      const snapshot = withProblem({
        kind: 'unauthenticated',
        message: 'GitHub CLI is not signed in. Run `gh auth login` in a terminal.'
      })
      renderPane({ snapshot })

      expect(screen.getByText(/Run `gh auth login` in a terminal\./)).toBeTruthy()
      expect(rowsIn(section('Active'))).toEqual([7, 3, 11])
      expect(screen.getByText('fetched 4m ago')).toBeTruthy()
      expect(pullsSummaryLine(snapshot)).toBe('Run gh auth login')
    })

    it('offline, keeps the rows and tells the sidebar the connection is down, not the sign-in', () => {
      const snapshot = withProblem({ kind: 'offline', message: 'GitHub could not be reached.' })
      renderPane({ snapshot })

      expect(screen.getByText('GitHub could not be reached.')).toBeTruthy()
      expect(rowsIn(section('Stale'))).toEqual([9, 4])
      expect(pullsSummaryLine(snapshot)).toBe('GitHub unreachable · showing cached')
      expect(pullsSummaryLine(snapshot)).not.toMatch(/auth|sign/i)
    })

    it('with no gh at all, says so in the pane and the sidebar', () => {
      const snapshot = pullsSnapshot([], {
        gh: {
          path: null,
          source: null,
          version: null,
          authenticated: false,
          problem: { kind: 'missing', message: 'GitHub CLI is not installed.' }
        }
      })
      renderPane({ snapshot })

      expect(screen.getByText('GitHub CLI is not installed.')).toBeTruthy()
      expect(screen.getByText('Nothing has been fetched.')).toBeTruthy()
      expect(pullsSummaryLine(snapshot)).toBe('GitHub CLI not installed')
    })
  })

  it('says it is still checking before any remote has been read, and only then that nothing is on GitHub', () => {
    const checking = pullsSnapshot([], { checked: 2, unmapped: 2 })
    const { rerender } = renderPane({ snapshot: checking })
    expect(screen.getByText(/Checking 2 folders for a github\.com remote/)).toBeTruthy()
    expect(screen.queryByText(/has a github\.com origin/)).toBeNull()
    expect(pullsSummaryLine(checking)).toBe('Checking for repositories…')

    const answered = pullsSnapshot([], { checked: 2, unmapped: 0 })
    rerender(<PullsPane snapshot={answered} onRefresh={vi.fn()} refreshing={false} staleDays={2} />)
    expect(screen.getByText('None of the 2 folders Helm scans has a github.com origin.')).toBeTruthy()
    expect(pullsSummaryLine(answered)).toBe('No github.com repositories')
  })

  it('counts open pull requests and repositories for the sidebar', () => {
    expect(pullsSummaryLine(null)).toBe('Reading…')
    expect(pullsSummaryLine(planted())).toBe('5 open · 3 repos')
  })
})

describe('PullsPane on its pane', () => {
  it('draws no island of its own, and its bar repeats no title the tab already says', () => {
    renderPane()
    expectOnThePane(document.body, 'pulls')
  })
})
