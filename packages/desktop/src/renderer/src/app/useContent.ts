import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigSnapshotMeta,
  ContentDirListing,
  ContentDocument,
  ContentFile,
  ContentScope,
  ContentSearchResult,
  ContentTree,
  ContentViewMode,
  RenderedMarkdown
} from '@helm/core'
import type { ArtifactConsoleEntry, ContentMode } from '@helm/ui'
import { helm } from './bridge'

/**
 * The content viewer's renderer state.
 *
 * Nothing here parses markdown, reads a file, or writes one. The window asks
 * for finished HTML and gets it, which is what keeps shiki's grammars out of
 * the browser bundle and the parse for a 21 KB note off the thread that has to
 * keep scrolling at 60 Hz.
 *
 * Two pieces of state are worth naming. `highlight` is the search term the
 * document was opened from, kept so the reading view can mark the passage
 * rather than dropping the reader at the top of a long note. And `previewKey`
 * is what makes the split preview honest: it is the draft the last render was
 * asked for, so "the preview is behind the text" is a comparison rather than a
 * flag that can disagree with what is on screen.
 */

export interface ContentState {
  scopes: ContentScope[]
  scopePath: string
  setScopePath: (path: string) => void
  scope: ContentScope | null

  tree: ContentTree | null
  treeLoading: boolean
  refresh: () => void
  refreshing: boolean

  /** Curated roots or a file tree. The scope's kind picks the first answer only. */
  view: ContentViewMode
  setView: (view: ContentViewMode) => void
  /** True while `view` is still whatever the scope's kind chose. */
  viewIsDefault: boolean
  /** One listing per directory the reader has opened, keyed by scope-relative path. */
  dirs: ReadonlyMap<string, ContentDirListing>
  expanded: ReadonlySet<string>
  toggleDir: (relPath: string) => void
  /** Directories with a read in flight, so a row can say it is working. */
  loadingDirs: ReadonlySet<string>

  query: string
  setQuery: (query: string) => void
  search: ContentSearchResult | null
  searching: boolean

  selected: ContentFile | null
  /** What the list marks as current, which is known before the document arrives. */
  selectedPath: string | null
  select: (file: ContentFile | null, line?: number) => void
  /** Opens by absolute path - what a `[[wikilink]]` and a tree row do. */
  openPath: (path: string, heading?: string | null) => void
  /** A `[[wikilink]]` clicked inside a sandboxed HTML artifact. */
  openWikilink: (target: string, heading: string | null) => void
  document: ContentDocument | null
  /** The term the document was opened from, marked in the reading view. */
  highlight: string | null

  mode: ContentMode
  setMode: (mode: ContentMode) => void
  preview: RenderedMarkdown | null
  previewPending: boolean
  setDraft: (draft: string) => void

  artifactUrl: string | null
  artifactConsole: ArtifactConsoleEntry[]

  snapshots: ConfigSnapshotMeta[]
  saving: boolean
  error: string | null
  external: { hash: string; content: string; exists: boolean } | null
  save: (content: string) => void
  reload: () => void
  restore: (snapshot: ConfigSnapshotMeta) => void
  dirty: boolean
  setDirty: (dirty: boolean) => void
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

interface Answered<T> {
  key: string
  value: T
}

/** Long enough that a word typed at speed is one search, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 90
/** The preview redraws a document, so it waits for a pause rather than a keystroke. */
const PREVIEW_DEBOUNCE_MS = 160

export function useContent(): ContentState {
  const [scopes, setScopes] = useState<ContentScope[]>([])
  const [scopePath, setScopePathState] = useState('')

  const [treeAnswer, setTreeAnswer] = useState<Answered<ContentTree | null> | null>(null)
  const [treeVersion, setTreeVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  /**
   * The mode, per scope, and only where somebody chose one.
   *
   * A scope nobody has touched opens on its kind's default - harness to
   * curated, project to a tree - and a scope somebody switched stays switched
   * for as long as the pane is open. Remembering it per scope rather than
   * globally is what stops "I looked at one project as a tree" from turning
   * every harness into a tree afterwards, and forgetting it on the way back is
   * what would make the control feel like it had not worked.
   */
  const [chosenView, setChosenView] = useState<ReadonlyMap<string, ContentViewMode>>(new Map())
  const [dirs, setDirs] = useState<ReadonlyMap<string, ContentDirListing>>(new Map())
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())

  const [query, setQueryState] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchAnswer, setSearchAnswer] = useState<Answered<ContentSearchResult | null> | null>(null)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<string | null>(null)
  const [docAnswer, setDocAnswer] = useState<Answered<ContentDocument> | null>(null)
  const [docVersion, setDocVersion] = useState(0)
  const [snapshotAnswer, setSnapshotAnswer] = useState<Answered<ConfigSnapshotMeta[]> | null>(null)

