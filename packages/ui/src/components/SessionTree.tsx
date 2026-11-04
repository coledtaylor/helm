import type { JSX, MouseEvent, ReactNode } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiscoveryResult, Harness, Project } from '@helm/core'
import { isProjectPinned } from '@helm/core/types'
import { cn } from '../lib/cn'
import type { SessionState } from '../lib/sessionstate'
import { EmptyState as EmptyWell } from './EmptyState'
import { Menu, type MenuAnchor, type MenuEntry } from './Menu'
import { baseName, MissingProjectRow, ProjectRow, SessionRow } from './ProjectRow'
import { CaretIcon, FolderPlusIcon, PinIcon, PlusIcon, RefreshIcon, ServerIcon, TerminalIcon } from './icons'

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

/**
 * A host on another computer, as the tree lists it under its own header after
 * this PC's group: its own harnesses, projects and running sessions, read from
 * its own bridge. Its rows stay listed while it is not connected, dimmed, and
 * come back live by themselves once it is.
 */
export interface TreeHost {
  /** Its id in the `hosts` setting. */
  id: string
  /** What the window calls it. */
  name: string
  /** Whether the window reaches it now. While it does not, its header says retrying. */
  connected: boolean
  discovery: DiscoveryResult | null
  scanning: boolean
  /** Why its folders could not be read: the group says Unknown and this, never its empty state. */
  scanError?: string | undefined
  pinnedPaths: readonly string[]
  sessionsByPath: ReadonlyMap<string, readonly TreeSession[]>
  elsewhere: readonly TreeSession[]
  /** Its project whose page is in front of the focused pane. */
  selectedPath: string | null
  /** Its project a session is starting in right now. */
  launchingPath: string | null
}

/** What each host's group asks the window for, naming the host by its id (`LOCAL_HOST_KEY` for this PC's). */
export interface TreeHostActions {
  onSelect: (host: string, project: Project) => void
  onLaunch: (host: string, project: Project) => void
  onOpenSession: (host: string, id: string) => void
  onTogglePin: (host: string, path: string) => void
  /** A host header's New session: the launcher, on that host. */
  onNewSession: (host: string) => void
  /** A host header's New harness, and the empty state's: the dialog, creating on that host. */
  onNewHarness: (host: string) => void
  /** A host header's Rescan, and Unknown's Try again. */
  onRescan: (host: string) => void
  /** The Add a host line at the end of the list: Settings > Hosts. */
  onAddHost: () => void
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
  /**
   * A row to bring into view: what is folded over it opens and the tree
   * scrolls to it. A new `seq` asks again for the same row.
   */
  reveal?: TreeReveal | null
  /**
   * The hosts on another computer, each listed under its own header after this
   * PC's group. Empty or absent, there are no host headers and no Add a host
   * line: the tree is this PC's alone, as it has always looked.
   */
  hosts?: readonly TreeHost[] | undefined
  /** What the host headers, their groups and the Add a host line do. Needed with `hosts`. */
  hostActions?: TreeHostActions | undefined
  /** This PC's name in its header, with hosts. */
  localName?: string | undefined
  /** This PC's host key, which `hostActions` names its group by. */
  localKey?: string | undefined
  /**
   * The list's right-click menu offers Add a host…, which this opens. Given
   * only while sessions run in the local host and this PC is the only host;
   * once there are others, the Add a host line at the end of the list does it.
   */
  onAddHostMenu?: (() => void) | undefined
}

