import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PullDetail, PullSummary } from '../github/types'
import { openStore, type Store } from './db'
import {
  forgetPrRepos,
  readPrRepos,
  readPull,
  readPullsBySlug,
  recordPrFetch,
  replaceRepoPulls,
  upsertPrRepo,
  writePullDetail
} from './pulls'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-pulls-'))
  store = openStore({ file: join(dir, 'helm.db') })
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

const pull = (overrides: Partial<PullSummary> = {}): PullSummary => ({
  number: 42,
  title: 'Teach the launcher about pull requests',
  url: 'https://github.com/acme/web/pull/42',
  author: 'coledtaylor',
  authorIsBot: false,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feature/pulls',
  baseRefName: 'main',
  createdAt: Date.parse('2026-08-01T09:00:00Z'),
  updatedAt: Date.parse('2026-08-10T18:30:00Z'),
  additions: 812,
  deletions: 37,
  changedFiles: 14,
  reviewDecision: 'REVIEW_REQUIRED',
  labels: ['enhancement'],
  ...overrides
})

const detail = (overrides: Partial<PullDetail> = {}): PullDetail => ({
  body: 'Adds the pane.',
  comments: [
    {
      id: 'IC_1',
      author: 'reviewer',
      authorIsBot: false,
      association: 'MEMBER',
      body: 'Looks right.',
      createdAt: Date.parse('2026-08-10T12:00:00Z'),
      url: 'https://github.com/acme/web/pull/42#issuecomment-1'
    }
  ],
  reviews: [],
  commits: [
    {
      oid: 'a'.repeat(40),
      messageHeadline: 'Add the pane',
      author: 'coledtaylor',
      coAuthors: 0,
      committedAt: Date.parse('2026-08-09T12:00:00Z')
    }
  ],
  files: [{ path: 'packages/ui/src/components/PullsPane.tsx', additions: 812, deletions: 37 }],
  checks: { total: 3, failing: 0, pending: 1 },
  mergeStateStatus: 'CLEAN',
  ...overrides
})

describe('pr_repos', () => {
  it('round-trips a mapped remote', () => {
    upsertPrRepo(store, {
      path: join(dir, 'web'),
      url: 'https://github.com/acme/web.git',
      slug: 'acme/web',
      checkedAt: '2026-08-11T10:00:00.000Z'
    })

    expect(readPrRepos(store)).toEqual([
      {
        path: join(dir, 'web'),
        url: 'https://github.com/acme/web.git',
        slug: 'acme/web',
        checkedAt: '2026-08-11T10:00:00.000Z',
        fetchedAt: null,
        error: null
      }
    ])
  })

  it('records "checked, and not GitHub" as a fact rather than as an absence', () => {
    upsertPrRepo(store, { path: join(dir, 'notes'), url: null, slug: null })

    const [row] = readPrRepos(store)
    expect(row?.slug).toBeNull()
    // The distinction the fetch pass turns on: this directory has been looked
    // at, so it is not looked at again on every tick.
    expect(row?.checkedAt).not.toBeNull()
  })

  it('re-mapping a remote leaves the fetch record alone', () => {
    const path = join(dir, 'web')
    upsertPrRepo(store, { path, url: 'https://github.com/acme/web.git', slug: 'acme/web' })
    recordPrFetch(store, [path], { error: null, fetchedAt: '2026-08-11T10:00:00.000Z' })

    upsertPrRepo(store, { path, url: 'https://github.com/acme/web.git', slug: 'acme/web' })

    expect(readPrRepos(store)[0]?.fetchedAt).toBe('2026-08-11T10:00:00.000Z')
  })

  it('a failed fetch keeps the age of the rows still on screen', () => {
    const path = join(dir, 'web')
    upsertPrRepo(store, { path, url: 'https://github.com/acme/web.git', slug: 'acme/web' })
    recordPrFetch(store, [path], { error: null, fetchedAt: '2026-08-11T10:00:00.000Z' })

    recordPrFetch(store, [path], { error: 'HTTP 502' })

    const [row] = readPrRepos(store)
    // Stale-with-age, not degrade-to-nothing: the caption has to keep
    // describing the pull requests actually being painted.
    expect(row?.fetchedAt).toBe('2026-08-11T10:00:00.000Z')
    expect(row?.error).toBe('HTTP 502')
  })

  it('a later success clears the error', () => {
    const path = join(dir, 'web')
    upsertPrRepo(store, { path, url: null, slug: 'acme/web' })
    recordPrFetch(store, [path], { error: 'HTTP 502' })

    recordPrFetch(store, [path], { error: null, fetchedAt: '2026-08-11T11:00:00.000Z' })

    expect(readPrRepos(store)[0]).toMatchObject({
      error: null,
      fetchedAt: '2026-08-11T11:00:00.000Z'
    })
  })

  it('forgets directories discovery no longer sees, and only those', () => {
    const kept = join(dir, 'web')
    const gone = join(dir, 'old')
    upsertPrRepo(store, { path: kept, url: null, slug: 'acme/web' })
    upsertPrRepo(store, { path: gone, url: null, slug: 'acme/old' })

    expect(forgetPrRepos(store, [kept])).toBe(1)
    expect(readPrRepos(store).map((row) => row.path)).toEqual([kept])
  })
})

