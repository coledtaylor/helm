import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConfigSnapshotMeta, ContentDocument, RenderedMarkdown } from '@helm/core'
import type { ArtifactConsoleEntry } from '@helm/ui'
import { helm } from './bridge'
import { readable } from './errors'
import { relativeTo } from './useFiles'

/**
 * One note or artifact open in a file tab: what it says, how it renders, and
 * the save that writes it back.
 *
 * This is the content viewer's document half, moved to where the documents
 * now open. It is per tab rather than one for the window, because two notes
 * can be on screen at once in two panes, and each keeps its own preview,
 * console and conflict.
 *
 * **Reads and writes go through `content:*` with `scopePath` the deepest folder
 * Helm knows that holds the file** - so a note under a harness's `repos/helm`
 * is saved, snapshotted and wikilinked as part of `helm` rather than refused
 * as "not content" by the harness's guard (`assertContentWritable`).
 *
 * A change on disk arrives through the Files view's own watch (`files:changed`)
 * rather than a watch of its own: a document nobody is editing follows it, the
 * way a file read beside a session does; one with unsaved changes is told,
 * and saving is blocked until somebody decides.
 */

export interface ParkedDraft {
  content: string
  /** The hash of the file the draft was typed against. */
  baseHash: string
}

export interface DocumentOptions {
  scopePath: string
  path: string
  kind: 'markdown' | 'html'
  /** The editor is open, so the split preview renders the draft. */
  editing: boolean
  /** A draft this tab left when it was last on screen. */
  parked: ParkedDraft | null
}

export interface DocumentState {
  document: ContentDocument | null
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
  /** Where a `[[wikilink]]` from inside an artifact points, or null when nothing answers to it. */
  resolveWikilink: (target: string) => Promise<string | null>
  /**
   * Whether the draft differs from the file, which turns a change on disk from
   * news into a conflict. Told rather than worked out here, because the draft
   * is the editor's.
   */
  setDirty: (dirty: boolean) => void
}

/** The preview redraws a document, so it waits for a pause rather than a keystroke. */
const PREVIEW_DEBOUNCE_MS = 160
/** An artifact's console is a tail, not a log. */
const CONSOLE_MAX = 50

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const inside = (root: string, path: string): boolean =>
  path.toLowerCase().startsWith(`${root.replace(/[\\/]+$/, '').toLowerCase()}\\`) ||
  path.toLowerCase().startsWith(`${root.replace(/[\\/]+$/, '').toLowerCase()}/`)

/** `helm-content://artifact/<token>/` - everything the artifact loaded is under it. */
const artifactBase = (url: string): string => url.slice(0, url.lastIndexOf('/') + 1)

