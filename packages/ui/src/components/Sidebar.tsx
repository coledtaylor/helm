import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { DiscoveryResult, Harness, Project } from '@helm/core'
import { isProjectPinned } from '@helm/core/types'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { baseName, MissingProjectRow, ProjectRow } from './ProjectRow'
import {
  BookIcon,
  CaretIcon,
  HarnessIcon,
  HistoryIcon,
  PinIcon,
  PlusIcon,
  PullRequestIcon,
  RefreshIcon,
  SlidersIcon,
  TerminalIcon
} from './icons'

export interface SidebarProps {
  /**
   * Saved profiles, above the tree. The launcher shows both (SPEC 4.1) and they
   * are one scroll container's worth of sidebar, not two panels - so the list
   * is passed in rather than reimplemented here, and this component keeps
   * knowing only about discovery.
   */
  profiles?: ReactNode | undefined
  /** Opens the session-history pane. */
  onOpenHistory?: (() => void) | undefined
  /** Sessions the index holds, and how many of them can still be reopened. */
  historyCount?: number | undefined
  historyResumable?: number | undefined
  /** True while the history pane is the tab on screen. */
  historyActive?: boolean | undefined
  /** Opens the pull-request pane. */
  onOpenPulls?: (() => void) | undefined
  /**
   * Its second line, composed by the caller: a count when there is one and a
   * short reason when there is not (`pullsSummaryLine`). Composed there rather
   * than here because it is a fact about a fetch, not about the tree.
   */
  pullsDetail?: string | undefined
  pullsActive?: boolean | undefined
  /** Opens the config console. The pane keeps its own scope. */
  onOpenConfig?: (() => void) | undefined
  configActive?: boolean | undefined
  /** Opens the content viewer. The pane keeps its own scope. */
  onOpenContent?: (() => void) | undefined
  contentActive?: boolean | undefined
  discovery: DiscoveryResult | null
  scanning: boolean
  scanError?: string | undefined
  selectedPath: string | null
  /**
   * Lower-cased project path -> what the sessions running there are called: the
   * green dots, and the names behind them.
   *
   * A map rather than the set of paths this used to be, because the dot is the
   * one place the tree admits a session exists and "a session is running here"
   * is no answer at all once three of them are. The names come from the caller
   * already resolved through `sessionLabel`, so a session renamed in the strip
   * is renamed here too rather than in one place out of two.
   */
  liveSessions?: ReadonlyMap<string, readonly string[]> | undefined
  /**
   * `pinnedProjects`, straight off the settings. Projects only - a harness is
   * not pinnable, and nothing here offers to make one so.
   *
   * Required rather than optional, unlike the pane entry points above: those
   * are features a sidebar can be built without, and this one is a rule about
   * where every project row is drawn. A caller that forgot it would silently
   * print pinned projects back inside their harness groups.
   */
  pinnedPaths: readonly string[]
  /** Star pressed. The caller owns the list; this only says which path moved. */
  onTogglePin: (path: string) => void
  onSelect: (project: Project) => void
  onRescan: () => void
  onAddRoot: () => void
  /**
   * Scaffold a harness. Deliberately not first-run-only: someone who starts
   * with one folder of repos and later wants a second workspace should not have
   * to reinstall to get the action back.
   */
  onCreateHarness?: (() => void) | undefined
}

interface Group {
  key: string
  harness: Harness | null
  root: Project | null
  members: Project[]
}

/**
 * One entry of the Pinned section: the path that was pinned, and the project
 * discovery found at it - or null, for a path that no longer resolves.
 */
interface Pin {
  path: string
  project: Project | null
  /** What the row is called and what the section sorts by. */
  name: string
}

