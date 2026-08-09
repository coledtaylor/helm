import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Project, SessionRecord } from '@helm/core'
import {
  AppShell,
  cn,
  FolderIcon,
  HarnessIcon,
  ProjectPane,
  RepoIcon,
  Sidebar,
  StatusBar,
  TabBar,
  ThemeToggle,
  WelcomePane,
  type Tab,
  type TabIndicator
} from '@helm/ui'
import { TerminalPane } from './TerminalPane'
import { useLauncher } from './useLauncher'
import { useSessions } from './useSessions'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * Two kinds of tab, one strip.
 *
 * A project tab is a view of discovery's data and can be thrown away and
 * rebuilt at will. A session tab has a process behind it, so it is closed by
 * asking the main process, and its pane stays mounted even while another tab is
 * on screen - unmounting it would drop the scrollback of a live session.
 */
type PaneRef = { kind: 'project'; path: string } | { kind: 'session'; id: number }

const tabId = (ref: PaneRef): string =>
  ref.kind === 'project' ? `project:${ref.path}` : `session:${String(ref.id)}`

export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  const [order, setOrder] = useState<PaneRef[]>([])
  /** What the user last asked for. The tab that is actually active is derived
   * from it, because the requested one can stop existing. */
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  /** The pane box, measured to open a pty at roughly the right grid. */
  const paneRef = useRef<HTMLDivElement>(null)

  const activateSession = useCallback((id: number) => {
    setRequestedId(tabId({ kind: 'session', id }))
  }, [])

  const sessionState = useSessions(activateSession)
  const { sessions } = sessionState

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of discovery?.projects ?? []) map.set(project.path, project)
    return map
  }, [discovery])

  const sessionsById = useMemo(() => {
    const map = new Map<number, SessionRecord>()
    for (const session of sessions) map.set(session.id, session)
    return map
  }, [sessions])

  /**
   * The tab strip, derived rather than synced in an effect.
   *
   * A rescan that no longer sees a project should close its tab, and every
   * session main is hosting should have one - including sessions this renderer
   * did not launch, which is the case after a reload (dev HMR, or a crashed
   * render process) where the processes outlive the tab strip that was showing
   * them. Writing either as `useEffect` + `setState` renders once with the
   * wrong tabs and then again with the right ones, for a value that is a pure
   * function of what we already have.
   *
   * `order` therefore holds placement, not membership: a session that has never
   * been moved or closed is simply appended.
   */
  const openPanes = useMemo(() => {
    const placed = order.filter((ref) =>
      ref.kind === 'project' ? !discovery || projectsByPath.has(ref.path) : sessionsById.has(ref.id)
    )
    const known = new Set(placed.filter((ref) => ref.kind === 'session').map((ref) => ref.id))
    const appended = sessions
      .filter((session) => !known.has(session.id))
      .map((session): PaneRef => ({ kind: 'session', id: session.id }))
    return [...placed, ...appended]
  }, [order, discovery, projectsByPath, sessions, sessionsById])

  const activeId =
    requestedId !== null && openPanes.some((ref) => tabId(ref) === requestedId)
      ? requestedId
      : (openPanes.map(tabId).at(-1) ?? null)
  const activePane = openPanes.find((ref) => tabId(ref) === activeId) ?? null

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which pane is in front - which only this side knows.
  const { reportFocus } = sessionState
  useEffect(() => {
    reportFocus(activePane?.kind === 'session' ? activePane.id : null)
  }, [activePane, reportFocus])

  const openProject = useCallback((project: Project | null) => {
    if (!project) return
    const ref: PaneRef = { kind: 'project', path: project.path }
    setOrder((current) =>
      current.some((r) => tabId(r) === tabId(ref)) ? current : [...current, ref]
    )
    setRequestedId(tabId(ref))
  }, [])

  const launch = useCallback(
    async (project: Project) => {
      setLaunching(true)
      try {
        const id = await sessionState.launch(project, paneRef.current)
        if (id === null) return
        // Placed on launch so the strip reads in the order it was built, rather
        // than every terminal collecting at the end behind every project tab.
        // The append in `openPanes` is then only for sessions this renderer did
        // not launch.
        setOrder((current) => [...current, { kind: 'session', id }])
        setRequestedId(tabId({ kind: 'session', id }))
      } finally {
        setLaunching(false)
      }
    },
    [sessionState]
  )

  const closeTab = useCallback(
    (id: string) => {
      const ref = openPanes.find((candidate) => tabId(candidate) === id)
      if (!ref) return

      if (ref.kind === 'project') {
        setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
        return
      }
      // The process gets a say: main confirms before ending a live session, and
      // the tab stays if the answer is no. A closed session drops out of
      // `sessions`, so the strip loses it whether or not it was ever placed.
      void sessionState.close(ref.id).then((closed) => {
        if (closed) setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
      })
    },
    [openPanes, sessionState]
  )

  // Written back as the whole strip, so a tab that had only been appended is
  // placed by the same gesture that moved it.
  const reorderTabs = useCallback(
    (id: string, toIndex: number) => {
      const from = openPanes.findIndex((ref) => tabId(ref) === id)
      if (from < 0 || from === toIndex) return
      const next = [...openPanes]
      const [moved] = next.splice(from, 1)
      if (!moved) return
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved)
      setOrder(next)
    },
    [openPanes]
  )

  // Ctrl+Tab cycles, in capture so it never reaches the focused terminal.
  // Ctrl+Shift+Tab is not bound by Claude Code either; Shift+Tab alone is (it
  // cycles permission modes) and is deliberately left alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.altKey) return
      const ids = openPanes.map(tabId)
      if (ids.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      const at = activeId === null ? -1 : ids.indexOf(activeId)
      const step = event.shiftKey ? -1 : 1
      setRequestedId(ids[(at + step + ids.length) % ids.length] ?? null)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openPanes, activeId])

  const tabs: Tab[] = openPanes.flatMap((ref): Tab[] => {
    if (ref.kind === 'project') {
      const project = projectsByPath.get(ref.path)
      if (!project) return []
      const Icon = KIND_ICON[project.kind]
      return [
        {
          id: tabId(ref),
          title: project.name,
          hint: project.path,
          icon: <Icon width={13} height={13} />
        }
      ]
    }

    const session = sessionsById.get(ref.id)
    if (!session) return []
    const indicator: TabIndicator =
      session.status === 'running' ? 'running' : session.exitCode ? 'failed' : 'ended'
    const project = session.projectPath ? projectsByPath.get(session.projectPath) : undefined
    return [
      {
        id: tabId(ref),
        title: session.name,
        hint: `${session.name} · ${session.cwd}`,
        ...(project && project.name !== session.name ? { subtitle: project.name } : {}),
        indicator
      }
    ]
  })

  const activeProject =
    activePane?.kind === 'project' ? (projectsByPath.get(activePane.path) ?? null) : null
  // A session tab still points at a project, so the tree keeps showing where
  // the thing on screen came from rather than clearing its selection.
  const selectedPath =
    activePane?.kind === 'session'
      ? (sessionsById.get(activePane.id)?.projectPath ?? null)
      : (activeProject?.path ?? null)
  const sessionPanes = openPanes.filter((ref) => ref.kind === 'session')
  const runningSessions = sessions.filter((session) => session.status === 'running').length

  return (
    <AppShell
      sidebar={
        <Sidebar
          discovery={discovery}
          scanning={launcher.scanning}
          scanError={launcher.scanError}
          selectedPath={selectedPath}
          onSelect={openProject}
          onRescan={launcher.rescan}
          onAddRoot={launcher.addRoot}
        />
      }
      tabBar={
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={setRequestedId}
          onClose={closeTab}
          onReorder={reorderTabs}
          actions={
            <ThemeToggle value={settings?.theme ?? 'system'} onChange={launcher.setTheme} />
          }
        />
      }
      statusBar={
        <StatusBar
          build={info ? `${info.version} · ${info.mode}` : '…'}
          dbFile={info?.dbFile ?? ''}
          migrations={info?.migrations ?? []}
          claudeVersion={info?.claudeVersion ?? null}
          scanning={launcher.scanning}
          runningSessions={runningSessions}
          lastScan={
            discovery && discovery.durationMs > 0
              ? {
                  projects: discovery.projects.length,
                  durationMs: discovery.durationMs,
                  at: discovery.scannedAt
                }
              : null
          }
          onRevealDb={() => info && launcher.reveal(info.dbFile)}
        />
      }
    >
      <div ref={paneRef} className="relative h-full w-full">
        {/* Every terminal stays mounted and only the active one is shown.
            Unmounting a pane to switch tabs would take the session's scrollback
            with it, and re-attaching a live pty to a fresh terminal cannot
            recover what has already scrolled past. */}
        {sessionPanes.map((ref) => {
          const session = sessionsById.get(ref.id)
          if (!session) return null
          const visible = tabId(ref) === activeId
          return (
            <div
              key={ref.id}
              className={cn('absolute inset-0', visible ? 'block' : 'hidden')}
              aria-hidden={!visible}
            >
              <TerminalPane
                session={session}
                active={visible}
                windowsBuild={info?.windowsBuild ?? null}
                onClose={(id) => closeTab(tabId({ kind: 'session', id }))}
              />
            </div>
          )
        })}

        {activeProject && (
          <div className="absolute inset-0">
            <ProjectPane
              key={activeProject.path}
              project={activeProject}
              onReveal={launcher.reveal}
              onLaunch={(project) => void launch(project)}
              launching={launching}
              launchError={sessionState.launchError}
            />
          </div>
        )}

        {activePane === null && (
          <div className="absolute inset-0">
            <WelcomePane
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              onAddRoot={launcher.addRoot}
            />
          </div>
        )}
      </div>
    </AppShell>
  )
}