  const [mode, setModeState] = useState<ContentMode>('read')
  const [draft, setDraftState] = useState('')
  const [previewAnswer, setPreviewAnswer] = useState<Answered<RenderedMarkdown> | null>(null)

  const [artifactUrl, setArtifactUrl] = useState<string | null>(null)
  const [artifactConsole, setArtifactConsole] = useState<ArtifactConsoleEntry[]>([])

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [external, setExternal] = useState<ContentState['external']>(null)
  const [dirty, setDirty] = useState(false)

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------
  const loadScopes = useCallback(() => {
    void helm.invoke('content:scopes').then((list) => {
      setScopes(list)
      setScopePathState((current) => (current === '' ? (list[0]?.path ?? '') : current))
    })
  }, [])

  useEffect(loadScopes, [loadScopes])

  useEffect(() => {
    const offDiscovery = helm.on('discovery:updated', loadScopes)
    const offProfiles = helm.on('profiles:changed', loadScopes)
    return () => {
      offDiscovery()
      offProfiles()
    }
  }, [loadScopes])

  const scope = useMemo(
    () => scopes.find((s) => s.path.toLowerCase() === scopePath.toLowerCase()) ?? null,
    [scopes, scopePath]
  )

  // -------------------------------------------------------------------------
  // The tree
  // -------------------------------------------------------------------------
  const treeKey = `${scopePath}:${String(treeVersion)}`
  const treeSeq = useRef(0)
  useEffect(() => {
    if (scopePath === '') return
    const ticket = ++treeSeq.current
    void helm
      .invoke('content:tree', { scopePath, refresh: treeVersion > 0 })
      .then((result) => {
        if (ticket !== treeSeq.current) return
        setTreeAnswer({ key: treeKey, value: result })
      })
      .catch(() => {
        if (ticket !== treeSeq.current) return
        setTreeAnswer({ key: treeKey, value: null })
      })
      .finally(() => {
        if (ticket === treeSeq.current) setRefreshing(false)
      })
  }, [scopePath, treeKey, treeVersion])

  const tree = treeAnswer?.value ?? null
  const treeLoading = scopePath !== '' && treeAnswer?.key !== treeKey

  const setScopePath = useCallback((path: string) => {
    setScopePathState(path)
    setSelectedPath(null)
    setHighlight(null)
    setExternal(null)
    setError(null)
    setArtifactUrl(null)
    // The listings belong to the scope that was open. Kept, and a different
    // scope's are simply never asked for - but the *expansion* is dropped,
    // because `packages/core` meaning two different directories in two scopes
    // is exactly the case where carrying it over paints the wrong tree.
    setExpanded(new Set())
    setDirs(new Map())
  }, [])

  // -------------------------------------------------------------------------
  // Curated or tree
  // -------------------------------------------------------------------------

  /**
   * The default, from the scope's kind and nothing else.
   *
   * A harness's directories *are* its knowledge layer, so curation is the right
   * answer there. A project's are a repository, where curation produces an
   * arbitrary slice - `packages/` because one package has a README, no `src/`
   * at all - and the honest answer is every file. See SPEC 4.3.
   */
  const defaultView: ContentViewMode = scope?.kind === 'harness' ? 'curated' : 'tree'
  const view = chosenView.get(scopePath.toLowerCase()) ?? defaultView
  const viewIsDefault = !chosenView.has(scopePath.toLowerCase())

