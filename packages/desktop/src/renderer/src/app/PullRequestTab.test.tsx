import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullDetailView, SessionRecord } from '@helm/core/types'
import type { LaunchedReview } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { PullRequestTab } from './PullRequestTab'

vi.mock('./bridge', () => import('./bridge.testkit'))

const REPO = 'C:\\work space\\alpha'

function view(): PullDetailView {
  return {
    slug: 'acme/alpha',
    repoPath: REPO,
    summary: {
      number: 7,
      title: 'Cache the walk',
      url: 'https://github.com/acme/alpha/pull/7',
      author: 'octocat',
      authorIsBot: false,
      state: 'OPEN',
      isDraft: false,
      headRefName: 'fix/cache-walk',
      baseRefName: 'main',
      createdAt: Date.now() - 86_400_000,
      updatedAt: Date.now() - 3_600_000,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      reviewDecision: null,
      checks: null,
      labels: []
    },
    detail: { body: '', comments: [], reviews: [], commits: [], files: [], checks: null, mergeStateStatus: 'CLEAN' },
    bodyHtml: '',
    conversation: [],
    threadsNote: null,
    threadsFetchedAtMs: null,
    files: [],
    diffNote: null,
    fetchedAtMs: Date.now(),
    cached: true
  }
}

function session(name: string): SessionRecord {
  return {
    id: 12,
    name,
    label: null,
    cwd: REPO,
    branch: 'main',
    projectPath: REPO,
    profileId: null,
    argv: ['-n', name, '/code-review 7'],
    claudeSessionId: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null
  }
}

function renderTab(onReview: (repoPath: string, number: number) => Promise<LaunchedReview>) {
  render(
    <PullRequestTab
      repoPath={REPO}
      number={7}
      reviewTemplate="Review {slug}#{number} ({title}) on {branch} at {url}"
      checkout="none"
      reviewModel={null}
      reviewEffort={null}
      onReview={onReview}
      onOpenExternal={vi.fn()}
      compact={false}
    />
  )
}

describe('PullRequestTab', () => {
  beforeEach(() => {
    bridge.reset()
  })

  it('keeps Review disabled until the pull request has loaded, then previews the rendered template', async () => {
    let answer: (value: PullDetailView) => void = () => undefined
    const detail = new Promise<PullDetailView>((resolve) => (answer = resolve))
    bridge.answer('pr:detail', () => detail)
    renderTab(vi.fn())

    expect(bridge.invoked('pr:detail')).toContainEqual({ repoPath: REPO, number: 7 })
    const button = screen.getByRole('button', { name: 'Review with Claude' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await act(async () => answer(view()))

    expect(button.disabled).toBe(false)
    expect(screen.getByText(/^Runs/).textContent).toBe(
      `Runs claude in ${REPO} with the opening prompt Review acme/alpha#7 (Cache the walk) on fix/cache-walk at https://github.com/acme/alpha/pull/7.`
    )
  })

  it('asks for the review by repository and number only, and names the session it started', async () => {
    const user = userEvent.setup()
    bridge.answer('pr:detail', () => view())
    const onReview = vi.fn((_repoPath: string, _number: number) =>
      Promise.resolve({ session: session('PR #7 review - alpha'), prompt: '/code-review 7', checkedOut: null, warnings: [] })
    )
    renderTab(onReview)

    await user.click(await screen.findByRole('button', { name: 'Review with Claude' }))

    expect(onReview.mock.calls).toEqual([[REPO, 7]])
    expect((await screen.findByText(/^Started/)).textContent).toMatch(/^Started PR #7 review - alpha\./)
  })

  it('shows why a launch was refused', async () => {
    const user = userEvent.setup()
    bridge.answer('pr:detail', () => view())
    renderTab(() =>
      Promise.reject(new Error("Error invoking remote method 'pr:review': Error: C:\\work space\\alpha has 1 uncommitted change."))
    )

    await user.click(await screen.findByRole('button', { name: 'Review with Claude' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Error: C:\\work space\\alpha has 1 uncommitted change.')
  })
})
