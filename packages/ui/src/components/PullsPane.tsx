import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import { PR_STALE_DAYS, type PullRepo, type PullsSnapshot, type PullSummary } from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatMoment } from '../lib/time'
import { PullRequestIcon, RefreshIcon, WarnIcon } from './icons'
import { PullChecksTally, PullRow, PullStateDot, useNow } from './PullRow'

/**
 * Every open pull request across the repositories Helm scans.
 *
 * Grouped by **state of play** rather than by repository, which is the whole
 * shape of this pane. A developer with a dozen checkouts has open pull requests
 * in one or two of them; a list with a heading per repository spends most of its
 * height printing the names of repositories with nothing in them, and the two
 * rows that matter arrive below the fold. So the pull requests come first, each
 * carrying the repository it belongs to as a pill, and the repositories with
 * nothing open are named at the bottom as chips - present, checked, and taking
 * one line instead of eleven.
 *
 * That argument is about grouping that happens **on its own**, and it is why
 * `None` is still the default: grouping by repository is now a control, and a
 * control only spends height on headings when somebody asks it to. When they
 * do it is honoured literally, one-row groups included - a mode you chose
 * showing you a group of one is the mode working, where a threshold picking the
 * shape for you re-lays the list out between two polls.
 *
 * The Open section is split the same way the pane itself is split: by **state
 * of play**. `ACTIVE` is what has moved inside the `prStaleDays` cutoff and
 * `STALE` is what has not, collapsed to one-line chips under a caption saying
 * what stale means here. One rule decides the split and nothing else does -
 * a pull request with red CI that nobody has touched for three days is exactly
 * the row worth seeing, so the *signal* moves onto the chip (it keeps its state
 * dot and its check tally) rather than the *rule* growing a second clause. A
 * "stale unless red" rule would mean nobody could predict which section a row
 * is in. `updatedAt` is nullable and a null lands in ACTIVE: this surface never
 * files a row out of sight because it could not read a field. A cutoff of `0`
 * is off, and off is the single flat `Open` list this pane rendered before any
 * of this existed.
 *
 * **The filter and the grouping do not persist and are not settings.** They are
 * reactions to a list that changes hourly - you filter to find the one you came
 * for and the answer is stale an hour later - so they reset to empty and
 * `None`. The cutoff is the opposite and is the only piece of this that is a
 * preference: where a pull request stops being work in flight is a judgement
 * about your own working rhythm, so it lives in Settings as `prStaleDays`.
 *
 * **`compact` keeps the filter and the split and drops the `GROUP` control.**
 * Docked beside a session there is less height than anywhere else in the app,
 * grouping is the control that spends height on headings, and the filter is
 * worth more per pixel than any of the three: it removes rows rather than
 * rearranging them.
 *
 * No count on this pane may contradict what is on screen beside it. Section
 * counts follow the filter, the toolbar says `shown/total` while one is on, and
 * a filter matching nothing gets a sentence of its own rather than borrowing
 * "nothing open" - which would report a query as a fact about GitHub. The one
 * number that does **not** move is the header's `9 open`: that is a fact about
 * the server, where ACTIVE/STALE, the filter and the grouping are all Helm's
 * arrangement of it.
 *
 * Below those sit the repositories being ignored, as dashed chips. They are
 * there because the setting that hides them is not allowed to hide *itself*: a
 * pane that quietly showed eight repositories out of eleven would read as a
 * complete list, and the difference between "nothing is open" and "nobody
 * looked" is the whole of what this surface reports. Clicking one ticks it back
 * on. Only that direction - ignoring is a setting and lives in Settings with the
 * rest of them, and what belongs here is the undo, standing beside the thing it
 * undoes.
 *
 * What is different from every other list in Helm is the honesty. This one is a
 * mirror of something on a server, so it is **always** old, and the header says
 * how old in the same breath as it says how many: a count with no age is a claim
 * about right now that nothing here can make. When a fetch fails the rows stay
 * and the repository that failed is named with its reason - a captioned stale
 * list is worth more than an empty one, which is the opposite of the call the
 * usage figures make and for the opposite reason (a stale percentage is wrong; a
 * stale pull request merely happened a while ago).
 *
 * There is no detail beside the list and therefore no `PaneBack`: a pull request
 * opens in its own workspace tab rather than in a panel here.
 *
 * The row itself is `PullRow`, shared with the project pane. This is the list
 * that carries the repository pill on it, because this is the list whose rows
 * have been flattened out of their groups.
 */