  const setView = useCallback(
    (next: ContentViewMode) => {
      setChosenView((current) => new Map(current).set(scopePath.toLowerCase(), next))
    },
    [scopePath]
  )

  const readDir = useCallback(
    (relPath: string) => {
      if (scopePath === '') return
      void helm
        .invoke('content:dir', { scopePath, relPath })
        .then((listing) => setDirs((current) => new Map(current).set(relPath, listing)))
        .catch((err: unknown) => {
          // A listing that never arrives is still an answer, and it has to be
          // written down: `loadingDirs` is derived from "expanded with no
          // listing", so dropping the failure leaves the row pulsing for ever
          // with nothing on screen to say why.
          setDirs((current) =>
            new Map(current).set(relPath, {
              scopePath,
              relPath,
              entries: [],
              ignored: 0,
              ignoreSource: 'default',
              error: readable(err),
              tookMs: 0
            })
          )
        })
    },
    [scopePath]
  )

  // The scope's own directory, whenever the tree is what is on screen. Nothing
  // below it is read until somebody opens it - that is the whole point.
  useEffect(() => {
    if (view !== 'tree' || scopePath === '') return
    readDir('')
  }, [view, scopePath, readDir, treeVersion])

  /**
   * Which directories are still waiting, derived rather than stored.
   *
   * "Expanded and no listing yet" is exactly the set, and holding it as state
   * instead would mean setting it synchronously inside the effect that starts
   * the read - the cascading-render shape the lint rule in this repo refuses,
   * for a value that is already implied by two others.
   */
  const loadingDirs = useMemo(() => {
    const out = new Set<string>()
    for (const relPath of expanded) if (!dirs.has(relPath)) out.add(relPath)
    return out
  }, [expanded, dirs])

  const toggleDir = useCallback(
    (relPath: string) => {
      setExpanded((current) => {
        const next = new Set(current)
        if (next.delete(relPath)) return next
        next.add(relPath)
        return next
      })
      // Re-read on every open rather than serving a listing from the last time
      // this directory was expanded: a tree that is lazy is a tree that has to
      // be current when it is asked, and the read is one `readdir`.
      readDir(relPath)
    },
    [readDir]
  )