/**
 * The pinned paths, resolved against the current scan.
 *
 * Flat and cross-harness on purpose: escaping the grouping is the whole point,
 * so this is one list however many harnesses the projects came out of. Sorted
 * by **name** rather than by path, which is where it differs from the stored
 * value - a list ordered by path is a list ordered by harness, which is the
 * arrangement the section exists to get out of.
 *
 * A path with nothing behind it keeps its place. Discovery does not return a
 * directory that is not there, and dropping the row would turn "this drive is
 * not plugged in" into "your pin is gone".
 */
function resolvePins(discovery: DiscoveryResult | null, pinned: readonly string[]): Pin[] {
  const byPath = new Map<string, Project>()
  for (const project of discovery?.projects ?? []) byPath.set(project.path.toLowerCase(), project)

  return pinned
    .map((path) => {
      const project = byPath.get(path.toLowerCase()) ?? null
      return { path, project, name: project?.name ?? baseName(path) }
    })
    .sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.path.toLowerCase().localeCompare(b.path.toLowerCase())
    )
}

/**
 * The harness tree, with the pinned projects taken out of it.
 *
 * Taken out rather than marked: a pinned project printed in both places is two
 * rows for one project, which is the thing a section for the ones you actually
 * open cannot afford. The comparison is `isProjectPinned`'s, which is the same
 * `toLowerCase` the harness map below keys on - one normalisation, so the
 * section and the group it lifts a project out of cannot disagree.
 */
function groupProjects(discovery: DiscoveryResult | null, pinned: readonly string[]): Group[] {
  if (!discovery) return []

  const byHarness = new Map<string, Group>()
  const loose: Project[] = []

  for (const harness of discovery.harnesses) {
    byHarness.set(harness.path.toLowerCase(), {
      key: harness.path,
      harness,
      root: null,
      members: []
    })
  }

  for (const project of discovery.projects) {
    if (isProjectPinned(pinned, project.path)) continue
    if (project.harnessPath === null) {
      loose.push(project)
      continue
    }
    const group = byHarness.get(project.harnessPath.toLowerCase())
    if (!group) {
      loose.push(project)
      continue
    }
    if (project.kind === 'harness') group.root = project
    else group.members.push(project)
  }

  const groups = [...byHarness.values()]
  if (loose.length > 0) {
    groups.push({ key: '__loose__', harness: null, root: null, members: loose })
  }
  return groups
}

/**
 * The filter, as one predicate over a name and a path.
 *
 * Taken apart from `matches` so the Pinned section can use the same one: a
 * pinned row whose folder has gone has a path and a basename and no `Project`,
 * and a section that ignored the filter would leave rows on screen under a
 * query that excludes them.
 */
function matchesText(name: string, path: string, query: string): boolean {
  if (query === '') return true
  const needle = query.toLowerCase()
  return name.toLowerCase().includes(needle) || path.toLowerCase().includes(needle)
}

function matches(project: Project, query: string): boolean {
  return matchesText(project.name, project.path, query)
}