/** A session's row, by its id, or a project's, by its path (on `host`, this PC's when absent). */
export type TreeReveal =
  | { seq: number; kind: 'session'; id: string }
  | { seq: number; kind: 'project'; path: string; host?: string | undefined }

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
 * line with a terminal button under the pointer. Pinned projects sit above the harness
 * groups, as they always have, and a session whose folder is no project the
 * scan found is listed at the bottom rather than not at all - every session
 * Helm hosts has a row somewhere.
 *
 * What is folded is local and absent-means-open, for the reason the harness
 * groups always were: a project that gains a session after this render should
 * show it, not hide it behind a key nothing has written yet.
 *
 * With hosts on other computers, each host's harnesses, projects and sessions
 * are listed under its own header, this PC first, and the list ends with an
 * Add a host line. The filter matches rows in every group.
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
  onAddRoot,
  reveal = null,
  hosts = [],
  hostActions,
  localName = 'This PC',
  localKey = 'local',
  onAddHostMenu
}: SessionTreeProps): JSX.Element {
  const [query, setQuery] = useState('')
  const [listMenu, setListMenu] = useState<MenuAnchor | null>(null)
  const navRef = useRef<HTMLElement>(null)
  const grouped = hosts.length > 0 && hostActions !== undefined

  // The row in front - a session's or a project's page - is the tree's one
  // `aria-current`, so the scroll needs no second way of finding it.
  useEffect(() => {
    if (reveal === null) return
    navRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [reveal])

  const local = (
    <HostTree
      discovery={discovery}
      scanError={scanError}
      selectedPath={selectedPath}
      pinnedPaths={pinnedPaths}
      onTogglePin={onTogglePin}
      sessionsByPath={sessionsByPath}
      elsewhere={elsewhere}
      onSelect={onSelect}
      onLaunch={onLaunch}
      launchingPath={launchingPath}
      onOpenSession={onOpenSession}
      query={query}
      reveal={reveal !== null && (reveal.kind === 'session' || (reveal.host ?? localKey) === localKey) ? reveal : null}
      empty={
        <ScanEmpty
          scanning={scanning}
          filtering={query !== '' && (discovery?.projects.length ?? 0) > 0}
          hasRoots={(discovery?.roots.length ?? 0) > 0}
          onAddRoot={onAddRoot}
        />
      }
    />
  )

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
        ref={navRef}
        aria-label="Projects and sessions"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
        onContextMenu={(event) => {
          // A row's own menu came first and is the one shown.
          if (grouped || onAddHostMenu === undefined || event.defaultPrevented) return
          event.preventDefault()
          setListMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        {!grouped ? (
          local
        ) : (
          <>
            <section data-host-group={localKey} aria-label={localName}>
              <HostHeader host={localKey} name={localName} remote={false} connected actions={hostActions} />
              {local}
            </section>
            {hosts.map((host) => (
              <section key={host.id} data-host-group={host.id} aria-label={host.name}>
                <HostHeader
                  host={host.id}
                  name={host.name}
                  remote
                  connected={host.connected}
                  actions={hostActions}
                />
                <div data-host-rows={host.connected ? 'live' : 'dimmed'} className={cn(!host.connected && 'opacity-50')}>
                  <HostTree
                    discovery={host.discovery}
                    scanError={host.discovery === null ? undefined : host.scanError}
                    selectedPath={host.selectedPath}
                    pinnedPaths={host.pinnedPaths}
                    onTogglePin={(path) => hostActions.onTogglePin(host.id, path)}
                    sessionsByPath={host.sessionsByPath}
                    elsewhere={host.elsewhere}
                    onSelect={(project) => hostActions.onSelect(host.id, project)}
                    onLaunch={(project) => hostActions.onLaunch(host.id, project)}
                    launchingPath={host.launchingPath}
                    onOpenSession={(id) => hostActions.onOpenSession(host.id, id)}
                    query={query}
                    reveal={
                      reveal !== null && (reveal.kind === 'session' || reveal.host === host.id) ? reveal : null
                    }
                    empty={
                      query !== '' && (host.discovery?.projects.length ?? 0) > 0 ? (
                        <p className="px-2 py-3 text-center text-[12px] text-fg-subtle">No match.</p>
                      ) : (
                        <RemoteEmpty host={host} onNewHarness={hostActions.onNewHarness} onRescan={hostActions.onRescan} />
                      )
                    }
                  />
                </div>
              </section>
            ))}
            <button
              type="button"
              data-add-host
              onClick={hostActions.onAddHost}
              className="mt-1.5 flex h-line w-full items-center gap-[7px] rounded-raised px-1.5 text-left text-[12.5px] text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <PlusIcon width={13} height={13} />
              Add a host
            </button>
          </>
        )}
      </nav>
      {listMenu !== null && onAddHostMenu !== undefined && (
        <Menu
          label="Projects and sessions"
          entries={ADD_HOST_MENU}
          at={listMenu}
          onSelect={() => {
            setListMenu(null)
            onAddHostMenu()
          }}
          onDismiss={() => setListMenu(null)}
        />
      )}
    </>
  )
}

const ADD_HOST_MENU: readonly MenuEntry[] = [
  { kind: 'item', id: 'add-host', label: 'Add a host…', icon: <ServerIcon width={13} height={13} /> }
]

/** The props `sessionTreeHostProps` decides. */
export type SessionTreeHostProps = Pick<SessionTreeProps, 'hosts' | 'onAddHostMenu'>

/**
 * Which hosts the tree lists, and whether its right-click menu adds one. With
 * this PC the only host, the list's right-click menu has Add a host…
 * (`onAddHost`); once there are others, each has its group and the list ends
 * with an Add a host line, which `hostActions.onAddHost` answers.
 */
export function sessionTreeHostProps(options: {
  hosts: readonly TreeHost[]
  onAddHost: () => void
}): SessionTreeHostProps {
  if (options.hosts.length === 0) return { onAddHostMenu: options.onAddHost }
  return { hosts: options.hosts }
}

/**
 * A host's header row: a ring dot (the warn colour while it is not reached),
 * its name - a remote host's in mono, as the machine data it is - and
 * "retrying" at the right while the window is not connected to it. Under the
 * pointer it offers New session, New harness and Rescan, which its right-click
 * menu offers too.
 */
function HostHeader({
  host,
  name,
  remote,
  connected,
  actions
}: {
  host: string
  name: string
  remote: boolean
  connected: boolean
  actions: TreeHostActions
}): JSX.Element {
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const entries: readonly MenuEntry[] = [
    { kind: 'item', id: 'new-session', label: 'New session', icon: <TerminalIcon width={13} height={13} /> },
    { kind: 'item', id: 'new-harness', label: 'New harness', icon: <FolderPlusIcon width={13} height={13} /> },
    { kind: 'item', id: 'rescan', label: 'Rescan', icon: <RefreshIcon width={13} height={13} /> }
  ]
  const choose = (id: string): void => {
    setMenu(null)
    if (id === 'new-session') actions.onNewSession(host)
    else if (id === 'new-harness') actions.onNewHarness(host)
    else if (id === 'rescan') actions.onRescan(host)
  }
  const openMenu = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setMenu(
      event.clientX === 0 && event.clientY === 0
        ? { below: event.currentTarget.getBoundingClientRect() }
        : { x: event.clientX, y: event.clientY }
    )
  }
  return (
    <div
      data-host-header={host}
      data-host-state={connected ? 'connected' : 'retrying'}
      onContextMenu={openMenu}
      className="group/host mt-1.5 flex h-6 items-center gap-1.5 rounded-raised pr-1 pl-1.5 text-[11px] font-medium text-fg-muted first:mt-0"
    >
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full border-[1.5px]', connected ? 'border-success' : 'border-warn')}
      />
      <span className={cn('min-w-0 truncate', remote && 'font-mono text-[10.5px]')}>{name}</span>
      {!connected && (
        <span data-host-retrying className="shrink-0 font-normal text-warn" title={`Not connected to ${name}; trying again`}>
          retrying
        </span>
      )}
      <span className="flex-1" />
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/host:opacity-100 focus-within:opacity-100">
        <HeaderAction label={`New session on ${name}`} onClick={() => actions.onNewSession(host)}>
          <PlusIcon width={12} height={12} />
        </HeaderAction>
        <HeaderAction label={`New harness on ${name}`} onClick={() => actions.onNewHarness(host)}>
          <FolderPlusIcon width={12} height={12} />
        </HeaderAction>
        <HeaderAction label={`Rescan ${name}`} onClick={() => actions.onRescan(host)}>
          <RefreshIcon width={12} height={12} />
        </HeaderAction>
      </span>
      {menu !== null && (
        <Menu label={`${name} host`} entries={entries} at={menu} onSelect={choose} onDismiss={() => setMenu(null)} />
      )}
    </div>
  )
}

function HeaderAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-5 place-items-center rounded-raised text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  )
}