export interface PullsPaneProps {
  /** Cache first, then whatever the fetch found. Null before the first read. */
  snapshot: PullsSnapshot | null
  /** No argument sweeps everything; a path checks one repository. */
  onRefresh: (repoPath?: string) => void
  refreshing: boolean
  /** A rejected `pr:refresh`, which is a different failure from a repo's own. */
  error?: string | null | undefined
  /** Opens the pull request. Absent leaves the rows inert rather than lying. */
  onOpenPull?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
  /**
   * Takes one repository back off the ignore list.
   *
   * Only this direction. Ignoring is a setting and lives in Settings → GitHub
   * with the rest of them; what belongs here is the *reveal*, because this is
   * the surface where the consequence of the setting is visible and a pane that
   * can only hide things is a pane you have to leave to undo them.
   */
  onUnignoreRepo?: ((slug: string) => void) | undefined
  /**
   * `prStaleDays`: how long a pull request may go untouched before it belongs
   * under STALE rather than ACTIVE. `0` is off - one flat `Open` list.
   *
   * Required rather than defaulted, deliberately. The default belongs to
   * `DEFAULT_SETTINGS` and nowhere else; a fallback here would be a second
   * place for it to be written down, and the one that goes stale silently.
   */
  staleDays: number
  /**
   * Docked beside a session split. The list is the whole pane either way; this
   * only drops the columns there is no longer room for - and the `GROUP`
   * control, which is the one that spends height on headings. See the file
   * comment.
   */
  compact?: boolean | undefined
}

/** "fetched 4m ago", or the sentence for a list nothing has ever filled. */
export function fetchedCaption(fetchedAtMs: number | null, now: number): string {
  if (fetchedAtMs === null) return 'not fetched yet'
  const age = formatAge(fetchedAtMs, now)
  return age === 'now' ? 'fetched just now' : `fetched ${age} ago`
}

/**
 * The sidebar's second line: a count, or the reason there is not one.
 *
 * A short form of each problem rather than the pane's full sentence. The pane
 * has a paragraph's width and can name the remedy; a 280px rail has room for
 * about four words, and a truncated instruction is worse than a label that
 * sends you to the pane to read it.
 */
export function pullsSummaryLine(snapshot: PullsSnapshot | null): string {
  if (snapshot === null) return 'Reading…'
  switch (snapshot.gh.problem?.kind) {
    case 'missing':
      return 'GitHub CLI not installed'
    case 'unauthenticated':
      return 'Run gh auth login'
    case 'offline':
      // Four words that name the connection and not the login. The rail is the
      // surface most likely to be read at a glance, so it is the one where
      // "GitHub could not be reached" must not be mistaken for a sign-in
      // problem the user is expected to go and fix.
      return 'GitHub unreachable · showing cached'
    case 'failed':
      return 'Last check failed'
    default:
      break
  }
  if (snapshot.repos.length === 0) {
    // The same distinction the pane's empty state draws, in four words: an
    // ignore list emptying this rail is not the machine having no GitHub
    // repositories on it - and neither is a sweep that has not got to them yet.
    if (snapshot.unmapped > 0) return 'Checking for repositories…'
    return snapshot.ignored.some((repo) => repo.present)
      ? 'All repositories ignored'
      : 'No github.com repositories'
  }
  const repos = snapshot.repos.length
  return `${String(snapshot.open)} open · ${String(repos)} ${repos === 1 ? 'repo' : 'repos'}`
}

/** One row's worth: the pull request, and which repository it came from. */
interface OpenPull {
  repo: PullRepo
  pull: PullSummary
}

/** What the `GROUP` control offers. Three, so it is a segmented control. */
const GROUP_MODES = [
  { id: 'none', label: 'None' },
  { id: 'repo', label: 'Repo' },
  { id: 'author', label: 'Author' }
] as const