export function Sidebar({
  profiles,
  onOpenHistory,
  historyCount,
  historyResumable,
  historyActive = false,
  onOpenPulls,
  pullsDetail,
  pullsActive = false,
  onOpenConfig,
  configActive = false,
  onOpenContent,
  contentActive = false,
  discovery,
  scanning,
  scanError,
  selectedPath,
  liveSessions,
  pinnedPaths,
  onTogglePin,
  onSelect,
  onRescan,
  onAddRoot,
  onCreateHarness
}: SidebarProps): JSX.Element {
  const [query, setQuery] = useState('')
  // Only the harnesses someone has deliberately shut are in here. Absent means
  // open, so a harness discovered after this render starts expanded rather than
  // hidden behind a key nothing has written yet.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const groups = useMemo(() => groupProjects(discovery, pinnedPaths), [discovery, pinnedPaths])
  const pins = useMemo(() => resolvePins(discovery, pinnedPaths), [discovery, pinnedPaths])

  const filtered = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          // A harness root that does not match itself is kept as long as one of
          // its repos does, so filtering never orphans a visible child.
          root: group.root && matches(group.root, query) ? group.root : null,
          members: group.members.filter((p) => matches(p, query))
        }))
        .filter((group) => group.root !== null || group.members.length > 0),
    [groups, query]
  )

  // Filtered like any other row. A section that ignored the query would sit
  // above the tree still showing what the query just excluded.
  const shownPins = useMemo(
    () => pins.filter((pin) => matchesText(pin.name, pin.path, query)),
    [pins, query]
  )

  const total = discovery?.projects.length ?? 0
  // Both counts are about projects discovery found, so a pinned path that no
  // longer resolves is in neither - it is a row on screen and not a project in
  // the tree. The Pinned heading carries its own count, which does include it.
  const shown =
    filtered.reduce((n, g) => n + g.members.length + (g.root ? 1 : 0), 0) +
    shownPins.filter((pin) => pin.project !== null).length
  const harnessCount = discovery?.harnesses.length ?? 0

  const toggle = (key: string): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // A filter that hides its own matches is a filter that looks broken, so
  // searching opens every group it matched.
  const isExpanded = (key: string): boolean => query !== '' || !collapsed.has(key)

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col overflow-hidden rounded-island border border-border bg-surface">
      {/* The rows that are about the whole machine rather than about anything
          configured in Helm. "Where did I do that thing last week" starts a
          session at least as often as picking a project does, and Config and
          Content ask machine-wide questions too - each of those panes carries
          its own scope switcher, so neither needs a harness to hang off and
          neither can be hidden by a collapsed group or an empty tree. */}
      <div className="shrink-0 space-y-0.5 p-2 pb-1.5">
        {onOpenHistory && (
          <GlobalLink
            icon={<HistoryIcon width={13} height={13} />}
            label="Session history"
            detail={
              historyCount === undefined
                ? 'Reading…'
                : `${historyCount.toLocaleString()} sessions · ${String(historyResumable ?? 0)} resumable`
            }
            title="Every Claude Code session on this machine"
            active={historyActive}
            onClick={onOpenHistory}
            data-open-history
          />
        )}
        {/* Under Session history, and the second row with a fact worth a
            second line: how many pull requests are waiting is the whole reason
            to come here, and when there are none it says why not. */}
        {onOpenPulls && (
          <GlobalLink
            icon={<PullRequestIcon width={13} height={13} />}
            label="Pull requests"
            detail={pullsDetail ?? 'Reading…'}
            title="Open pull requests across every repository Helm scans"
            active={pullsActive}
            onClick={onOpenPulls}
            data-open-pulls
          />
        )}
        {onOpenConfig && (
          <GlobalLink
            icon={<SlidersIcon width={13} height={13} />}
            label="Config"
            title="Browse and edit any .claude configuration"
            active={configActive}
            onClick={onOpenConfig}
            data-open-config
          />
        )}
        {onOpenContent && (
          <GlobalLink
            icon={<BookIcon width={13} height={13} />}
            label="Content"
            title="Notes, docs, skills and artifacts"
            active={contentActive}
            onClick={onOpenContent}
            data-open-content
          />
        )}
      </div>

      <div aria-hidden className="island-rule mx-3 my-0.5" />
      {profiles}
      <div aria-hidden className="island-rule mx-3 my-0.5" />

      <header className="flex h-9 shrink-0 items-center gap-1.5 px-3.5">
        <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          Harnesses
        </span>
        <span className="text-[10px] tabular-nums text-fg-subtle">{harnessCount}</span>
        <span className="flex-1" />
        <span className="mr-0.5 truncate text-[9.5px] tabular-nums text-fg-subtle">
          {query === '' ? `${String(total)} projects` : `${String(shown)}/${String(total)}`}
        </span>
        <IconButton label="Rescan all roots" onClick={onRescan} disabled={scanning}>
          <RefreshIcon width={12} height={12} className={cn(scanning && 'animate-spin')} />
        </IconButton>
        {onCreateHarness && (
          <IconButton label="Create a new harness" onClick={onCreateHarness} data-create-harness>
            <HarnessIcon width={12} height={12} />
          </IconButton>
        )}
        <IconButton label="Add a folder to scan" onClick={onAddRoot} data-add-root>
          <PlusIcon width={12} height={12} />
        </IconButton>
      </header>

      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          spellCheck={false}
          aria-label="Filter projects"
          className={cn(
            'h-[26px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12px]',
            'text-fg placeholder:text-fg-subtle select-text',
            'focus:border-accent focus:outline-none'
          )}
        />
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {scanError !== undefined && (
          <p className="mb-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
            {scanError}
          </p>
        )}

        {/* Above the groups, because the point of a pin is not to have to find
            the harness first. Not a collapsible group and deliberately not
            shaped like one: no caret, and the label sits at `fg-subtle` where a
            harness header sits at `fg`. A section that looked like a harness
            would be a section that reads as a pinnable harness, and harnesses
            are not pinnable. */}
        {shownPins.length > 0 && (
          <section data-pinned-section className="mb-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <PinIcon width={9} height={9} className="shrink-0 text-fg-subtle" />
              <span className="text-[10.5px] leading-[13px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
                Pinned
              </span>
              <span className="text-[9.5px] leading-[13px] tabular-nums text-fg-subtle">
                {shownPins.length}
              </span>
            </div>

            <div className="pl-1.5">
              {shownPins.map((pin) =>
                pin.project === null ? (
                  <MissingProjectRow key={pin.path} path={pin.path} onTogglePin={onTogglePin} />
                ) : (
                  <ProjectRow
                    key={pin.path}
                    project={pin.project}
                    pinned
                    selected={pin.project.path === selectedPath}
                    liveNames={liveSessions?.get(pin.project.path.toLowerCase())}
                    onSelect={onSelect}
                    onTogglePin={(project) => onTogglePin(project.path)}
                  />
                )
              )}
            </div>
          </section>
        )}

        {filtered.length === 0 ? (
          shownPins.length === 0 && (
            <EmptyState
              scanning={scanning}
              filtering={query !== '' && total > 0}
              hasRoots={(discovery?.roots.length ?? 0) > 0}
              onAddRoot={onAddRoot}
            />
          )
        ) : (
          filtered.map((group, index) => {
            // Sessions, not projects-with-a-session. The count's own tooltip has
            // always said "N sessions running here", and with the labels in hand
            // it can be that rather than an undercount of it.
            const live = group.members
              .concat(group.root ? [group.root] : [])
              .reduce((n, p) => n + (liveSessions?.get(p.path.toLowerCase())?.length ?? 0), 0)
            return (
              <HarnessGroup
                key={group.key}
                group={group}
                // The rule the divider follows is "not first on screen", so a
                // Pinned section above takes the first group's exemption with
                // it - otherwise the section's own rule and the group's are two
                // hairlines with nothing between them.
                first={index === 0 && shownPins.length === 0}
                expanded={isExpanded(group.key)}
                running={live}
                onToggle={() => toggle(group.key)}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onTogglePin={onTogglePin}
                {...(liveSessions ? { liveSessions } : {})}
              />
            )
          })
        )}
      </nav>
    </aside>
  )
}

