import { PR_STALE_DAYS, type PullRepo, type PullSummary } from '@helm/core/types'

/**
 * How the Pulls pane arranges the open pull requests: the order, the filter,
 * the ACTIVE/STALE split and the `GROUP` control. Pure, so the arrangement can
 * be tested without the pane - the pane's file comment says why each rule is
 * the rule.
 */

/** One row's worth: the pull request, and which repository it came from. */
export interface OpenPull {
  repo: PullRepo
  pull: PullSummary
}

/** What the `GROUP` control offers. Three, so it is a segmented control. */
export const GROUP_MODES = [
  { id: 'none', label: 'None' },
  { id: 'repo', label: 'Repo' },
  { id: 'author', label: 'Author' }
] as const

export type GroupMode = (typeof GROUP_MODES)[number]['id']

/**
 * Every open pull request across the repositories, flattened.
 *
 * Most recently touched first, across every repository at once - which is the
 * ordering the flattening exists for. `repos` arrives busiest-first and each
 * repo's pulls are already sorted, but neither of those orders one repo's
 * pull requests against another's.
 */
export function openPulls(repos: readonly PullRepo[]): OpenPull[] {
  const open: OpenPull[] = repos.flatMap((repo) => repo.pulls.map((pull) => ({ repo, pull })))
  open.sort((a, b) => (b.pull.updatedAt ?? 0) - (a.pull.updatedAt ?? 0))
  return open
}

/**
 * The filter, as one predicate over everything a row shows.
 *
 * The projects tree's behaviour rather than a second one of this pane's own: a
 * case-insensitive substring, an empty query matching everything, and no
 * syntax to learn. What differs is the set of fields, because the rows differ -
 * a pull request is found by its number at least as often as by its title, so
 * both `418` and `#418` find pull request 418, and the branch, the author and
 * the repository are all things somebody types when they know the row exists
 * and cannot see it.
 */
export function matchesPull({ repo, pull }: OpenPull, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const fields = [
    pull.title,
    String(pull.number),
    `#${String(pull.number)}`,
    pull.headRefName,
    pull.baseRefName,
    pull.author,
    repo.name,
    repo.slug ?? ''
  ]
  return fields.some((field) => field.toLowerCase().includes(needle))
}

/** Days as milliseconds. The one place this pane does date arithmetic. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The Open section, split at `prStaleDays`, or not split at all when it is off.
 *
 * A null `updatedAt` is a field that could not be read, not a pull request
 * nothing has happened to - so it stays in ACTIVE. This surface does not file
 * a row out of sight on the strength of something it does not know.
 */
export function splitStale(
  shown: OpenPull[],
  staleDays: number,
  now: number
): { split: boolean; active: OpenPull[]; stale: OpenPull[] } {
  const split = staleDays !== PR_STALE_DAYS.off
  const cutoff = split ? now - staleDays * DAY_MS : null
  const isStale = ({ pull }: OpenPull): boolean =>
    cutoff !== null && pull.updatedAt !== null && pull.updatedAt < cutoff
  return {
    split,
    active: split ? shown.filter((entry) => !isStale(entry)) : shown,
    stale: split ? shown.filter(isStale) : []
  }
}

/** A labelled division of one section's rows. `label` is null for `None`. */
export interface PullGroup {
  key: string
  label: string | null
  /** The machine spelling beside the name - a slug, or nothing. */
  sub: string | null
  /** The group is a bot's, which is a fact about it and not part of its name. */
  bot: boolean
  /**
   * The heading already names the repository, so the rows under it must not.
   *
   * DESIGN.md's source-pill rule: the pill appears only where rows have been
   * flattened out of their groups. Grouping by repository puts them back into
   * theirs, and a pill on every row would be the heading said once per row.
   */
  namesRepo: boolean
  items: OpenPull[]
}

/**
 * The rows, arranged the way the `GROUP` control says.
 *
 * `None` returns the flat list as one unlabelled group, so every section below
 * renders through one path rather than branching on the mode - the difference
 * between the modes is this function's business and not the pane's.
 *
 * Repository order comes from `repos`, which arrives busiest-first from core,
 * so the grouping needs no second pass to know which repository to put first.
 * Authors have no such order to borrow, so they are counted here: most pull
 * requests first, ties by name, which is the same "busiest first" claim made
 * about the other axis.
 */
export function groupPulls(open: OpenPull[], mode: GroupMode, repos: readonly PullRepo[]): PullGroup[] {
  if (mode === 'none' || open.length === 0) {
    return [{ key: 'all', label: null, sub: null, bot: false, namesRepo: false, items: open }]
  }
  if (mode === 'repo') {
    return repos
      .map((repo) => ({
        key: repo.path,
        label: repo.name,
        sub: repo.slug,
        bot: false,
        namesRepo: true,
        items: open.filter((entry) => entry.repo.path === repo.path)
      }))
      .filter((group) => group.items.length > 0)
  }
  const byAuthor = new Map<string, OpenPull[]>()
  for (const entry of open) {
    const key = displayAuthor(entry.pull)
    const held = byAuthor.get(key)
    if (held === undefined) byAuthor.set(key, [entry])
    else held.push(entry)
  }
  return [...byAuthor.entries()]
    .sort(([aName, aItems], [bName, bItems]) =>
      aItems.length === bItems.length
        ? aName.localeCompare(bName)
        : bItems.length - aItems.length
    )
    .map(([name, items]) => ({
      key: `author:${name}`,
      label: name,
      sub: null,
      // A bot says so beside its name rather than in it, exactly as the row
      // does: `app/dependabot` is a login, and "bot" is the fact about it.
      bot: items[0]?.pull.authorIsBot === true,
      namesRepo: false,
      items
    }))
}

/** The author as a row paints it - a bot's `app/` prefix is not its name. */
function displayAuthor(pull: PullSummary): string {
  return pull.authorIsBot ? pull.author.replace(/^app\//, '') : pull.author
}