/**
 * Under a host on another computer whose scan found nothing: the empty-state
 * pattern, offering New harness there. While its folders cannot be read it
 * says Unknown and why instead, never that it has none.
 */
function RemoteEmpty({
  host,
  onNewHarness,
  onRescan
}: {
  host: TreeHost
  onNewHarness: (host: string) => void
  onRescan: (host: string) => void
}): JSX.Element {
  if (host.scanError !== undefined) {
    return (
      <EmptyWell
        name={`host-unknown:${host.id}`}
        size="list"
        icon={<ServerIcon width={18} height={18} />}
        title="Unknown"
        actions={
          <button
            type="button"
            onClick={() => onRescan(host.id)}
            className="flex h-7 items-center gap-1.5 rounded-well border border-border-strong px-2.5 text-[12px] text-fg transition-colors hover:bg-hover"
          >
            <RefreshIcon width={12} height={12} />
            Try again
          </button>
        }
      >
        {`Helm could not read the folders on ${host.name}. ${host.scanError}`}
      </EmptyWell>
    )
  }
  if (host.discovery === null && (host.scanning || host.connected)) {
    return <p className="px-2 py-3 text-center text-[12px] text-fg-subtle">Scanning&hellip;</p>
  }
  return (
    <EmptyWell
      name={`host-empty:${host.id}`}
      size="list"
      icon={<ServerIcon width={18} height={18} />}
      title={`No harnesses on ${host.name} yet`}
      actions={
        <button
          type="button"
          onClick={() => onNewHarness(host.id)}
          className="flex h-7 items-center rounded-well border border-accent px-3 text-[12px] font-medium text-accent-text transition-colors hover:bg-accent-soft"
        >
          New harness
        </button>
      }
    >
      {`A harness there is a folder on ${host.name}, and its sessions run there.`}
    </EmptyWell>
  )
}