type GroupMode = (typeof GROUP_MODES)[number]['id']

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
function matchesPull({ repo, pull }: OpenPull, query: string): boolean {
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

/** A labelled division of one section's rows. `label` is null for `None`. */
interface PullGroup {
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
function groupPulls(open: OpenPull[], mode: GroupMode, repos: readonly PullRepo[]): PullGroup[] {
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

/** What `STALE` means, in the words of the cutoff that decided it. */
function staleCaption(days: number): string {
  return days === 1 ? 'No motion in a day or more.' : `No motion in ${String(days)}+ days.`
}

export function PullsPane({
  snapshot,
  onRefresh,
  refreshing,
  error = null,
  onOpenPull,
  onUnignoreRepo,
  staleDays,
  compact = false
}: PullsPaneProps): JSX.Element {
  const now = useNow()
  // All three are the pane's own and none of them is written anywhere: a
  // filter and an arrangement are reactions to this hour's list, and the
  // section a user shut is a fact about the minute they shut it. The pane is
  // unmounted when another one is shown, so they reset by construction rather
  // than by anything having to remember to clear them.
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<GroupMode>('none')
  const [staleShown, setStaleShown] = useState(true)
  const repos = snapshot?.repos ?? []
  const problem = snapshot?.gh.problem ?? null

  // Only the ones a scanned project maps to. An ignored slug with no checkout
  // on this machine is hiding nothing from this list, so naming it here would
  // be a line about a repository the user cannot see either way; the settings
  // list carries those, because that is where they get removed.
  const ignored = (snapshot?.ignored ?? []).filter((repo) => repo.present)

  // Three buckets, and the middle one is why they are three rather than two: a
  // repository that could not be fetched is *not* a repository with nothing
  // open, and filing it under "quiet" would report a failure as good news.
  const open: OpenPull[] = repos.flatMap((repo) => repo.pulls.map((pull) => ({ repo, pull })))
  const failed = repos.filter((repo) => repo.error !== null)
  const quiet = repos.filter((repo) => repo.error === null && repo.pulls.length === 0)

  // Most recently touched first, across every repository at once - which is the
  // ordering the flattening exists for. `repos` arrives busiest-first and each
  // repo's pulls are already sorted, but neither of those orders one repo's
  // pull requests against another's.
  open.sort((a, b) => (b.pull.updatedAt ?? 0) - (a.pull.updatedAt ?? 0))

  // What survives the filter, and then how it divides. In that order, so no
  // count on screen can be about rows that are not: a section's number is the
  // number of rows under it, always.
  const shown = open.filter((entry) => matchesPull(entry, query))
  const split = staleDays !== PR_STALE_DAYS.off
  const cutoff = split ? now - staleDays * DAY_MS : null
  // A null `updatedAt` is a field that could not be read, not a pull request
  // nothing has happened to - so it stays in ACTIVE. This surface does not file
  // a row out of sight on the strength of something it does not know.
  const isStale = ({ pull }: OpenPull): boolean =>
    cutoff !== null && pull.updatedAt !== null && pull.updatedAt < cutoff
  const active = split ? shown.filter((entry) => !isStale(entry)) : shown
  const stale = split ? shown.filter(isStale) : []
  const filtering = query.trim() !== ''

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <header className="flex h-11 shrink-0 items-center gap-3 rounded-island border border-border bg-surface px-4">
        <PullRequestIcon width={15} height={15} className="shrink-0 text-accent" />
        <h1 className="text-[13px] font-medium tracking-tight text-fg">Pull requests</h1>
        {snapshot !== null && (
          <p data-pulls-caption className="min-w-0 truncate text-[11px] text-fg-subtle">
            <Count n={snapshot.open} one="open" many="open" /> ·{' '}
            <Count n={repos.length} one="repo" many="repos" /> ·{' '}
            {/* Mandatory, not decorative: see the file comment. */}
            <span className="text-fg-muted">{fetchedCaption(snapshot.fetchedAtMs, now)}</span>
          </p>
        )}
        <span className="flex-1" />
        <button
          type="button"
          data-pulls-refresh
          onClick={() => onRefresh()}
          disabled={refreshing}
          title={
            snapshot?.gh.path === null || snapshot?.gh.path === undefined
              ? 'Check every repository for open pull requests'
              : `Run ${snapshot.gh.path} against every repository`
          }
          aria-label="Check for open pull requests"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded text-fg-subtle transition-colors',
            'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
          )}
        >
          <RefreshIcon className={cn(refreshing && 'animate-spin')} />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-island border border-border bg-surface">
        {problem !== null && (
          <p
            data-pulls-problem={problem.kind}
            className={cn(
              'm-2 shrink-0 rounded-raised border px-3 py-2 text-[11.5px] leading-[1.55]',
              problem.kind === 'missing'
                ? 'border-border bg-surface-sunken text-fg-muted'
                : 'border-warn/30 bg-warn/10 text-warn'
            )}
          >
            {problem.message}
          </p>
        )}

        {error !== null && error !== undefined && (
          <p className="m-2 shrink-0 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
            {error}
          </p>
        )}

        {/* Above the list and outside the scroller, because a filter you have
            to scroll to reach is a filter you lose the moment you use it. It is
            about the Open section only, so it is absent when there is no list
            to work on - an empty pane offering two controls over nothing is
            furniture. */}
        {repos.length > 0 && (
          <div className="flex shrink-0 items-center gap-2 px-2 pt-2 pb-1.5">
            <input
              data-pulls-filter
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={compact ? 'Filter' : 'Filter by title, number, branch, author or repo'}
              spellCheck={false}
              aria-label="Filter pull requests"
              className={cn(
                'h-[26px] min-w-0 flex-1 rounded-well border border-border bg-surface-sunken px-2.5',
                'text-[12px] text-fg placeholder:text-fg-subtle select-text transition-colors',
                // The border *is* the focus indicator here (DESIGN.md 4), so
                // there is no offset ring on top of it.
                'hover:border-border-strong focus:border-accent focus:outline-none'
              )}
            />
            {/* The projects tree's `shown/total`, and it is here for the reason
                that one is: a filter that removes rows while the numbers around
                it stay still is a pane quietly lying about what it holds. */}
            {filtering && (
              <span
                data-pulls-filter-count={`${String(shown.length)}/${String(open.length)}`}
                className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle"
              >
                {shown.length}/{open.length}
              </span>
            )}
            {/* Dropped in `compact` rather than squeezed: grouping is the
                control that spends height on headings, and height is what a
                docked pane has least of. See the file comment. */}
            {!compact && (
              // A little further from the field than the count beside it: two
              // pieces of small grey text 8px apart read as one label, and
              // `3/12` belongs to the field while `GROUP` belongs to what
              // follows it.
              <div className="ml-1 flex shrink-0 items-center gap-1.5">
                <span
                  id="pulls-group-label"
                  className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase"
                >
                  Group
                </span>
                {/* A segmented control (DESIGN.md 4): a sunken well whose
                    chosen segment lifts. Three choices, which is inside the
                    two-to-four a segmented control is for. */}
                <div
                  role="group"
                  aria-labelledby="pulls-group-label"
                  className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
                >
                  {GROUP_MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      data-pulls-group={mode.id}
                      aria-pressed={group === mode.id}
                      onClick={() => setGroup(mode.id)}
                      className={cn(
                        'rounded-[5px] px-2.5 py-0.5 text-[11px] transition-colors',
                        group === mode.id ? SEGMENT_ON : 'text-fg-muted hover:text-fg'
                      )}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div
          role="group"
          aria-label="Open pull requests"
          className={cn(
            'min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2',
            // The toolbar above already stands off the island's edge; a second
            // 8px under it would read as a gap between two things.
            repos.length > 0 ? 'pt-0' : 'pt-2'
          )}
        >
          {repos.length === 0 ? (
            <Empty snapshot={snapshot} ignored={ignored.length} />
          ) : (
            <>
              {failed.length > 0 && (
                <Section name="failed" label="Could not fetch" count={failed.length}>
                  <div className="mt-1 flex flex-col gap-1">
                    {failed.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        data-pulls-repo-error={repo.slug ?? ''}
                        onClick={() => onRefresh(repo.path)}
                        title={`Try ${repo.slug ?? repo.name} again - ${repo.path}`}
                        className="flex w-full items-baseline gap-2 rounded-well px-2 py-1 text-left transition-colors hover:bg-hover"
                      >
                        <WarnIcon width={11} height={11} className="shrink-0 text-danger" />
                        <span className="shrink-0 text-[11.5px] text-fg">{repo.name}</span>
                        <span className="min-w-0 flex-1 truncate text-[10.5px] text-danger">
                          {repo.error}
                        </span>
                      </button>
                    ))}
                  </div>
                </Section>
              )}

              {open.length === 0 ? (
                <Section name="open" label="Open" count={0}>
                  <p data-pulls-empty="open" className="px-2 py-1.5 text-[11.5px] text-fg-subtle">
                    Nothing open in {repos.length === 1 ? 'this repository' : 'any of them'}.
                  </p>
                </Section>
              ) : shown.length === 0 ? (
                /* Its own sentence, and not "nothing open" - which would report
                   a query the user typed as a fact about GitHub. */
                <Section name="open" label="Open" count={0}>
                  <p data-pulls-empty="filter" className="px-2 py-1.5 text-[11.5px] text-fg-subtle">
                    Nothing open matches that.{' '}
                    <Count n={open.length} one="pull request is" many="pull requests are" /> hidden
                    by the filter.
                  </p>
                </Section>
              ) : !split ? (
                /* `prStaleDays: 0`. One section, the same heading, the same
                   flat recency order - the state this whole surface reverts to
                   when the cutoff is off. */
                <Section name="open" label="Open" count={shown.length}>
                  <PullGroups
                    groups={groupPulls(shown, group, repos)}
                    now={now}
                    compact={compact}
                    {...(onOpenPull ? { onOpen: onOpenPull } : {})}
                  />
                </Section>
              ) : (
                <>
                  <Section name="active" label="Active" count={active.length}>
                    {active.length === 0 ? (
                      <p
                        data-pulls-empty="active"
                        className="px-2 py-1.5 text-[11.5px] text-fg-subtle"
                      >
                        {/* "Everything open is below" is only true when
                            nothing is filtered out, so it is only said then. A
                            sentence that keeps claiming to account for the
                            whole list while a filter is on is the same lie a
                            count that does not follow the filter would be. */}
                        {staleDays === 1
                          ? 'Nothing has moved since yesterday.'
                          : `Nothing has moved in ${String(staleDays)} days.`}{' '}
                        {filtering ? 'What matches is below.' : 'Everything open is below.'}
                      </p>
                    ) : (
                      <PullGroups
                        groups={groupPulls(active, group, repos)}
                        now={now}
                        compact={compact}
                        {...(onOpenPull ? { onOpen: onOpenPull } : {})}
                      />
                    )}
                  </Section>

                  {stale.length > 0 && (
                    <Section
                      name="stale"
                      label="Stale"
                      count={stale.length}
                      caption={staleCaption(staleDays)}
                      action={
                        <button
                          type="button"
                          data-pulls-stale-toggle={staleShown ? 'shown' : 'hidden'}
                          aria-expanded={staleShown}
                          onClick={() => setStaleShown((was) => !was)}
                          title={
                            staleShown
                              ? 'Collapse the stale pull requests'
                              : 'Show the stale pull requests again'
                          }
                          className="rounded-well px-1.5 py-0.5 text-[10.5px] text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                        >
                          {staleShown ? 'Hide' : 'Show'}
                        </button>
                      }
                    >
                      {/* Chips rather than rows, which is the whole point of the
                          section: a stale pull request is worth a line, not
                          two. What it keeps is the state dot and the check
                          tally - see the file comment on why the signal moves
                          onto the chip instead of the rule growing a clause. */}
                      {staleShown && (
                        <StaleGroups
                          groups={groupPulls(stale, group, repos)}
                          now={now}
                          {...(onOpenPull ? { onOpen: onOpenPull } : {})}
                        />
                      )}
                    </Section>
                  )}
                </>
              )}

              {quiet.length > 0 && (
                <Section
                  name="quiet"
                  label="Quiet repos"
                  count={quiet.length}
                  caption="Checked, nothing open."
                >
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {quiet.map((repo) => (
                      <button
                        key={repo.path}
                        type="button"
                        data-pulls-repo={repo.slug ?? ''}
                        onClick={() => onRefresh(repo.path)}
                        title={`Check ${repo.slug ?? repo.name} for pull requests now - ${repo.path}`}
                        className={cn(
                          'flex max-w-full items-baseline gap-1.5 rounded-well border border-border px-2 py-1',
                          'text-[11.5px] text-fg-muted transition-colors hover:border-border-strong hover:bg-hover hover:text-fg'
                        )}
                      >
                        <span className="min-w-0 truncate">{repo.name}</span>
                        {!compact && repo.slug !== null && (
                          <span className="min-w-0 truncate font-mono text-[10px] text-fg-subtle">
                            {repo.slug}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {/* Outside the ternary above, deliberately: a machine where every
              github.com repository is ignored has an empty `repos` and still
              has to show what it is ignoring - otherwise the pane explains its
              own emptiness with a list of the reasons for it missing. */}
          {ignored.length > 0 && (
            <Section
              name="ignored"
              label="Ignored"
              count={ignored.length}
              caption={
                onUnignoreRepo === undefined
                  ? 'Not fetched.'
                  : 'Not fetched. Click one to start again.'
              }
            >
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {ignored.map((repo) => (
                  <button
                    key={repo.slug}
                    type="button"
                    data-pulls-ignored={repo.slug}
                    disabled={onUnignoreRepo === undefined}
                    onClick={() => onUnignoreRepo?.(repo.slug)}
                    title={`Fetch pull requests from ${repo.slug} again`}
                    className={cn(
                      'flex max-w-full items-baseline gap-1.5 rounded-well border border-dashed border-border-strong px-2 py-1',
                      'text-[11.5px] text-fg-subtle transition-colors',
                      onUnignoreRepo === undefined
                        ? 'cursor-default'
                        : 'hover:border-solid hover:bg-hover hover:text-fg'
                    )}
                  >
                    <span className="min-w-0 truncate">{repo.name}</span>
                    {!compact && (
                      <span className="min-w-0 truncate font-mono text-[10px] text-fg-subtle/70">
                        {repo.slug}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A named division of the list: the caps label, a count, and an optional
 * sentence that says what the section means.
 *
 * The count sits in the label rather than pinned right, because these sections
 * are read as headings of a page rather than as rows of a table - and a number
 * at the far end of an empty 1200px line belongs to nothing.
 */
function Section({
  name,
  label,
  count,
  caption,
  action,
  children
}: {
  /** Stable identity for a driver, since the labels are prose and move. */
  name: string
  label: string
  count: number
  caption?: string
  /**
   * A control belonging to the whole section, pinned right.
   *
   * The count above stays in the label and this does not, and the two are not
   * in tension: a number is *read*, so it belongs where the reading is, and a
   * control is *reached*, so it belongs where the pointer expects one. Pinning
   * the count right would leave a digit at the end of an empty line belonging
   * to nothing; pinning the control right is where every other row in the app
   * puts one.
   */
  action?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <section data-pulls-section={name} className="mb-3 last:mb-0">
      <h2 className="flex items-baseline gap-2 px-2">
        <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          {label}
        </span>
        <span data-pulls-count className="text-[10px] tabular-nums text-fg-subtle/70">
          {count}
        </span>
        {caption !== undefined && (
          <span className="min-w-0 truncate text-[11px] text-fg-subtle">{caption}</span>
        )}
        {action !== undefined && (
          <>
            <span className="flex-1" />
            {action}
          </>
        )}
      </h2>
      {children}
    </section>
  )
}

/**
 * One section's pull requests as rows, under whatever headings the mode calls
 * for.
 *
 * `None` arrives here as a single unlabelled group, so there is one render path
 * rather than a branch per mode: which rows go together is `groupPulls`'s
 * business, and what a group looks like is this one's.
 */
function PullGroups({
  groups,
  now,
  compact,
  onOpen
}: {
  groups: PullGroup[]
  now: number
  compact: boolean
  onOpen?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
}): JSX.Element {
  return (
    <div className="mt-0.5">
      {groups.map((group, at) => (
        <div key={group.key} className={cn(group.label !== null && at > 0 && 'mt-2')}>
          {group.label !== null && (
            <GroupHeading
              label={group.label}
              sub={group.sub}
              bot={group.bot}
              count={group.items.length}
            />
          )}
          {group.items.map(({ repo, pull }) => (
            <PullRow
              key={`${repo.path}#${String(pull.number)}`}
              repo={repo}
              pull={pull}
              now={now}
              compact={compact}
              showRepo={!group.namesRepo}
              {...(onOpen ? { onOpen } : {})}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The same arrangement, painted as one-line chips.
 *
 * No `compact` here, unlike the rows: a chip is already the reduced form and
 * has nothing left to drop. Where the pane is narrow the titles truncate.
 */
function StaleGroups({
  groups,
  now,
  onOpen
}: {
  groups: PullGroup[]
  now: number
  onOpen?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
}): JSX.Element {
  return (
    <div className="mt-1.5">
      {groups.map((group, at) => (
        <div key={group.key} className={cn(group.label !== null && at > 0 && 'mt-2')}>
          {group.label !== null && (
            <GroupHeading
              label={group.label}
              sub={group.sub}
              bot={group.bot}
              count={group.items.length}
            />
          )}
          <div className="flex flex-wrap gap-1.5">
            {group.items.map(({ repo, pull }) => (
              <StaleChip
                key={`${repo.path}#${String(pull.number)}`}
                repo={repo}
                pull={pull}
                now={now}
                // Only a heading naming the repository takes it off the chip.
                // Not `compact`: this is the flattened list, so the repository
                // is what says which list a row came out of (DESIGN.md's
                // source-pill rule), and it is the last thing to drop when the
                // pane narrows - the title truncates instead. Two repositories
                // with the same branch convention produce identical titles.
                showRepo={!group.namesRepo}
                {...(onOpen ? { onOpen } : {})}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * A group's name, one step quieter than the section heading above it.
 *
 * Sentence case rather than the section's caps: these are names of things - a
 * repository, a person - where ACTIVE and STALE are labels Helm invented, and
 * the two must not read as the same rank. The count sits immediately after the
 * name for the reason `Section`'s does, and the slug follows both rather than
 * coming between them: a number after `owner/name` reads as part of the slug.
 */
function GroupHeading({
  label,
  sub,
  bot,
  count
}: {
  label: string
  sub: string | null
  bot: boolean
  count: number
}): JSX.Element {
  return (
    <div data-pulls-group-heading={label} className="flex items-baseline gap-1.5 px-2 pt-1 pb-0.5">
      <span className="min-w-0 truncate text-[11px] text-fg-muted">{label}</span>
      {bot && <span className="shrink-0 text-[10px] text-fg-subtle opacity-70">bot</span>}
      <span data-pulls-group-count className="text-[10px] tabular-nums text-fg-subtle/70">
        {count}
      </span>
      {sub !== null && (
        <span className="min-w-0 truncate font-mono text-[10px] text-fg-subtle/70">{sub}</span>
      )}
    </div>
  )
}

/**
 * A stale pull request, in one line.
 *
 * The same record as `PullRow` and deliberately the same identity -
 * `data-pull`, the state dot, the check tally - because it is the same pull
 * request and clicking it opens the same tab. What it drops is everything that
 * is only useful while you are working on one: the diff stat, the branch pair,
 * the review decision. What it keeps is what says whether it should have been
 * left alone this long.
 */
function StaleChip({
  repo,
  pull,
  now,
  showRepo,
  onOpen
}: {
  repo: PullRepo
  pull: PullSummary
  now: number
  showRepo: boolean
  onOpen?: ((repo: PullRepo, pull: PullSummary) => void) | undefined
}): JSX.Element {
  const age = pull.updatedAt === null ? null : formatAge(pull.updatedAt, now)
  return (
    <button
      type="button"
      data-pull={`${repo.slug ?? ''}#${String(pull.number)}`}
      data-pull-stale=""
      disabled={onOpen === undefined}
      onClick={() => onOpen?.(repo, pull)}
      title={
        pull.updatedAt === null
          ? pull.title
          : `${pull.title} - updated ${formatMoment(pull.updatedAt)}`
      }
      className={cn(
        'flex max-w-[min(100%,28rem)] items-baseline gap-1.5 rounded-well border border-border px-2 py-1',
        'text-left transition-colors',
        onOpen === undefined
          ? 'cursor-default'
          : 'hover:border-border-strong hover:bg-hover'
      )}
    >
      <PullStateDot isDraft={pull.isDraft} />
      <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
        #{pull.number}
      </span>
      <span className="min-w-0 truncate text-[11.5px] text-fg-muted">{pull.title}</span>
      {showRepo && (
        <span className="min-w-0 max-w-[8rem] shrink-0 truncate text-[10.5px] text-fg-subtle">
          {repo.name}
        </span>
      )}
      {age !== null && (
        <>
          <span aria-hidden className="shrink-0 text-[10.5px] text-fg-subtle/50">
            ·
          </span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-fg-subtle">{age}</span>
        </>
      )}
      {pull.checks !== null && pull.checks.total > 0 && (
        <span className="shrink-0 text-[10.5px]">
          <PullChecksTally checks={pull.checks} />
        </span>
      )}
    </button>
  )
}

/**
 * Why the list is empty, which is six different facts.
 *
 * "No pull requests", "no GitHub repositories", "nobody has looked yet",
 * "everything is ignored", "no gh" and "not signed in" are not the same
 * situation, and a single empty state would make the first five look like the
 * last. Two of them would otherwise be outright lies. A machine whose only
 * github.com repository is ignored would be told none of its folders has a
 * github.com origin - a fact about the user's own setting reported as a fact
 * about their disk. And a fresh install, whose remotes have not been read yet,
 * was told the same thing about folders nothing had opened: `unmapped` is what
 * separates "checked, and none of them is on GitHub" from "still checking".
 */
function Empty({
  snapshot,
  ignored
}: {
  snapshot: PullsSnapshot | null
  ignored: number
}): JSX.Element {
  if (snapshot === null) {
    return <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">Reading&hellip;</p>
  }
  if (snapshot.gh.problem === null && snapshot.unmapped > 0) {
    // Before the problem branch only in the sense that there is no problem yet:
    // a sweep still reading remotes has concluded nothing about anything.
    return (
      <p data-pulls-mapping className="px-3 py-6 text-center text-[12px] text-fg-subtle">
        Checking {snapshot.unmapped === 1 ? 'one folder' : `${String(snapshot.unmapped)} folders`}{' '}
        for a github.com remote&hellip;
      </p>
    )
  }
  if (snapshot.gh.problem !== null) {
    // The sentence is already above the list; repeating it here would say the
    // same thing twice on one screen.
    return <p className="px-3 py-6 text-center text-[12px] text-fg-subtle">Nothing has been fetched.</p>
  }
  if (ignored > 0) {
    // Short, and with no icon: the chips saying which ones are directly below
    // this, so the remedy is already on screen and does not need spelling out.
    return (
      <p className="px-3 py-6 text-center text-[12px] text-fg-muted">
        {ignored === 1
          ? 'The only github.com repository Helm scans is ignored.'
          : `All ${String(ignored)} github.com repositories Helm scans are ignored.`}
      </p>
    )
  }
  return (
    <div className="px-6 py-8 text-center">
      <PullRequestIcon width={22} height={22} className="mx-auto text-fg-subtle" />
      <p className="mt-3 text-[12.5px] text-fg-muted">
        {snapshot.checked === 0
          ? 'Helm is not scanning any folders yet.'
          : `None of the ${String(snapshot.checked)} folders Helm scans has a github.com origin.`}
      </p>
      <p className="mt-2 text-[11.5px] leading-relaxed text-fg-subtle">
        A repository appears here once its <code className="font-mono">origin</code> remote points
        at github.com. Other forges are not fetched.
      </p>
    </div>
  )
}

function Count({ n, one, many }: { n: number; one: string; many: string }): JSX.Element {
  return (
    <span className="tabular-nums">
      {n.toLocaleString()} {n === 1 ? one : many}
    </span>
  )
}
