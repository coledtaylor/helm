import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ContentDirListing, ContentScope, FileListing, FilesStatus, FileView } from '@helm/core'
import { helm } from './bridge'
import { readable } from './errors'

/**
 * The Files view's window half: the sidebar's project, its tree and git
 * status, the files open in tabs, the list Ctrl+P searches, and the watches
 * that keep all of it current while a session changes the files under it.
 *
 * What is watched is exactly what is on screen - the sidebar's project while
 * the sidebar shows it, and the project of each file tab in front of a pane -
 * and main is told the whole set every time it changes, so nothing is watched
 * on behalf of a view nobody is looking at.
 */

/** A file tab's file, as last read. */
export interface FileTabState {
  view: FileView | null
  /** The read itself failed; `view` keeps whatever was read before. */
  error: string | null
}

export interface FilesState {
  /** The project the sidebar shows, or null before anything has pointed it anywhere. */
  root: string | null
  setRoot: (root: string) => void
  /** Every folder the sidebar can be pointed at, for its picker. */
  roots: readonly ContentScope[]
  dirs: ReadonlyMap<string, ContentDirListing>
  expanded: ReadonlySet<string>
  loadingDirs: ReadonlySet<string>
  toggleDir: (relPath: string) => void
  status: FilesStatus | null
  /** Each file tab's file, keyed by its lower-cased path. */
  tabs: ReadonlyMap<string, FileTabState>
  /** Every file in `listingRoot`, for Ctrl+P; null while listing. */
  listing: FileListing | null
  /** Lists a project's files for Ctrl+P, once per opening. */
  loadListing: (root: string) => void
  /** Project-relative files opened lately in `root`, most recent first. */
  recentIn: (root: string) => readonly string[]
  noteOpened: (root: string, relPath: string) => void
  /** VS Code's name on this machine, or null where it is not installed. */
  editor: string | null
}

export interface FilesOptions {
  /** The sidebar is showing the Files view. */
  active: boolean
  /** The folder of whatever is in front of the focused pane; the sidebar follows it. */
  follow: string | null
  /** The file tabs in front of a pane - the ones worth reading and watching. */
  shown: ReadonlyArray<{ root: string; path: string }>
  /**
   * Changes whenever the folders Helm knows may have - each scan's result. The
   * picker's list is read again on it: the first scan lands a moment after the
   * window paints, and a list read before it would be empty until the sidebar
   * was closed and opened again.
   */
  revision?: unknown
}

const keyOf = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase()

/** The key a file tab's state is held under in `FilesState.tabs`. */
export const fileKey = keyOf

/** How many recently opened files Ctrl+P offers before anything is typed. */
const RECENT_MAX = 12

