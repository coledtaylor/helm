import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  CachedProject,
  DiscoveryResult,
  Project,
  ThemePreference,
  UsageDisplayMode
} from '@helm/core'
import type { AppInfo, ResolvedTheme } from '../../../shared/ipc'
import { helm } from './bridge'

/**
 * All of the launcher's state, in one hook.
 *
 * The order matters more than the shape: the cache paints first, a scan
 * replaces it when it lands, and git refreshes on its own afterwards. A window
 * that waits for a full scan before drawing anything spends its first second
 * blank on a machine with eleven repos, and considerably longer on one with a
 * hundred.
 */

export interface LauncherState {
  info: AppInfo | null
  settings: AppSettings | null
  discovery: DiscoveryResult | null
  scanning: boolean
  scanError: string | undefined
  selected: Project | null
  select: (project: Project | null) => void
  rescan: () => void
  addRoot: () => void
  setTheme: (theme: ThemePreference) => void
  setUsageDisplay: (mode: UsageDisplayMode) => void
  reveal: (path: string) => void
}

/** Turns cached rows into something the tree can render before a scan runs. */
function discoveryFromCache(cached: CachedProject[], roots: string[]): DiscoveryResult | null {
  if (cached.length === 0) return null
  return {
    roots,
    harnesses: cached
      .filter((p) => p.kind === 'harness')
      .map((p) => ({
        path: p.path,
        name: p.name,
        template: null,
        version: null,
        repoPaths: cached.filter((c) => c.harnessPath === p.path).map((c) => c.path)
      })),
    projects: cached,
    errors: [],
    scannedAt: cached[0]?.lastSeenAt ?? new Date().toISOString(),
    durationMs: 0
  }
}

function applyTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function useLauncher(): LauncherState {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | undefined>(undefined)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    const offs = [
      helm.on('discovery:updated', (result) => {
        setDiscovery(result)
        setScanError(undefined)
      }),
      helm.on('scan:status', (status) => {
        setScanning(status.running)
        setScanError(status.error)
      }),
      helm.on('settings:changed', setSettings),
      helm.on('theme:changed', ({ resolved }) => applyTheme(resolved))
    ]

    void (async () => {
      const [appInfo, loaded, resolved] = await Promise.all([
        helm.invoke('app:info'),
        helm.invoke('settings:read'),
        helm.invoke('theme:resolved')
      ])
      setInfo(appInfo)
      setSettings(loaded)
      applyTheme(resolved)

      const cached = await helm.invoke('discovery:cached')
      // A scan started by the main process may already have landed; do not let
      // the cache overwrite fresher data.
      setDiscovery((current) => current ?? discoveryFromCache(cached, loaded.scanRoots))
    })()

    // Tells the main process the window is listening. It answers with the
    // current settings and theme and kicks off the first scan.
    helm.send('renderer:ready')

    return () => {
      for (const off of offs) off()
    }
  }, [])

  /**
   * Git state refreshed on window focus. The trigger lives in the main process
   * - see `win.on('focus')` - because a renderer cannot tell reliably that its
   * window came back to the front. This side only merges the result, keyed by
   * path, so a project that has since disappeared from the tree is ignored
   * rather than resurrected.
   */
  useEffect(
    () =>
      helm.on('git:updated', (states) => {
        setDiscovery((current) =>
          current
            ? {
                ...current,
                projects: current.projects.map((project) =>
                  project.path in states ? { ...project, git: states[project.path] ?? null } : project
                )
              }
            : current
        )
      }),
    []
  )

  const rescan = useCallback(() => {
    setScanning(true)
    void helm
      .invoke('discovery:scan', { includeGit: true })
      .then(setDiscovery)
      .catch((err: unknown) => {
        setScanError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setScanning(false))
  }, [])

  const addRoot = useCallback(() => {
    void helm.invoke('roots:add').then((roots) => {
      setSettings((current) => (current ? { ...current, scanRoots: roots } : current))
      rescan()
    })
  }, [rescan])

  const setTheme = useCallback((theme: ThemePreference) => {
    void helm.invoke('settings:write', { theme }).then(setSettings)
  }, [])

  // Persisted rather than held in the window, so the choice survives a restart
  // - and written through the same channel every other setting uses, so the
  // main process is the one that decides what the settings are.
  const setUsageDisplay = useCallback((usageDisplay: UsageDisplayMode) => {
    void helm.invoke('settings:write', { usageDisplay }).then(setSettings)
  }, [])

  const reveal = useCallback((path: string) => {
    void helm.invoke('shell:showItem', { path })
  }, [])

  const select = useCallback((project: Project | null) => {
    setSelectedPath(project?.path ?? null)
  }, [])

  // Resolved from the current discovery rather than held as state, so a rescan
  // that changes a project's git or inventory updates the open pane too.
  const selected =
    (selectedPath && discovery?.projects.find((p) => p.path === selectedPath)) || null

  return {
    info,
    settings,
    discovery,
    scanning,
    scanError,
    selected,
    select,
    rescan,
    addRoot,
    setTheme,
    setUsageDisplay,
    reveal
  }
}
