import {
  cacheProjects,
  openStore,
  readCachedProjects,
  readGitStates,
  readSettings,
  scan,
  suggestRoots,
  writeSettings,
  type AppSettings,
  type DiscoveryResult,
  type GitState,
  type Store
} from '@helm/core'
import { dbFile } from './paths'

/**
 * The main process's stateful bits, in one object rather than module-level
 * singletons: the spike modes never open a database, and a module that opened
 * one on import would create a file the fidelity harness has no use for.
 */

export interface Services {
  store: Store
  settings: AppSettings
  /** Last completed scan, or null before the first one. */
  lastScan: DiscoveryResult | null
}

export function createServices(): Services {
  const store = openStore({ file: dbFile })
  return { store, settings: readSettings(store), lastScan: null }
}

export function updateSettings(services: Services, patch: Partial<AppSettings>): AppSettings {
  services.settings = writeSettings(services.store, patch)
  return services.settings
}

/**
 * Ensures there is something to scan. On a fresh profile `scanRoots` is empty,
 * so the first launch adopts whichever roots discovery can justify - the
 * harness Helm is running inside, most often. If it can justify none, the value
 * stays empty and the launcher asks.
 */
export async function ensureScanRoots(services: Services): Promise<string[]> {
  if (services.settings.scanRoots.length > 0) return services.settings.scanRoots
  const suggested = await suggestRoots()
  if (suggested.length === 0) return []
  updateSettings(services, { scanRoots: suggested })
  return suggested
}

export async function runScan(
  services: Services,
  opts: { includeGit?: boolean } = {}
): Promise<DiscoveryResult> {
  const roots = await ensureScanRoots(services)
  const result = await scan({ roots, includeGit: opts.includeGit ?? true })
  cacheProjects(services.store, result.projects)
  services.lastScan = result
  return result
}

/**
 * Re-reads git only. The launcher calls this when the window regains focus:
 * a scan walks every `.claude` tree, which is wasted work when the thing that
 * changed while the user was in an editor is the working tree.
 */
export async function refreshGit(services: Services): Promise<Record<string, GitState | null>> {
  const paths = (services.lastScan?.projects ?? readCachedProjects(services.store)).map(
    (p) => p.path
  )
  const states = await readGitStates(paths)

  const asRecord: Record<string, GitState | null> = {}
  for (const [path, state] of states) asRecord[path] = state

  if (services.lastScan) {
    for (const project of services.lastScan.projects) {
      project.git = states.get(project.path) ?? null
    }
    cacheProjects(services.store, services.lastScan.projects)
  }
  return asRecord
}

export function cachedProjects(services: Services): ReturnType<typeof readCachedProjects> {
  return readCachedProjects(services.store)
}
