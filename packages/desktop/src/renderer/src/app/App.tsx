import type { JSX } from 'react'
import { useCallback, useMemo, useState } from 'react'
import type { Project } from '@helm/core'
import {
  AppShell,
  FolderIcon,
  HarnessIcon,
  ProjectPane,
  RepoIcon,
  Sidebar,
  StatusBar,
  TabBar,
  ThemeToggle,
  WelcomePane,
  type Tab
} from '@helm/ui'
import { useLauncher } from './useLauncher'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * M1's app: pick a project on the left, see what discovery knows about it on
 * the right, in a tab.
 *
 * Tabs are already real - opening a project opens one, and the pane is keyed
 * off the active tab rather than off the sidebar selection - because M2 hangs
 * terminals off exactly this and a tab strip retrofitted around a single-pane
 * app is a rewrite, not an addition.
 */
export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  const [openPaths, setOpenPaths] = useState<string[]>([])
  /** What the user last asked for. The tab that is actually active is derived
   * from it, because the requested one can stop existing. */
  const [requestedPath, setRequestedPath] = useState<string | null>(null)

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of discovery?.projects ?? []) map.set(project.path, project)
    return map
  }, [discovery])

  // Both of these are derived rather than synced in an effect. A rescan that no
  // longer sees a project should close its tab, and closing the active tab
  // should fall back to the last one - but writing that as `useEffect` +
  // `setState` renders once with a tab that no longer exists and then again
  // without it, which is a visible flicker and an extra render for a value that
  // is a pure function of what we already have.
  const openTabPaths = useMemo(
    () => (discovery ? openPaths.filter((path) => projectsByPath.has(path)) : openPaths),
    [discovery, openPaths, projectsByPath]
  )

  const activePath =
    requestedPath !== null && openTabPaths.includes(requestedPath)
      ? requestedPath
      : (openTabPaths.at(-1) ?? null)

  const openProject = useCallback((project: Project | null) => {
    if (!project) return
    setOpenPaths((paths) => (paths.includes(project.path) ? paths : [...paths, project.path]))
    setRequestedPath(project.path)
  }, [])

  const closeTab = useCallback((id: string) => {
    setOpenPaths((paths) => paths.filter((path) => path !== id))
  }, [])

  const tabs: Tab[] = openTabPaths.flatMap((path) => {
    const project = projectsByPath.get(path)
    if (!project) return []
    const Icon = KIND_ICON[project.kind]
    return [{ id: path, title: project.name, icon: <Icon width={13} height={13} /> }]
  })

  const activeProject = activePath ? (projectsByPath.get(activePath) ?? null) : null

  return (
    <AppShell
      sidebar={
        <Sidebar
          discovery={discovery}
          scanning={launcher.scanning}
          scanError={launcher.scanError}
          selectedPath={activePath}
          onSelect={openProject}
          onRescan={launcher.rescan}
          onAddRoot={launcher.addRoot}
        />
      }
      tabBar={
        <TabBar
          tabs={tabs}
          activeId={activePath}
          onActivate={setRequestedPath}
          onClose={closeTab}
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
      {activeProject ? (
        <ProjectPane key={activeProject.path} project={activeProject} onReveal={launcher.reveal} />
      ) : (
        <WelcomePane
          roots={settings?.scanRoots ?? []}
          projectCount={discovery?.projects.length ?? 0}
          onAddRoot={launcher.addRoot}
        />
      )}
    </AppShell>
  )
}
