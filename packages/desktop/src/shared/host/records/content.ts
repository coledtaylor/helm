import type { ConfigScope, Project } from '@helm/core/types'

/**
 * The config console's scope list and the Files view's artifact addresses,
 * for whichever side asks the host: nothing here reaches Node or a disk.
 */

/** A path as one scope is told from another: separators alike, no trailing one, case ignored. */
const scopeKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * A scanned folder's config scope, from what the scan found there: its
 * `.claude` beside it, which exists when the scan saw it or a `CLAUDE.md`.
 */
export function scannedConfigScope(folder: Project, kind: 'harness' | 'project'): ConfigScope {
  const base = folder.path.replace(/[\\/]+$/, '')
  const separator = base.includes('\\') ? '\\' : '/'
  return {
    kind,
    path: base,
    claudeDir: `${base}${separator}.claude`,
    label: folder.name || base,
    exists: folder.hasClaudeDir || folder.inventory.claudeMd
  }
}

/**
 * The switcher's list, in the order Helm has always given it: the user scope,
 * then the scanned harnesses, then the scanned projects, then every other
 * folder the host lists (a saved profile's root and overlays), each once by
 * its path, ignoring case.
 */
export function configScopesWithScan(host: readonly ConfigScope[], scanned: readonly Project[]): ConfigScope[] {
  const out: ConfigScope[] = []
  const seen = new Set<string>()
  const add = (scope: ConfigScope): void => {
    const key = scopeKey(scope.path)
    if (seen.has(key)) return
    seen.add(key)
    out.push(scope)
  }
  for (const scope of host) if (scope.kind === 'user') add(scope)
  for (const folder of scanned) if (folder.kind === 'harness') add(scannedConfigScope(folder, 'harness'))
  for (const folder of scanned) if (folder.kind !== 'harness') add(scannedConfigScope(folder, 'project'))
  for (const scope of host) if (scope.kind !== 'user') add(scope)
  return out
}

const HOST_ARTIFACT = 'floti-artifact://'
const WINDOW_ARTIFACT = 'helm-content://artifact/'

/** The host's address for one a frame asked the window for, or null for one that is not an artifact's. */
export function hostArtifactUrl(windowUrl: string): string | null {
  return windowUrl.startsWith(WINDOW_ARTIFACT) ? HOST_ARTIFACT + windowUrl.slice(WINDOW_ARTIFACT.length) : null
}

/**
 * The window's address for one the host minted: an artifact frame keeps the
 * window's `helm-content:` scheme, which main answers from the host's bytes.
 */
export function windowArtifactUrl(hostUrl: string): string {
  if (!hostUrl.startsWith(HOST_ARTIFACT))
    throw new Error(`The local host answered an artifact address Helm cannot serve: ${hostUrl}`)
  return WINDOW_ARTIFACT + hostUrl.slice(HOST_ARTIFACT.length)
}