/** One host's pinned projects, harness groups and Elsewhere, under the shared filter. */
function HostTree({
  discovery,
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
  query,
  reveal,
  empty
}: {
  discovery: DiscoveryResult | null
  scanError: string | undefined
  selectedPath: string | null
  pinnedPaths: readonly string[]
  onTogglePin: (path: string) => void
  sessionsByPath: ReadonlyMap<string, readonly TreeSession[]>
  elsewhere: readonly TreeSession[]
  onSelect: (project: Project) => void
  onLaunch: (project: Project) => void
  launchingPath: string | null
  onOpenSession: (id: string) => void
  query: string
  reveal: TreeReveal | null
  /** What it says when it has nothing to list. */
  empty: JSX.Element
}): JSX.Element {
  const [foldedGroups, setFoldedGroups] = useState<ReadonlySet<string>>(new Set())
  const [foldedProjects, setFoldedProjects] = useState<ReadonlySet<string>>(new Set())
  const [pinsFolded, setPinsFolded] = useState(false)
  const groups = useMemo(() => groupProjects(discovery, pinnedPaths), [discovery, pinnedPaths])
  const pins = useMemo(() => resolvePins(discovery, pinnedPaths), [discovery, pinnedPaths])

  const sessionsOf = (path: string): readonly TreeSession[] =>
    sessionsByPath.get(path.toLowerCase()) ?? []

  /*
   * A row asked for is unfolded while rendering, on the change of the request,
   * rather than in an effect - the same render then draws it, and the tree's
   * effect finds it to scroll to. The filter is left alone: what somebody typed
   * there is theirs, and a row it hides stays hidden.
   */
  const [revealedSeq, setRevealedSeq] = useState<number | null>(null)
  if (reveal !== null && reveal.seq !== revealedSeq) {
    setRevealedSeq(reveal.seq)
    const key =
      reveal.kind === 'project'
        ? reveal.path.toLowerCase()
        : ([...sessionsByPath].find(([, rows]) => rows.some((row) => row.id === reveal.id))?.[0] ?? null)
    if (key !== null) {
      const unfold = (current: ReadonlySet<string>, item: string): ReadonlySet<string> => {
        if (!current.has(item)) return current
        const next = new Set(current)
        next.delete(item)
        return next
      }
      setFoldedProjects((current) => unfold(current, key))
      const group = groups.find(
        (each) =>
          each.root?.path.toLowerCase() === key ||
          each.members.some((member) => member.path.toLowerCase() === key)
      )
      if (group !== undefined) setFoldedGroups((current) => unfold(current, group.key))
      if (pins.some((pin) => pin.path.toLowerCase() === key)) setPinsFolded(false)
    }
  }

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
  const pinsOpen = query !== '' || !pinsFolded

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
      {scanError !== undefined && (
        <p className="mx-0.5 mb-2 rounded-raised border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          {scanError}
        </p>
      )}

      {shownPins.length > 0 && (
        <section data-pinned-section aria-label="Pinned" className="mb-1">
          <Caption
            icon={<PinIcon width={9} height={9} />}
            label="Pinned"
            count={shownPins.length}
            fold={{
              open: pinsOpen,
              onToggle: () => setPinsFolded((folded) => !folded),
              name: `Pinned, ${String(shownPins.length)} project${shownPins.length === 1 ? '' : 's'}`
            }}
          />
          {pinsOpen &&
            shownPins.map((pin) =>
              pin.project === null ? (
                <MissingProjectRow
                  key={pin.path}
                  path={pin.path}
                  indent={22}
                  onTogglePin={onTogglePin}
                />
              ) : (
                renderProject(pin.project, 22, true)
              )
            )}
        </section>
      )}

      {filtered.length === 0 && shownPins.length === 0 && shownElsewhere.length === 0
        ? empty
        : filtered.map((group, index) => {
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
          })}

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
    </>
  )
}