/**
 * One harness and the projects inside it.
 *
 * The header is a label and a disclosure, not a project: the harness root is
 * still listed as the first row inside, because it is a directory a session can
 * start in and losing that would cost a capability to gain a tidier tree.
 *
 * It carries no star, and that is the decision rather than an omission. Only
 * projects are pinnable: a pinned harness is very nearly the collapse state
 * this header already has, and one pin kind means there is no rule to invent
 * for a pinned project inside a pinned harness. The harness *root* is a project
 * and does have one - it is a directory a session starts in, like any other row
 * in here.
 */
function HarnessGroup({
  group,
  first,
  expanded,
  running,
  onToggle,
  selectedPath,
  liveSessions,
  onSelect,
  onTogglePin
}: {
  group: Group
  first: boolean
  expanded: boolean
  running: number
  onToggle: () => void
  selectedPath: string | null
  liveSessions?: ReadonlyMap<string, readonly string[]> | undefined
  onSelect: (project: Project) => void
  onTogglePin: (path: string) => void
}): JSX.Element {
  const name = group.harness?.name ?? 'Folders'
  const count = group.members.length + (group.root ? 1 : 0)

  return (
    <section className="mb-1">
      {!first && <div aria-hidden className="island-rule mx-1.5 mt-2 mb-2.5" />}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${name}, ${String(count)} project${count === 1 ? '' : 's'}`}
        className="flex w-full items-center gap-1.5 rounded-well px-2 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <CaretIcon
          width={9}
          height={9}
          className={cn('shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-90')}
        />
        <span className="min-w-0 truncate text-[10.5px] leading-[13px] font-semibold tracking-[.07em] text-fg uppercase">
          {name}
        </span>
        <span className="text-[9.5px] leading-[13px] tabular-nums text-fg-subtle">{count}</span>
        <span className="flex-1" />
        {running > 0 && (
          <span
            title={`${String(running)} session${running === 1 ? '' : 's'} running here`}
            className="flex shrink-0 items-center gap-1 text-[9.5px] tabular-nums text-accent-text"
          >
            <TerminalIcon width={9} height={9} />
            {running}
          </span>
        )}
      </button>

      {expanded && (
        <div className="pl-1.5">
          {group.root && (
            <ProjectRow
              project={group.root}
              selected={group.root.path === selectedPath}
              liveNames={liveSessions?.get(group.root.path.toLowerCase())}
              onSelect={onSelect}
              onTogglePin={(project) => onTogglePin(project.path)}
            />
          )}
          {group.members.map((project) => (
            <ProjectRow
              key={project.path}
              project={project}
              selected={project.path === selectedPath}
              liveNames={liveSessions?.get(project.path.toLowerCase())}
              onSelect={onSelect}
              onTogglePin={(p) => onTogglePin(p.path)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/**
 * One of the rows above the tree, each a way into a pane about the whole
 * machine. They share a shape so the group reads as one list; `detail` is the
 * second line, which only Session history has a fact worth filling with.
 */
function GlobalLink({
  icon,
  label,
  detail,
  title,
  active,
  onClick,
  ...rest
}: {
  icon: JSX.Element
  label: string
  detail?: string | undefined
  title: string
  active: boolean
  onClick: () => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      title={title}
      className={cn(
        'flex w-full items-center gap-2 rounded-well px-2 py-1.5 text-left transition-colors',
        active ? ROW_SELECTED : 'hover:bg-hover'
      )}
      {...rest}
    >
      <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] text-fg">{label}</span>
        {detail !== undefined && (
          <span className="block truncate text-[10px] text-fg-subtle">{detail}</span>
        )}
      </span>
    </button>
  )
}

function IconButton({
  label,
  onClick,
  disabled = false,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  disabled?: boolean | undefined
  children: JSX.Element
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded-[5px] text-fg-subtle transition-colors',
        'hover:bg-hover hover:text-fg disabled:cursor-default disabled:opacity-50'
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

function EmptyState({
  scanning,
  filtering,
  hasRoots,
  onAddRoot
}: {
  scanning: boolean
  filtering: boolean
  hasRoots: boolean
  onAddRoot: () => void
}): JSX.Element {
  if (filtering) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">No match.</p>
  }
  if (scanning) {
    return <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Scanning&hellip;</p>
  }
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[12px] text-fg-muted">
        {hasRoots ? 'Nothing found in the scanned folders.' : 'No folders are being scanned yet.'}
      </p>
      <button
        type="button"
        onClick={onAddRoot}
        className="mt-3 rounded-well border border-border-strong px-2.5 py-1 text-[12px] text-fg transition-colors hover:bg-hover"
      >
        Add a folder
      </button>
    </div>
  )
}