export function useDocument({ scopePath, path, kind, editing, parked }: DocumentOptions): DocumentState {
  const [document, setDocument] = useState<ContentDocument | null>(null)
  const [version, setVersion] = useState(0)
  const [snapshots, setSnapshots] = useState<ConfigSnapshotMeta[]>([])
  const [artifactUrl, setArtifactUrl] = useState<string | null>(null)
  const [artifactConsole, setArtifactConsole] = useState<ArtifactConsoleEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [external, setExternal] = useState<DocumentState['external']>(null)

  // Read inside listeners and promise callbacks, where the value captured when
  // they were made is the one from then.
  const live = useRef({ document, dirty: false, parked })
  useEffect(() => {
    live.current = { ...live.current, document, parked }
  }, [document, parked])
  const setDirty = useCallback((dirty: boolean) => {
    live.current = { ...live.current, dirty }
  }, [])

  // The file, and the versions of it the save history holds - on open, after a
  // save or a restore, and on Reload.
  const seq = useRef(0)
  useEffect(() => {
    const ticket = ++seq.current
    void helm
      .invoke('content:document', { scopePath, path })
      .then((next) => {
        if (ticket !== seq.current) return
        setDocument(next)
        // A draft typed against a version of the file that is no longer the one
        // on disk: kept, and the conflict said, exactly as if the file had
        // moved while the editor was open.
        const draft = live.current.parked
        if (draft !== null && next.content.hash !== draft.baseHash) {
          setExternal({ hash: next.content.hash, content: next.content.content, exists: next.content.exists })
        }
      })
      .catch((err: unknown) => {
        if (ticket === seq.current) setError(readable(err))
      })
    void helm
      .invoke('content:snapshots', { scopePath, path })
      .then((rows) => {
        if (ticket === seq.current) setSnapshots(rows)
      })
      .catch(() => undefined)
  }, [scopePath, path, version])

  // An artifact gets a URL its sandboxed frame may load - minted per read, so a
  // changed file is a fresh frame and an old token cannot outlive its page.
  useEffect(() => {
    if (kind !== 'html') return
    let current = true
    void helm
      .invoke('content:artifact', { scopePath, path })
      .then((minted) => {
        if (!current) return
        setArtifactConsole([])
        setArtifactUrl(minted.url)
      })
      .catch((err: unknown) => {
        if (current) setError(readable(err))
      })
    return () => {
      current = false
    }
  }, [kind, scopePath, path, version])

  // What this artifact logged, and nothing another tab's did.
  useEffect(() => {
    if (artifactUrl === null) return undefined
    const base = artifactBase(artifactUrl)
    return helm.on('content:artifactConsole', (entry) => {
      if (!entry.source.startsWith(base) && !entry.source.endsWith('://unknown')) return
      setArtifactConsole((current) => [...current.slice(-(CONSOLE_MAX - 1)), entry])
    })
  }, [artifactUrl])

  // The file changed on disk. Followed when nothing is typed over it; a
  // conflict, held until somebody decides, when something is.
  useEffect(
    () =>
      helm.on('files:changed', ({ root, paths }) => {
        if (!inside(root, path)) return
        if (paths !== null && !paths.some((changed) => sameFile(changed, relativeTo(root, path)))) return
        void helm
          .invoke('content:document', { scopePath, path })
          .then((next) => {
            const before = live.current.document
            if (before !== null && before.content.hash === next.content.hash) return
            if (live.current.dirty) {
              setExternal({ hash: next.content.hash, content: next.content.content, exists: next.content.exists })
              return
            }
            setDocument(next)
            if (kind === 'html') setVersion((n) => n + 1)
          })
          .catch(() => undefined)
      }),
    [scopePath, path, kind]
  )

  // -------------------------------------------------------------------------
  // The split preview
  // -------------------------------------------------------------------------
  const [draft, setDraftState] = useState('')
  const [debounced, setDebounced] = useState('')
  const setDraft = useCallback((next: string) => setDraftState(next), [])
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(draft), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  const [preview, setPreview] = useState<{ source: string; rendered: RenderedMarkdown } | null>(null)
  const previewSeq = useRef(0)
  useEffect(() => {
    if (!editing || kind !== 'markdown') return
    const ticket = ++previewSeq.current
    void helm
      .invoke('content:render', { scopePath, path, source: debounced })
      .then((rendered) => {
        if (ticket === previewSeq.current) setPreview({ source: debounced, rendered })
      })
      .catch(() => undefined)
  }, [editing, kind, scopePath, path, debounced])

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------
  const save = useCallback(
    (content: string) => {
      const loaded = live.current.document
      if (loaded === null) return
      setSaving(true)
      setError(null)
      void helm
        .invoke('content:write', {
          scopePath,
          path,
          content,
          expectedHash: loaded.content.exists ? loaded.content.hash : null,
          reason: 'edit'
        })
        .then((result) => {
          if (result.ok) {
            setExternal(null)
            setVersion((n) => n + 1)
            return
          }
          if (result.conflict) {
            setExternal({ hash: result.conflict.onDiskHash, content: result.conflict.onDiskContent, exists: true })
            return
          }
          setError(result.error ?? 'The file could not be written.')
        })
        .catch((err: unknown) => setError(readable(err)))
        .finally(() => setSaving(false))
    },
    [scopePath, path]
  )

  const reload = useCallback(() => {
    setExternal(null)
    setError(null)
    setVersion((n) => n + 1)
  }, [])

  const restore = useCallback(
    (snapshot: ConfigSnapshotMeta) => {
      setSaving(true)
      void helm
        .invoke('content:restore', { id: snapshot.id, path })
        .then((result) => {
          if (!result.ok) {
            setError(result.error ?? 'That version could not be restored.')
            return
          }
          setExternal(null)
          setVersion((n) => n + 1)
        })
        .catch((err: unknown) => setError(readable(err)))
        .finally(() => setSaving(false))
    },
    [path]
  )

  const resolveWikilink = useCallback(
    (target: string) =>
      helm
        .invoke('content:wikilink', { scopePath, target, from: path })
        .then((answer) => answer.path)
        .catch(() => null),
    [scopePath, path]
  )

  return {
    document,
    preview: editing ? (preview?.rendered ?? null) : null,
    previewPending: editing && (preview === null || preview.source !== draft),
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
    resolveWikilink,
    setDirty
  }
}
