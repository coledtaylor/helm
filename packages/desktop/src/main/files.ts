import { resolve, sep } from 'node:path'
import { isInsideRoot, type DiscoveryResult, type Profile } from '@helm/core'

/**
 * The Files view's one hand-off on this computer: a file opened in VS Code.
 * Everything else the view does - its tree, its reads, its watch - is the
 * local host's (`host/files.ts`).
 *
 * **Scoped.** Only a file inside a folder Helm knows - a discovered project, a
 * profile's folder, a hosted session's working directory - is handed on: this
 * hands a path to another program, and "any path the window names" is not a
 * thing to hand on.
 */

export interface FilesService {
  /** VS Code's name on this machine, or null where nothing handles `vscode://`. */
  editor(): string | null
  openInEditor(path: string, line: number | null): Promise<{ opened: boolean }>
}

export interface FilesServiceDeps {
  /** Every folder a file may be handed on from. Read per call, so a rescan counts at once. */
  roots: () => readonly string[]
  /** `app.getApplicationNameForProtocol`: `''` where nothing handles the scheme. */
  protocolHandler: (url: string) => string
  /** `shell.openExternal`. */
  openExternal: (url: string) => Promise<void>
}

const keyOf = (path: string): string => resolve(path).toLowerCase()

/** What the local host has said of this run's folders. */
export interface KnownFolders {
  /** The last scan, harnesses and projects alike; null before the first. */
  scan: DiscoveryResult | null
  profiles: readonly Profile[]
  sessions: ReadonlyArray<{ cwd: string }>
}

/**
 * Every folder the Files view may be pointed at, and the only ones a file may
 * be handed on from: each scanned harness and project, each folder a saved
 * profile names (its root and its overlays, which a session reads and no scan
 * may have reached), and the folder each hosted session is working in. Each
 * folder once, in that order.
 */
export function filesRoots({ scan, profiles, sessions }: KnownFolders): string[] {
  const roots = new Map<string, string>()
  const add = (path: string): void => {
    const key = keyOf(path)
    if (!roots.has(key)) roots.set(key, path)
  }
  for (const project of scan?.projects ?? []) add(project.path)
  for (const profile of profiles) {
    add(profile.root)
    for (const overlay of profile.overlays) add(overlay)
  }
  for (const session of sessions) add(session.cwd)
  return [...roots.values()]
}

/**
 * A `vscode://file/...` URL for a path, at a line where there is one.
 *
 * Each segment is encoded on its own, so a `#` or a space in a folder name is
 * part of the path rather than the start of a fragment - and the drive's colon
 * is left alone, because VS Code reads `C%3A` as a folder named that.
 */
export function vscodeUrl(path: string, line: number | null): string {
  const segments = resolve(path).split(sep).join('/').replace(/^\/+/, '').split('/')
  const encoded = segments
    .map((segment, index) => (index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join('/')
  const at = line !== null && Number.isInteger(line) && line > 0 ? `:${String(line)}:1` : ''
  return `vscode://file/${encoded}${at}`
}

export function createFilesService(deps: FilesServiceDeps): FilesService {
  return {
    editor: () => {
      const name = deps.protocolHandler('vscode://')
      return name === '' ? null : name
    },

    openInEditor: async (path, line) => {
      if (!deps.roots().some((root) => isInsideRoot(root, path))) return { opened: false }
      if (deps.protocolHandler('vscode://') === '') return { opened: false }
      try {
        await deps.openExternal(vscodeUrl(path, line))
        return { opened: true }
      } catch {
        return { opened: false }
      }
    }
  }
}
