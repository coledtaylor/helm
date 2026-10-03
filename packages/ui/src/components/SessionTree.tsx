import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import type { DiscoveryResult, Harness, Project } from '@helm/core'
import { isProjectPinned } from '@helm/core/types'
import { cn } from '../lib/cn'
import type { SessionState } from '../lib/sessionstate'
import { baseName, MissingProjectRow, ProjectRow, SessionRow } from './ProjectRow'
import { CaretIcon, PinIcon, TerminalIcon } from './icons'

/** One session as the tree draws it; see `SessionRow` for each field. */
export interface TreeSession {
  id: string
  label: string
  state: SessionState | null
  note: string
  hint: string
  outside: boolean
  shown: 'focused' | 'visible' | null
}

export interface SessionTreeProps {
  discovery: DiscoveryResult | null
  scanning: boolean
  scanError?: string | undefined
  /** The project whose page is in front of the focused pane. */
  selectedPath: string | null
  /**
   * `pinnedProjects`, straight off the settings. Required, because it is a
   * rule about where every project row is drawn: a caller that forgot it would
   * silently print pinned projects back inside their harness groups.
   */
  pinnedPaths: readonly string[]
  onTogglePin: (path: string) => void
  /** Lower-cased project path -> the sessions running there, Helm's and not. */
  sessionsByPath: ReadonlyMap<string, readonly TreeSession[]>
  /** Helm's sessions whose folder is no project the scan found. */
  elsewhere: readonly TreeSession[]
  onSelect: (project: Project) => void
  onLaunch: (project: Project) => void
  /** The project a session is starting in right now. */
  launchingPath: string | null
  onOpenSession: (id: string) => void
  onAddRoot: () => void
}

interface Group {
  key: string
  harness: Harness | null
  root: Project | null
  members: Project[]
}

/** A pinned path, and the project discovery found at it - or null. */
interface Pin {
  path: string
  project: Project | null
  name: string
}

/**
 * The pinned paths, resolved against the current scan.
 *
 * Flat and cross-harness on purpose: escaping the grouping is the whole point.
 * Sorted by **name** rather than by path - a list ordered by path is a list
 * ordered by harness, which is the arrangement the section exists to get out of.
 * A path with nothing behind it keeps its place; an unplugged drive is not a
 * decision to un-pin.
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
 * The harness tree, with the pinned projects taken out of it rather than
 * marked: a pinned project printed in both places is two rows for one project.
 */
function groupProjects(discovery: DiscoveryResult | null, pinned: readonly string[]): Group[] {
  if (!discovery) return []
  const byHarness = new Map<string, Group>()
  const loose: Project[] = []
  for (const harness of discovery.harnesses) {
    byHarness.set(harness.path.toLowerCase(), { key: harness.path, harness, root: null, members: [] })
  }
  for (const project of discovery.projects) {
    if (isProjectPinned(pinned, project.path)) continue
    const group =
      project.harnessPath === null ? undefined : byHarness.get(project.harnessPath.toLowerCase())
    if (!group) {
      loose.push(project)
      continue
    }
    if (project.kind === 'harness') group.root = project
    else group.members.push(project)
  }
  const groups = [...byHarness.values()]
  if (loose.length > 0) groups.push({ key: '__loose__', harness: null, root: null, members: loose })
  return groups
}

function matchesText(text: string, query: string): boolean {
  return query === '' || text.toLowerCase().includes(query.toLowerCase())
}

/**
 * Which of a project's sessions' states a folded project shows: the one that
 * most wants you. Waiting first, then working, then a failure, then the rest.
 */
const URGENCY: readonly SessionState[] = [
  'waiting',
  'busy',
  'failed',
  'running',
  'shell',
  'idle',
  'ended'
]

function mostUrgent(sessions: readonly TreeSession[]): SessionState | null {
  let best: SessionState | null = null
  for (const session of sessions) {
    if (session.state === null) continue
    if (best === null || URGENCY.indexOf(session.state) < URGENCY.indexOf(best)) best = session.state
  }
  return best
}

