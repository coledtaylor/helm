import { describe, expect, it } from 'vitest'
import type { PullRepo, PullSummary } from '@helm/core/types'
import { groupPulls, matchesPull, openPulls, splitStale, type OpenPull } from './pullTriage'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-02T12:00:00Z')

function pull(number: number, patch: Partial<PullSummary> = {}): PullSummary {
  return {
    number,
    title: `Pull request ${String(number)}`,
    url: `https://github.com/acme/x/pull/${String(number)}`,
    author: 'octocat',
    authorIsBot: false,
    state: 'OPEN',
    isDraft: false,
    headRefName: `feature/${String(number)}`,
    baseRefName: 'main',
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - DAY / 2,
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewDecision: null,
    checks: null,
    labels: [],
    ...patch
  }
}

function repo(name: string, pulls: PullSummary[]): PullRepo {
  return { path: `C:\\work\\${name}`, name, url: null, slug: `acme/${name}`, fetchedAtMs: NOW, error: null, pulls }
}

const numbers = (entries: OpenPull[]): number[] => entries.map((entry) => entry.pull.number)

describe('openPulls', () => {
  it('flattens every repository newest update first, with unreadable timestamps last', () => {
    const repos = [
      repo('alpha', [pull(1, { updatedAt: NOW - 3 * DAY }), pull(2, { updatedAt: null })]),
      repo('beta', [pull(3, { updatedAt: NOW - DAY }), pull(4, { updatedAt: NOW - 2 * DAY })])
    ]
    expect(numbers(openPulls(repos))).toEqual([3, 4, 1, 2])
  })
})

describe('splitStale', () => {
  const entries = openPulls([
    repo('alpha', [
      pull(1, { updatedAt: NOW - DAY / 2 }),
      pull(2, { updatedAt: NOW - 3 * DAY }),
      pull(3, { updatedAt: null }),
      // Red CI is a signal on the chip, never a second rule for the split.
      pull(4, { updatedAt: NOW - 5 * DAY, checks: { total: 3, failing: 2, pending: 0 } })
    ])
  ])

  it('files a pull request untouched past the cutoff under STALE, and an unreadable one under ACTIVE', () => {
    const { split, active, stale } = splitStale(entries, 2, NOW)
    expect(split).toBe(true)
    expect(numbers(active).sort()).toEqual([1, 3])
    expect(numbers(stale).sort()).toEqual([2, 4])
  })

  it('does not split at all when the cutoff is off', () => {
    const { split, active, stale } = splitStale(entries, 0, NOW)
    expect(split).toBe(false)
    expect(numbers(active)).toEqual(numbers(entries))
    expect(stale).toEqual([])
  })
})

describe('matchesPull', () => {
  const entry: OpenPull = {
    repo: repo('widgets', []),
    pull: pull(418, { title: 'Fix the empty state', headRefName: 'fix/empty', author: 'mona' })
  }

  it('finds a pull request by number with or without #, title, branch, author and repository', () => {
    for (const query of ['418', '#418', 'EMPTY STATE', 'fix/empty', 'mona', 'widgets', 'acme/widgets', '  418  ', '']) {
      expect(matchesPull(entry, query)).toBe(true)
    }
    for (const query of ['419', '#41 8', 'octocat', 'gadgets']) {
      expect(matchesPull(entry, query)).toBe(false)
    }
  })
})

describe('groupPulls', () => {
  // Core sends repositories busiest first; the grouping keeps that order.
  const repos = [
    repo('quiet', [pull(1, { author: 'mona' })]),
    repo('busy', [pull(2, { author: 'app/dependabot', authorIsBot: true }), pull(3, { author: 'mona' }), pull(4, { author: 'hubot' })])
  ]
  const open = openPulls(repos)

  it('is one unlabelled group for None', () => {
    const groups = groupPulls(open, 'none', repos)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.label).toBeNull()
    expect(numbers(groups[0]?.items ?? [])).toEqual(numbers(open))
  })

  it('groups by repository in the order core gave, one-row groups included, and names the repository in the heading', () => {
    const groups = groupPulls(open, 'repo', repos)
    expect(groups.map((group) => [group.label, group.sub, group.items.length])).toEqual([
      ['quiet', 'acme/quiet', 1],
      ['busy', 'acme/busy', 3]
    ])
    expect(groups.every((group) => group.namesRepo)).toBe(true)
  })

  it('groups by author, most pull requests first and ties by name, with a bot named without its app/ prefix', () => {
    const groups = groupPulls(open, 'author', repos)
    expect(groups.map((group) => [group.label, group.items.length, group.bot])).toEqual([
      ['mona', 2, false],
      ['dependabot', 1, true],
      ['hubot', 1, false]
    ])
    expect(groups.some((group) => group.namesRepo)).toBe(false)
  })

  it('never changes the set of rows, whatever the mode', () => {
    for (const mode of ['none', 'repo', 'author'] as const) {
      const rows = groupPulls(open, mode, repos).flatMap((group) => numbers(group.items))
      expect(rows.sort()).toEqual(numbers(open).sort())
    }
  })
})