  const refresh = useCallback(() => {
    setRefreshing(true)
    loadScopes()
    setTreeVersion((n) => n + 1)
    setDocVersion((n) => n + 1)
    // Every directory the reader has open, re-read. Dropping them instead would
    // collapse the tree under somebody who asked for it to be refreshed.
    setDirs(new Map())
    for (const relPath of expanded) readDir(relPath)
  }, [loadScopes, expanded, readDir])

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  const setQuery = useCallback((next: string) => setQueryState(next), [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const searchKey = `${scopePath}:${debouncedQuery}:${String(treeVersion)}`
  const searchSeq = useRef(0)
  useEffect(() => {
    // An empty box is not a search, and it is not a *pending* search either -
    // the answer is derived below rather than written here, so nothing has to
    // set state in an effect to say "there is nothing to say".
    if (scopePath === '' || debouncedQuery.trim() === '') return
    const ticket = ++searchSeq.current
    void helm
      .invoke('content:search', { scopePath, query: debouncedQuery })
      .then((result) => {
        if (ticket !== searchSeq.current) return
        setSearchAnswer({ key: searchKey, value: result })
      })
      .catch(() => {
        if (ticket !== searchSeq.current) return
        setSearchAnswer({ key: searchKey, value: null })
      })
  }, [scopePath, debouncedQuery, searchKey])

  const search =
    debouncedQuery.trim() === '' ? null : searchAnswer?.key === searchKey ? searchAnswer.value : null
  const searching = query.trim() !== '' && searchAnswer?.key !== searchKey

  // -------------------------------------------------------------------------
  // The open document
  // -------------------------------------------------------------------------
  const selected = useMemo(() => {
    if (selectedPath === null) return null
    const listed = tree?.files.find((file) => file.path === selectedPath)
    // A file opened through a wikilink before the tree has caught up: main
    // still answers for it, and its own answer carries the row.
    return listed ?? (docAnswer?.value.file.path === selectedPath ? docAnswer.value.file : null)
  }, [tree, selectedPath, docAnswer])

  const docKey = `${selectedPath ?? ''}:${String(docVersion)}`
  const docSeq = useRef(0)
  useEffect(() => {
    if (selectedPath === null || scopePath === '') return
    const ticket = ++docSeq.current
    void helm
      .invoke('content:document', { scopePath, path: selectedPath })
      .then((result) => {
        if (ticket !== docSeq.current) return
        setDocAnswer({ key: docKey, value: result })
      })
      .catch((err: unknown) => {
        if (ticket !== docSeq.current) return
        setError(readable(err))
      })
    void helm
      .invoke('content:snapshots', { scopePath, path: selectedPath })
      .then((rows) => setSnapshotAnswer({ key: docKey, value: rows }))
      .catch(() => undefined)
  }, [scopePath, selectedPath, docKey])

  const document = docAnswer?.value.file.path === selectedPath ? docAnswer.value : null
  const snapshots = snapshotAnswer?.key === docKey ? snapshotAnswer.value : []

  /**
   * The external-edit watch is the config console's, reused rather than
   * duplicated: it watches one file at a time and pushes `config:externalChange`
   * when the bytes move. Whichever pane last opened a file owns the watch, which
   * is the file the user is looking at - and the real guarantee is not the watch
   * anyway, it is the hash check inside the write.
   */
  useEffect(() => {
    if (selectedPath === null) return
    void helm.invoke('config:watch', { path: selectedPath })
  }, [selectedPath])

  useEffect(() => {
    return helm.on('config:externalChange', (change) => {
      if (selectedPath === null || change.path.toLowerCase() !== selectedPath.toLowerCase()) return
      void helm.invoke('content:document', { scopePath, path: selectedPath }).then((next) => {
        setExternal({
          hash: change.hash,
          content: next.content.content,
          exists: change.exists
        })
      })
    })
  }, [scopePath, selectedPath])

  const select = useCallback(
    (file: ContentFile | null, line?: number) => {
      setSelectedPath(file?.path ?? null)
      setExternal(null)
      setError(null)
      setArtifactUrl(null)
      setArtifactConsole([])
      setModeState('read')
      // A file opened out of a search result carries the term with it, so the
      // reading view can put the reader on the sentence they searched for. Not
      // when the file was picked out of the plain list - there is no term then.
      setHighlight(line !== undefined || query.trim() !== '' ? query.trim() || null : null)
      if (file?.kind === 'html') {
        void helm
          .invoke('content:artifact', { scopePath, path: file.path })
          .then((minted) => setArtifactUrl(minted.url))
          .catch((err: unknown) => setError(readable(err)))
      }
    },
    [query, scopePath]
  )

  const openPath = useCallback(
    (path: string, heading?: string | null) => {
      setSelectedPath(path)
      setExternal(null)
      setError(null)
      setArtifactUrl(null)
      setArtifactConsole([])
      setModeState('read')
      setHighlight(null)
      void heading
      if (/\.html?$/i.test(path)) {
        void helm
          .invoke('content:artifact', { scopePath, path })
          .then((minted) => setArtifactUrl(minted.url))
          .catch((err: unknown) => setError(readable(err)))
      }
    },
    [scopePath]
  )

  /**
   * A `[[wikilink]]` clicked inside a sandboxed artifact.
   *
   * The frame is deliberately told no paths, so what arrives here is the name
   * between the brackets and nothing more. Main resolves it against the same
   * index a note's links were resolved through - so a link that works in a note
   * works in a lesson - and a name nothing answers to opens nothing, which is
   * the same thing a broken wikilink does in markdown.
   */
  const openWikilink = useCallback(
    (target: string, heading: string | null) => {
      if (selectedPath === null || scopePath === '') return
      void helm
        .invoke('content:wikilink', { scopePath, target, from: selectedPath })
        .then((answer) => {
          if (answer.path !== null) openPath(answer.path, heading)
        })
        .catch(() => undefined)
    },
    [scopePath, selectedPath, openPath]
  )

  // -------------------------------------------------------------------------
  // The split preview
  // -------------------------------------------------------------------------
  const setDraft = useCallback((next: string) => setDraftState(next), [])
  const [debouncedDraft, setDebouncedDraft] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedDraft(draft), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  const previewKey = `${selectedPath ?? ''}:${debouncedDraft.length}:${debouncedDraft.slice(0, 64)}`
  const previewSeq = useRef(0)
  useEffect(() => {
    if (mode !== 'edit' || selectedPath === null || selected?.kind !== 'markdown') return
    const ticket = ++previewSeq.current
    void helm
      .invoke('content:render', { scopePath, path: selectedPath, source: debouncedDraft })
      .then((result) => {
        if (ticket !== previewSeq.current) return
        setPreviewAnswer({ key: previewKey, value: result })
      })
      .catch(() => undefined)
  }, [mode, scopePath, selectedPath, selected?.kind, debouncedDraft, previewKey])

  const preview = previewAnswer?.value ?? null
  const previewPending = mode === 'edit' && (previewAnswer?.key !== previewKey || draft !== debouncedDraft)

  const setMode = useCallback((next: ContentMode) => {
    setModeState(next)
    // Leaving the reading view drops the search mark: it was placed to find a
    // passage, and carrying it into an editor would highlight text the editor
    // cannot show a highlight on anyway.
    if (next === 'edit') setHighlight(null)
  }, [])

  // -------------------------------------------------------------------------
  // Artifact console
  // -------------------------------------------------------------------------
  // Cleared where the artifact is opened rather than in an effect on the URL:
  // the buffer belongs to one document, and the moment it stops belonging to
  // the last one is the moment a different one is asked for.
  useEffect(() => {
    return helm.on('content:artifactConsole', (entry) => {
      setArtifactConsole((current) => [...current.slice(-49), entry])
    })
  }, [])

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------
  const save = useCallback(
    (content: string) => {
      if (selectedPath === null || document === null) return
      setSaving(true)
      setError(null)
      void helm
        .invoke('content:write', {
          scopePath,
          path: selectedPath,
          content,
          expectedHash: document.content.exists ? document.content.hash : null,
          reason: 'edit'
        })
        .then((result) => {
          if (result.ok) {
            setExternal(null)
            setDocVersion((n) => n + 1)
            setTreeVersion((n) => n + 1)
            return
          }
          if (result.conflict) {
            setExternal({
              hash: result.conflict.onDiskHash,
              content: result.conflict.onDiskContent,
              exists: true
            })
            return
          }
          setError(result.error ?? 'The file could not be written.')
        })
        .catch((err: unknown) => setError(readable(err)))
        .finally(() => setSaving(false))
    },
    [scopePath, selectedPath, document]
  )

  const reload = useCallback(() => {
    setExternal(null)
    setDocVersion((n) => n + 1)
  }, [])

  const restore = useCallback(
    (snapshot: ConfigSnapshotMeta) => {
      if (selectedPath === null) return
      setSaving(true)
      void helm
        .invoke('content:restore', { id: snapshot.id, path: selectedPath })
        .then((result) => {
          if (!result.ok) {
            setError(result.error ?? 'That version could not be restored.')
            return
          }
          setExternal(null)
          setDocVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) => setError(readable(err)))
        .finally(() => setSaving(false))
    },
    [selectedPath]
  )

  return {
    scopes,
    scopePath,
    setScopePath,
    scope,
    tree,
    treeLoading,
    refresh,
    refreshing,
    view,
    setView,
    viewIsDefault,
    dirs,
    expanded,
    toggleDir,
    loadingDirs,
    query,
    setQuery,
    search,
    searching,
    selected,
    selectedPath,
    select,
    openPath,
    openWikilink,
    document,
    highlight,
    mode,
    setMode,
    preview,
    previewPending,
    setDraft,
    artifactUrl,
    artifactConsole,
    snapshots,
    saving,
    error,
    external,
    save,
    reload,
    restore,
    dirty,
    setDirty
  }
}