/**
 * Projects, with the sessions running in each nested under it.
 *
 * Sessions first, which is the order of the whole window now: a project with
 * something running in it opens out to show it, and one without is a single
 * line with a `+` under the pointer. Pinned projects sit above the harness
 * groups, as they always have, and a session whose folder is no project the
 * scan found is listed at the bottom rather than not at all - every session
 * Helm hosts has a row somewhere.
 *
 * What is folded is local and absent-means-open, for the reason the harness
 * groups always were: a project that gains a session after this render should
 * show it, not hide it behind a key nothing has written yet.
 */
export function SessionTree({
  discovery,
  scanning,
  scanError,
  selectedPath,
  pinnedPaths,
  onTogglePin,
  sessionsByPath,
  elsewhere,
  onSelect,
  onLaunch,
  launchingPath,
  onOpenSession,
  onAddRoot
}: SessionTreeProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(new Set())
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(new Set())
  const groups = useMemo(() => groupProjects(discovery, pinnedPaths), [discovery, pinnedPaths])
  const pins = useMemo(() => resolvePins(discovery, pinnedPaths), [discovery, pinnedPaths])

  const sessionsOf = (path: string): readonly TreeSession[] =>
    sessionsByPath.get(path.toLowerCase()) ?? []

  // A project matches on its name, its path, or the name of anything running
  // in it - "where is the session called accruals" is a question this filter
  // has to answer, and the project it is in is the answer.
  const matches = (project: Project): boolean =>
    matchesText(project.name, query) ||
    matchesText(project.path, query) ||
    sessionsOf(project.path).some((session) => matchesText(session.label, query))

  const filtered = groups
    .map((group) => ({
      ...group,
      // A harness root that does not match itself is kept as long as one of
      // its repos does, so filtering never orphans a visible child.
      root: group.root && matches(group.root) ? group.root : null,
      members: group.members.filter(matches)
    }))
    .filter((group) => group.root !== null || group.members.length > 0)

  const shownPins = pins.filter(
    (pin) =>
      matchesText(pin.name, query) ||
      matchesText(pin.path, query) ||
      (pin.project !== null && matches(pin.project))
  )
  const shownElsewhere = elsewhere.filter((session) => matchesText(session.label, query))

  const toggle = (
    setter: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => void,
    key: string
  ): void =>
    setter((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // A filter that hides its own matches looks broken, so searching opens
  // everything it matched.
  const groupOpen = (key: string): boolean => query !== '' || !foldedGroups.has(key)
  const projectOpen = (path: string): boolean =>
    query !== '' || !foldedProjects.has(path.toLowerCase())

  const total = discovery?.projects.length ?? 0

  const renderProject = (project: Project, indent: number, pinned: boolean): JSX.Element => {
    const sessions = sessionsOf(project.path)
    const expanded = sessions.length === 0 ? null : projectOpen(project.path)
    return (
      <div key={project.path}>
        <ProjectRow
          project={project}
          selected={project.path === selectedPath}
          onSelect={onSelect}
          indent={indent}
          expanded={expanded}
          onToggle={() => toggle(setFoldedProjects, project.path.toLowerCase())}
          summary={mostUrgent(sessions)}
          pinned={pinned}
          onTogglePin={(p) => onTogglePin(p.path)}
          onLaunch={onLaunch}
          launching={launchingPath === project.path}
        />
        {expanded === true &&
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              {...session}
              indent={indent + 32}
              onOpen={onOpenSession}
            />
          ))}
      </div>
    )
  }

  return (
    <>
      <div className="shrink-0 px-2 pb-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects and sessions"
          spellCheck={false}
          aria-label="Filter projects and sessions"
          className={cn(
            'h-7 w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
            'text-fg placeholder:text-fg-subtle select-text',
            'focus:border-accent focus:outline-none'
          )}
        />
      </div>

      <nav
        aria-label="Projects and sessions"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
      >
        {scanError !== undefined && (
          <p className="mx-0.5 mb-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
            {scanError}
          </p>
        )}

        {shownPins.length > 0 && (
          <section data-pinned-section aria-label="Pinned" className="mb-1">
            <Caption icon={<PinIcon width={9} height={9} />} label="Pinned" count={shownPins.length} />
            {shownPins.map((pin) =>
              pin.project === null ? (
                <MissingProjectRow
                  key={pin.path}
                  path={pin.path}
                  indent={4}
                  onTogglePin={onTogglePin}
                />
              ) : (
                renderProject(pin.project, 4, true)
              )
            )}
          </section>
        )}

        {filtered.length === 0 && shownPins.length === 0 && shownElsewhere.length === 0 ? (
          <EmptyState
            scanning={scanning}
            filtering={query !== '' && total > 0}
            hasRoots={(discovery?.roots.length ?? 0) > 0}
            onAddRoot={onAddRoot}
          />
        ) : (
          filtered.map((group, index) => {
            const projects = group.root ? [group.root, ...group.members] : group.members
            const running = projects.reduce((n, p) => n + sessionsOf(p.path).length, 0)
            const open = groupOpen(group.key)
            const name = group.harness?.name ?? 'Folders'
            return (
              <section key={group.key} className="mb-1">
                {(index > 0 || shownPins.length > 0) && (
                  <div aria-hidden className="island-rule mx-2 my-2 opacity-60" />
                )}
                <button
                  type="button"
                  onClick={() => toggle(setFoldedGroups, group.key)}
                  aria-expanded={open}
                  aria-label={`${name}, ${String(projects.length)} project${projects.length === 1 ? '' : 's'}`}
                  className="flex h-line w-full items-center gap-1.5 rounded-raised pr-2 pl-1 text-left transition-colors hover:bg-hover"
                >
                  <span className="grid size-4 shrink-0 place-items-center text-fg-subtle">
                    <CaretIcon
                      width={10}
                      height={10}
                      className={cn('transition-transform', open && 'rotate-90')}
                    />
                  </span>
                  <span className="min-w-0 truncate text-[10.5px] font-semibold tracking-[.07em] text-fg uppercase">
                    {name}
                  </span>
                  <span className="text-[11px] tabular-nums text-fg-subtle">{projects.length}</span>
                  {/* What the harness was built from, which the manifest records
                      as provenance - on the harness's own line, the one place in
                      the tree that is about the harness rather than a project. */}
                  {group.harness?.template ? (
                    <span
                      data-project-meta={group.harness.template}
                      className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-subtle"
                    >
                      {group.harness.template}
                    </span>
                  ) : (
                    <span className="flex-1" />
                  )}
                  {running > 0 && (
                    <span
                      title={`${String(running)} session${running === 1 ? '' : 's'} running here`}
                      className="flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums text-accent-text"
                    >
                      <TerminalIcon width={10} height={10} />
                      {running}
                    </span>
                  )}
                </button>
                {open && projects.map((project) => renderProject(project, 22, false))}
              </section>
            )
          })
        )}

        {shownElsewhere.length > 0 && (
          <section data-elsewhere-section className="mb-1">
            {(filtered.length > 0 || shownPins.length > 0) && (
              <div aria-hidden className="island-rule mx-2 my-2 opacity-60" />
            )}
            <Caption label="Elsewhere" count={shownElsewhere.length} />
            {shownElsewhere.map((session) => (
              <SessionRow key={session.id} {...session} indent={22} onOpen={onOpenSession} />
            ))}
          </section>
        )}
      </nav>
    </>
  )
}

/**
 * A section label that is not a group: no caret, and `fg-subtle` where a
 * harness header sits at `fg`. A section that looked like a harness would read
 * as a pinnable harness, and harnesses are not pinnable.
 */
function Caption({
  icon,
  label,
  count
}: {
  icon?: JSX.Element | undefined
  label: string
  count: number
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-fg-subtle">
      {icon !== undefined && <span className="shrink-0">{icon}</span>}
      <span className="text-[10px] leading-[13px] font-semibold tracking-[.07em] uppercase">
        {label}
      </span>
      <span className="text-[10px] leading-[13px] tabular-nums">{count}</span>
    </div>
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