describe('replaceRepoPulls', () => {
  it('caches a repository’s open pull requests', () => {
    replaceRepoPulls(store, 'acme/web', [pull(), pull({ number: 43 })])

    expect(readPullsBySlug(store).get('acme/web')?.map((p) => p.number)).toEqual([42, 43])
  })

  it('drops a pull request the next pass no longer returns', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 }), pull({ number: 43 })])

    // 43 was merged between the two passes, so it is simply not in the answer.
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 })])

    expect(readPullsBySlug(store).get('acme/web')?.map((p) => p.number)).toEqual([42])
  })

  it('empties a repository whose last pull request closed', () => {
    replaceRepoPulls(store, 'acme/web', [pull()])

    replaceRepoPulls(store, 'acme/web', [])

    expect(readPullsBySlug(store).get('acme/web')).toBeUndefined()
  })

  it('touches no other repository', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 })])
    replaceRepoPulls(store, 'acme/api', [pull({ number: 7 })])

    replaceRepoPulls(store, 'acme/web', [])

    expect(readPullsBySlug(store).get('acme/api')?.map((p) => p.number)).toEqual([7])
  })

  it('rewrites the summary of a pull request that is still open', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ title: 'Draft title', isDraft: true })])

    replaceRepoPulls(store, 'acme/web', [pull({ title: 'Ready title', isDraft: false })])

    expect(readPullsBySlug(store).get('acme/web')?.[0]).toMatchObject({
      title: 'Ready title',
      isDraft: false
    })
  })

  it('keeps cached detail across a poll, and takes it away with the pull request', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 }), pull({ number: 43 })])
    // What opening a pull request caches: the summary is refetched every five
    // minutes and the conversation behind it is not.
    writePullDetail(store, 'acme/web', 42, detail(), '2026-08-11T10:00:00.000Z')

    replaceRepoPulls(store, 'acme/web', [pull({ number: 42, title: 'Renamed' })])

    const kept = readPull(store, 'acme/web', 42)
    expect(kept?.summary.title).toBe('Renamed')
    expect(kept?.detail).toEqual(detail())
    expect(kept?.detailFetchedAt).toBe('2026-08-11T10:00:00.000Z')
    expect(readPull(store, 'acme/web', 43)).toBeNull()
  })

  it('round-trips a detail through JSON, structures and all', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 })])
    writePullDetail(store, 'acme/web', 42, detail())

    const read = readPull(store, 'acme/web', 42)
    expect(read?.detail?.comments[0]?.body).toBe('Looks right.')
    expect(read?.detail?.commits[0]?.oid).toHaveLength(40)
    expect(read?.detail?.checks).toEqual({ total: 3, failing: 0, pending: 1 })
    // Written at all, which is what tells "never opened" from "opened and it
    // had nothing in it".
    expect(read?.detailFetchedAt).not.toBeNull()
  })

  it('has no detail at all until the pull request has been opened', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 })])

    const read = readPull(store, 'acme/web', 42)
    expect(read?.detail).toBeNull()
    expect(read?.detailFetchedAt).toBeNull()
  })

  it('writes no detail for a pull request no list has returned', () => {
    // Half a row - a detail with no summary beside it - is a pull request the
    // pane could never paint, so the write reports that it changed nothing.
    expect(writePullDetail(store, 'acme/web', 999, detail())).toBe(false)
    expect(readPull(store, 'acme/web', 999)).toBeNull()
  })

  it('replaces the detail a refresh refetched', () => {
    replaceRepoPulls(store, 'acme/web', [pull({ number: 42 })])
    writePullDetail(store, 'acme/web', 42, detail(), '2026-08-11T10:00:00.000Z')

    writePullDetail(
      store,
      'acme/web',
      42,
      detail({ body: 'Rewritten description.', comments: [] }),
      '2026-08-11T11:00:00.000Z'
    )

    const read = readPull(store, 'acme/web', 42)
    expect(read?.detail?.body).toBe('Rewritten description.')
    expect(read?.detail?.comments).toEqual([])
    expect(read?.detailFetchedAt).toBe('2026-08-11T11:00:00.000Z')
  })

  it('orders by most recent activity when read back', () => {
    replaceRepoPulls(store, 'acme/web', [
      pull({ number: 1, updatedAt: Date.parse('2026-08-01T00:00:00Z') }),
      pull({ number: 2, updatedAt: Date.parse('2026-08-09T00:00:00Z') }),
      pull({ number: 3, updatedAt: null })
    ])

    expect(readPullsBySlug(store).get('acme/web')?.map((p) => p.number)).toEqual([2, 1, 3])
  })

  it('survives a restart, which is what makes the pane paint before any fetch', () => {
    replaceRepoPulls(store, 'acme/web', [pull()])
    upsertPrRepo(store, { path: join(dir, 'web'), url: null, slug: 'acme/web' })
    store.close()

    const reopened = openStore({ file: join(dir, 'helm.db') })
    try {
      expect(readPullsBySlug(reopened).get('acme/web')?.[0]).toEqual(pull())
      expect(readPrRepos(reopened)).toHaveLength(1)
    } finally {
      reopened.close()
    }
  })
})
