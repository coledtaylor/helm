import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { PullDetail, PullSummary } from '../github/types'
import type { Store } from './db'
import { prRepos, pullRequests } from './schema'

/**
 * The pull-request cache.
 *
 * It exists so the pane paints instantly on a cold start - the same reason the
 * project cache does. A surface that shows nothing until a subprocess has
 * finished talking to GitHub is a surface that is empty every time the app
 * opens, and the honest alternative to an empty list is yesterday's list with
 * its age on it (see `PullsSnapshot`).
 */

/** One project's origin remote, as the cache holds it. */
export interface PrRepoRow {
  path: string
  url: string | null
  slug: string | null
  /** ISO, or null when the remote has never been read. */
  checkedAt: string | null
  /** ISO of the last successful fetch, or null. */
  fetchedAt: string | null
  error: string | null
}

export function readPrRepos(store: Store): PrRepoRow[] {
  return store.db
    .select()
    .from(prRepos)
    .orderBy(sql`${prRepos.path} COLLATE NOCASE`)
    .all()
}

/**
 * Records what a repository's remote turned out to be.
 *
 * `fetchedAt` and `error` are deliberately not touched here: mapping a remote
 * and fetching from it are different acts, and a re-map must not look like a
 * successful fetch or wipe the explanation for a failed one.
 */
export function upsertPrRepo(
  store: Store,
  row: { path: string; url: string | null; slug: string | null; checkedAt?: string }
): void {
  const checkedAt = row.checkedAt ?? new Date().toISOString()
  store.db
    .insert(prRepos)
    .values({ path: row.path, url: row.url, slug: row.slug, checkedAt })
    .onConflictDoUpdate({
      target: prRepos.path,
      set: { url: row.url, slug: row.slug, checkedAt }
    })
    .run()
}

/** Marks a fetch. `error` null is a success and stamps `fetchedAt`. */
export function recordPrFetch(
  store: Store,
  paths: string[],
  outcome: { error: string | null; fetchedAt?: string }
): void {
  if (paths.length === 0) return
  const at = outcome.fetchedAt ?? new Date().toISOString()
  store.db
    .update(prRepos)
    // A failed pass leaves `fetchedAt` where it was, so the age caption keeps
    // describing the rows actually on screen rather than the moment Helm last
    // tried and got nowhere.
    .set(outcome.error === null ? { fetchedAt: at, error: null } : { error: outcome.error })
    .where(inArray(prRepos.path, paths))
    .run()
}

/** Drops rows for directories discovery no longer sees. */
export function forgetPrRepos(store: Store, keepPaths: string[]): number {
  const result =
    keepPaths.length === 0
      ? store.db.delete(prRepos).run()
      : store.db.delete(prRepos).where(notInArray(prRepos.path, keepPaths)).run()
  return result.changes
}

/**
 * A repository's open pull requests, replaced whole.
 *
 * Whole rather than merged, because the *absence* of a pull request is the
 * information: a PR that has been merged or closed since the last pass is
 * simply not in the new answer, and an upsert-only write would leave it on
 * screen for ever. So anything for this slug that the fetch did not return is
 * deleted in the same transaction.
 *
 * What survives is the cached `detail`. Dropping and re-inserting the rows
 * would be simpler and would throw away the conversation body on every
 * five-minute poll, so a pull request that is still open keeps its detail and
 * only its summary is rewritten.
 */
export function replaceRepoPulls(
  store: Store,
  slug: string,
  pulls: PullSummary[],
  fetchedAt: string = new Date().toISOString()
): void {
  const write = store.raw.transaction(() => {
    const numbers = pulls.map((pull) => pull.number)
    store.db
      .delete(pullRequests)
      .where(
        numbers.length === 0
          ? eq(pullRequests.slug, slug)
          : and(eq(pullRequests.slug, slug), notInArray(pullRequests.number, numbers))
      )
      .run()

    for (const pull of pulls) {
      store.db
        .insert(pullRequests)
        .values({ slug, number: pull.number, summary: pull, fetchedAt })
        .onConflictDoUpdate({
          target: [pullRequests.slug, pullRequests.number],
          set: { summary: pull, fetchedAt }
        })
        .run()
    }
  })
  write()
}

/** Every cached pull request, grouped by the slug it belongs to. */
export function readPullsBySlug(store: Store): Map<string, PullSummary[]> {
  const grouped = new Map<string, PullSummary[]>()
  for (const row of store.db.select().from(pullRequests).all()) {
    const held = grouped.get(row.slug) ?? []
    held.push(row.summary)
    grouped.set(row.slug, held)
  }
  // Sorted here rather than in SQL: the ordering is by a field inside the JSON
  // payload, and the fetch already ordered it - this only has to survive the
  // round trip through the table's own row order.
  for (const pulls of grouped.values()) {
    pulls.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }
  return grouped
}

/** One cached pull request, with whatever detail has been fetched for it. */
export interface PullRow {
  summary: PullSummary
  /** Null until the pull request has been opened at least once. */
  detail: PullDetail | null
  fetchedAt: string
  detailFetchedAt: string | null
}

export function readPull(store: Store, slug: string, number: number): PullRow | null {
  const row = store.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.slug, slug), eq(pullRequests.number, number)))
    .get()
  if (row === undefined) return null
  return {
    summary: row.summary,
    detail: row.detail ?? null,
    fetchedAt: row.fetchedAt,
    detailFetchedAt: row.detailFetchedAt
  }
}

/**
 * Caches what one pull request turned out to contain.
 *
 * An update and never an insert: a detail belongs to a pull request the list
 * fetch already found, and a row written here for a number no list returned
 * would be a pull request the pane can never show and the next
 * `replaceRepoPulls` would delete anyway. So a detail for an unknown pull
 * request changes nothing and says so, rather than half-creating a row with no
 * summary in it.
 */
export function writePullDetail(
  store: Store,
  slug: string,
  number: number,
  detail: PullDetail,
  detailFetchedAt: string = new Date().toISOString()
): boolean {
  const result = store.db
    .update(pullRequests)
    .set({ detail, detailFetchedAt })
    .where(and(eq(pullRequests.slug, slug), eq(pullRequests.number, number)))
    .run()
  return result.changes > 0
}