/** A path inside `root`, from a project-relative, forward-slashed one. */
export function joinRoot(root: string, relPath: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${relPath.split('/').join(sep)}`
}

/** The inverse, for a path known to be inside `root`. */
export function relativeTo(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '')
  return path.slice(base.length + 1).split(/[\\/]/).join('/')
}

export function useFiles({ active, follow, shown, revision }: FilesOptions): FilesState {
  const [root, setRootState] = useState<string | null>(null)
  const [roots, setRoots] = useState<readonly ContentScope[]>([])
  const [dirs, setDirs] = useState<ReadonlyMap<string, ContentDirListing>>(new Map())
  const [expandedByRoot, setExpandedByRoot] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map())
  const [status, setStatus] = useState<FilesStatus | null>(null)
  const [tabs, setTabs] = useState<ReadonlyMap<string, FileTabState>>(new Map())
  const [listings, setListings] = useState<ReadonlyMap<string, FileListing>>(new Map())
  const [listingRoot, setListingRoot] = useState<string | null>(null)
  const [recent, setRecent] = useState<ReadonlyMap<string, readonly string[]>>(new Map())
  const [editor, setEditor] = useState<string | null>(null)

  /**
   * The root an answer has to be about to be kept. Read inside promise
   * callbacks, where a value captured when the request went out is the root
   * *then* - and a listing for the project somebody just switched away from
   * must not land in the tree of the one they switched to.
   */
  const rootRef = useRef(root)
  useEffect(() => {
    rootRef.current = root
  }, [root])

  const setRoot = useCallback((next: string) => {
    if (rootRef.current !== null && keyOf(rootRef.current) === keyOf(next)) return
    rootRef.current = next
    setRootState(next)
    setDirs(new Map())
    setStatus(null)
  }, [])

  /*
   * The sidebar follows the pane in front: focus a session in another project
   * and the tree is that project's. Adjusted while rendering, on the change of
   * what is followed, rather than in an effect - the sanctioned way to reset
   * state from a prop, and one render instead of two. A pick in the picker
   * holds until the focus moves somewhere else.
   */
  const [followed, setFollowed] = useState<string | null>(null)
  if (follow !== followed) {
    setFollowed(follow)
    if (follow !== null && (root === null || keyOf(root) !== keyOf(follow))) {
      setRootState(follow)
      setDirs(new Map())
      setStatus(null)
    }
  }

  const expanded = useMemo(
    () => (root === null ? new Set<string>() : (expandedByRoot.get(keyOf(root)) ?? new Set<string>())),
    [root, expandedByRoot]
  )

  // Once: what VS Code is called here, if it is here at all.
  useEffect(() => {
    void helm
      .invoke('files:editor')
      .then(({ name }) => setEditor(name))
      .catch(() => setEditor(null))
  }, [])

  // The picker's list, whenever the sidebar is opened onto it - and the first
  // project in it, for a sidebar nothing has pointed anywhere yet.
  //
  // Read whether or not the sidebar is showing it: a note opened from Ctrl+P
  // is saved as part of the deepest of these that holds it.
  useEffect(() => {
    void helm
      .invoke('content:scopes')
      .then((list) => {
        setRoots(list)
        const first = list[0]
        if (active && rootRef.current === null && first !== undefined) setRoot(first.path)
      })
      .catch(() => undefined)
  }, [active, setRoot, revision])

  const readDir = useCallback((relPath: string) => {
    const at = rootRef.current
    if (at === null) return
    void helm
      .invoke('files:dir', { root: at, relPath })
      .catch(
        (err: unknown): ContentDirListing => ({
          // An answer that never arrives still has to be written down: a row
          // that pulses for ever with nothing to say why is worse than an error.
          scopePath: at,
          relPath,
          entries: [],
          ignored: 0,
          ignoreSource: 'default',
          error: readable(err),
          tookMs: 0
        })
      )
      .then((listing) => {
        if (rootRef.current === null || keyOf(rootRef.current) !== keyOf(at)) return
        setDirs((current) => new Map(current).set(relPath, listing))
      })
  }, [])

  const readStatus = useCallback(() => {
    const at = rootRef.current
    if (at === null) return
    void helm
      .invoke('files:status', { root: at })
      .catch(
        (err: unknown): FilesStatus => ({ root: at, repo: null, files: null, error: readable(err) })
      )
      .then((next) => {
        if (rootRef.current === null || keyOf(rootRef.current) !== keyOf(at)) return
        setStatus(next)
      })
  }, [])

  // The tree's top and every folder left open, and the status - whenever the
  // sidebar is opened onto a project, or pointed at another one.
  const expandedRef = useRef(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  useEffect(() => {
    if (!active || root === null) return
    readDir('')
    for (const relPath of expandedRef.current) readDir(relPath)
    readStatus()
  }, [active, root, readDir, readStatus])

  const loadingDirs = useMemo(() => {
    const out = new Set<string>()
    for (const relPath of expanded) if (!dirs.has(relPath)) out.add(relPath)
    return out
  }, [expanded, dirs])

  const toggleDir = useCallback(
    (relPath: string) => {
      const at = rootRef.current
      if (at === null) return
      const opening = !expanded.has(relPath)
      setExpandedByRoot((current) => {
        const set = new Set(current.get(keyOf(at)) ?? [])
        if (opening) set.add(relPath)
        else set.delete(relPath)
        return new Map(current).set(keyOf(at), set)
      })
      // Read on every open rather than served from the last time: a lazy tree
      // has to be current when it is asked, and the read is one `readdir`.
      if (opening) readDir(relPath)
    },
    [readDir, expanded]
  )

  // -------------------------------------------------------------------------
  // File tabs
  // -------------------------------------------------------------------------

  const readFile = useCallback((fileRoot: string, path: string) => {
    void helm
      .invoke('files:read', { root: fileRoot, path })
      .then((view) => setTabs((current) => new Map(current).set(keyOf(path), { view, error: null })))
      .catch((err: unknown) =>
        setTabs((current) => {
          const before = current.get(keyOf(path))
          return new Map(current).set(keyOf(path), { view: before?.view ?? null, error: readable(err) })
        })
      )
  }, [])

  /*
   * Each file tab in front of a pane is read when it comes to the front - a
   * tab that sat behind another while a session edited its file is current
   * the moment it is looked at - and again whenever the watch says it moved.
   */
  const shownKey = shown.map((tab) => `${tab.root}\u0000${tab.path}`).join('\u0001')
  const shownRef = useRef(shown)
  useEffect(() => {
    shownRef.current = shown
  }, [shown])
  useEffect(() => {
    for (const tab of shownRef.current) readFile(tab.root, tab.path)
  }, [shownKey, readFile])

  // -------------------------------------------------------------------------
  // Watching
  // -------------------------------------------------------------------------

  const watchedKey = useMemo(() => {
    const set = new Map<string, string>()
    if (active && root !== null) set.set(keyOf(root), root)
    for (const tab of shown) set.set(keyOf(tab.root), tab.root)
    return [...set.values()].sort().join('\u0000')
  }, [active, root, shown])

  useEffect(() => {
    const wanted = watchedKey === '' ? [] : watchedKey.split('\u0000')
    void helm.invoke('files:watch', { roots: wanted }).catch(() => undefined)
  }, [watchedKey])

  // Nothing is watched for a window that has gone.
  useEffect(() => () => void helm.invoke('files:watch', { roots: [] }).catch(() => undefined), [])

  const activeRef = useRef(active)
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(
    () =>
      helm.on('files:changed', ({ root: changed, paths }) => {
        const changedKey = keyOf(changed)
        const named = paths === null ? null : new Set(paths.map((path) => path.toLowerCase()))

        // Ctrl+P's list is left alone. It used to be dropped here, and nothing
        // asked for it again until the dialog was opened afresh - so in a
        // folder that changes every second or two, which a session working in
        // it is, the dialog sat on "Listing" for as long as it was open. Main
        // drops its own cache on the same change, so the next opening lists
        // again; until then the list on screen is the one it opened with.

        // The sidebar: the status, and each open folder something changed in.
        const at = rootRef.current
        if (activeRef.current && at !== null && keyOf(at) === changedKey) {
          readStatus()
          const open = ['', ...expandedRef.current]
          for (const relPath of open) {
            const touched =
              named === null ||
              [...named].some((path) => {
                if (path === '.git') return false
                const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
                return parent === relPath.toLowerCase() || path === relPath.toLowerCase()
              })
            if (touched) readDir(relPath)
          }
        }

        // The files on screen: re-read one that changed, and every one when
        // the repository itself moved - a commit clears the marks.
        for (const tab of shownRef.current) {
          if (keyOf(tab.root) !== changedKey) continue
          const rel = relativeTo(tab.root, tab.path).toLowerCase()
          if (named === null || named.has(rel) || named.has('.git')) readFile(tab.root, tab.path)
        }
      }),
    [readDir, readFile, readStatus]
  )

  // -------------------------------------------------------------------------
  // Ctrl+P
  // -------------------------------------------------------------------------

  /** Asks main every opening, showing the last list for `at` until it answers. */
  const loadListing = useCallback((at: string) => {
    setListingRoot(at)
    void helm
      .invoke('files:list', { root: at })
      .catch(
        (err: unknown): FileListing => ({ root: at, files: [], source: 'walk', truncated: false, error: readable(err) })
      )
      .then((listing) => setListings((current) => new Map(current).set(keyOf(at), listing)))
  }, [])

  const listing = listingRoot === null ? null : (listings.get(keyOf(listingRoot)) ?? null)

  const recentIn = useCallback((at: string) => recent.get(keyOf(at)) ?? [], [recent])

  const noteOpened = useCallback((at: string, relPath: string) => {
    setRecent((current) => {
      const before = current.get(keyOf(at)) ?? []
      const next = [relPath, ...before.filter((path) => path.toLowerCase() !== relPath.toLowerCase())]
      return new Map(current).set(keyOf(at), next.slice(0, RECENT_MAX))
    })
  }, [])

  return {
    root,
    setRoot,
    roots,
    dirs,
    expanded,
    loadingDirs,
    toggleDir,
    status,
    tabs,
    listing,
    loadListing,
    recentIn,
    noteOpened,
    editor
  }
}