/**
 * A section label that is not a group: `fg-subtle` where a harness header sits
 * at `fg`, at the caption's smaller size. A section that looked like a harness
 * would read as a pinnable harness, and harnesses are not pinnable.
 *
 * Given `fold`, it folds its section away as a harness header does - the same
 * caret in the same column, so every caret in the tree's top level lines up -
 * and stays a caption in every other respect.
 */
function Caption({
  icon,
  label,
  count,
  fold
}: {
  icon?: JSX.Element | undefined
  label: string
  count: number
  fold?: { open: boolean; onToggle: () => void; name: string } | undefined
}): JSX.Element {
  const content = (
    <>
      {icon !== undefined && <span className="shrink-0">{icon}</span>}
      <span className="text-[10px] leading-[13px] font-semibold tracking-[.07em] uppercase">
        {label}
      </span>
      <span className="text-[10px] leading-[13px] tabular-nums">{count}</span>
    </>
  )
  if (fold === undefined) {
    return <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-fg-subtle">{content}</div>
  }
  return (
    <button
      type="button"
      onClick={fold.onToggle}
      aria-expanded={fold.open}
      aria-label={fold.name}
      className="flex h-line w-full items-center gap-1.5 rounded-raised pr-2 pl-1 text-left text-fg-subtle transition-colors hover:bg-hover hover:text-fg-muted"
    >
      <span className="grid size-4 shrink-0 place-items-center">
        <CaretIcon width={10} height={10} className={cn('transition-transform', fold.open && 'rotate-90')} />
      </span>
      {content}
    </button>
  )
}

/** This PC's tree with nothing in it: still scanning, nothing matched, or nothing found. */
function ScanEmpty({
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
