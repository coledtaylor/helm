import { watch, type FSWatcher } from 'node:fs'
import { resolve, sep } from 'node:path'
import {
  contentScope,
  isInsideRoot,
  listProjectFiles,
  readContentDir,
  readFilesStatus,
  readFileView,
  type ContentDirListing,
  type FileListing,
  type FilesStatus,
  type FileView
} from '@helm/core'

/**
 * The Files view, main's half: a project's tree with git's letters on it, one
 * file read for viewing, every file for Ctrl+P, a watch that keeps all of that
 * current while a session changes the files under it, and the hand-off to VS
 * Code.
 *
 * **Read-only.** Nothing here writes a file. The view exists to read a file
 * beside the session changing it, and the session is the writer; editing is
 * one click away in VS Code, which is a better editor than a pane could be and
 * is not racing an agent's edits.
 *
 * **Scoped.** Every call names a root, and a root has to be a folder Helm
 * already knows - a discovered project, a profile's folder, a hosted session's
 * working directory - before anything under it is listed or read. The window
 * is Helm's own, so this is not the only wall; it is the one that makes "a file
 * in this project" mean what it says.
 */

export interface FilesService {
  dir(root: string, relPath: string): Promise<ContentDirListing>
  status(root: string): Promise<FilesStatus>
  read(root: string, path: string): Promise<FileView>
  list(root: string): Promise<FileListing>
  /**
   * The roots the window wants watched - all of them, every time. A root not
   * named is let go, so a reloaded window that names fewer cannot leak the
   * watches the one before it asked for.
   */
  watch(roots: readonly string[]): void
  /** VS Code's name on this machine, or null where nothing handles `vscode://`. */
  editor(): string | null
  openInEditor(path: string, line: number | null): Promise<{ opened: boolean }>
  stop(): void
}

export interface FilesServiceDeps {
  /** Every folder the view may be pointed at. Read per call, so a rescan counts at once. */
  roots: () => readonly string[]
  /**
   * Paths that changed under a watched root, project-relative and
   * forward-slashed - or null when there were too many to name, which means
   * "re-read whatever you are showing".
   */
  onChanged: (root: string, paths: string[] | null) => void
  /** `app.getApplicationNameForProtocol`: `''` where nothing handles the scheme. */
  protocolHandler: (url: string) => string
  /** `shell.openExternal`. */
  openExternal: (url: string) => Promise<void>
}

/**
 * How long a burst of file events is gathered before the window is told.
 *
 * From the *first* event, not the last: a session writing a file every 100ms
 * would otherwise hold a trailing debounce open for as long as it kept working,
 * and the view beside it would go stale for exactly the stretch somebody is
 * watching it.
 */
const SETTLE_MS = 250

/** Past this many distinct paths in one burst, the window is told "everything". */
const BURST_MAX = 1000

/** How long a project's file list is reused for Ctrl+P, unless a watch says it moved. */
const LIST_TTL_MS = 30_000

/**
 * The repository's own bookkeeping that means the status changed: a stage, a
 * commit, a checkout. Everything else under `.git` - objects, logs, packs - is
 * churn that says nothing a refresh would show.
 */
const GIT_MEANINGFUL = /^\.git\/(index|HEAD|refs\/)/

interface Watched {
  root: string
  watcher: FSWatcher
  pending: Set<string>
  overflow: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const keyOf = (path: string): string => resolve(path).toLowerCase()

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
  const watched = new Map<string, Watched>()
  const lists = new Map<string, { listing: FileListing; at: number }>()

  /** The root as Helm knows it, or a refusal in a sentence. */
  const known = (root: string): string => {
    const key = keyOf(root)
    const found = deps.roots().find((candidate) => keyOf(candidate) === key)
    if (found === undefined) throw new Error(`${root} is not a folder Helm knows, so it will not list or read it.`)
    return resolve(found)
  }

  const flush = (key: string): void => {
    const entry = watched.get(key)
    if (entry === undefined) return
    entry.timer = null
    const paths = entry.overflow ? null : [...entry.pending]
    entry.pending.clear()
    entry.overflow = false
    // A file appeared, went or was renamed, as far as anybody can tell from an
    // event - so the list Ctrl+P searches is rebuilt on its next open.
    lists.delete(key)
    deps.onChanged(entry.root, paths)
  }

  const arm = (key: string, root: string): void => {
    let watcher: FSWatcher
    try {
      // Recursive is one handle on Windows (ReadDirectoryChangesW over the
      // tree), not a watcher per folder, so a large project costs the same as
      // a small one.
      watcher = watch(root, { recursive: true, persistent: false })
    } catch {
      // A root that cannot be watched - gone, or on a filesystem that does not
      // report changes - is still readable. The view works; it just does not
      // update by itself, which is how it worked before there was a watch.
      return
    }
    const entry: Watched = { root, watcher, pending: new Set(), overflow: false, timer: null }
    watcher.on('change', (_event, filename) => {
      if (filename === null) {
        entry.overflow = true
      } else {
        const path = String(filename).split(sep).join('/')
        if (path === '.git' || path.startsWith('.git/')) {
          if (!GIT_MEANINGFUL.test(path)) return
          entry.pending.add('.git')
        } else {
          entry.pending.add(path)
        }
        if (entry.pending.size > BURST_MAX) entry.overflow = true
      }
      entry.timer ??= setTimeout(() => flush(key), SETTLE_MS)
    })
    // The root itself deleted, or the handle lost: told once as "everything",
    // and the watch is let go. The next `watch` call re-arms it if the window
    // still wants it and the folder is back.
    watcher.on('error', () => {
      close(key)
      deps.onChanged(root, null)
    })
    watched.set(key, entry)
  }

  const close = (key: string): void => {
    const entry = watched.get(key)
    if (entry === undefined) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.watcher.close()
    watched.delete(key)
  }

  return {
    dir: async (root, relPath) => readContentDir(contentScope(known(root), 'project'), relPath),

    status: async (root) => readFilesStatus(known(root)),

    read: async (root, path) => readFileView(known(root), path),

    list: async (root) => {
      const project = known(root)
      const key = keyOf(project)
      const cached = lists.get(key)
      if (cached !== undefined && Date.now() - cached.at < LIST_TTL_MS) return cached.listing
      const listing = await listProjectFiles(project)
      lists.set(key, { listing, at: Date.now() })
      return listing
    },

    watch: (roots) => {
      const wanted = new Map<string, string>()
      for (const root of roots) {
        try {
          wanted.set(keyOf(root), known(root))
        } catch {
          // Not a folder Helm knows. Not watched, and not worth an error: the
          // window asks again with the current list every time it changes.
        }
      }
      for (const key of [...watched.keys()]) if (!wanted.has(key)) close(key)
      for (const [key, root] of wanted) if (!watched.has(key)) arm(key, root)
    },

    editor: () => {
      const name = deps.protocolHandler('vscode://')
      return name === '' ? null : name
    },

    openInEditor: async (path, line) => {
      // Only a file inside a folder Helm knows: this hands a path to another
      // program, and "any path the window names" is not a thing to hand on.
      if (!deps.roots().some((root) => isInsideRoot(root, path))) return { opened: false }
      if (deps.protocolHandler('vscode://') === '') return { opened: false }
      try {
        await deps.openExternal(vscodeUrl(path, line))
        return { opened: true }
      } catch {
        return { opened: false }
      }
    },

    stop: () => {
      for (const key of [...watched.keys()]) close(key)
      lists.clear()
    }
  }
}
