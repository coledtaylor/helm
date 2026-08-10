import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConfigFile,
  ConfigFileContent,
  ConfigScope,
  ConfigSnapshotMeta,
  ConfigTree,
  DoctorReport,
  EffectiveMcpServer,
  EffectiveView,
  McpPreview,
  McpResult,
  McpScope
} from '@helm/core'
import type { ConfigViewKind } from '@helm/ui'
import { helm } from './bridge'

/**
 * The config console's renderer state.
 *
 * Nothing here touches a file. Every read and every write is a request to the
 * main process, which is not merely the architecture - it is what makes the
 * snapshot rule enforceable. A renderer that could write would be a second path
 * into a `.claude` tree with no undo behind it.
 *
 * The one piece of state that matters is `external`: the file the editor has
 * open changed underneath it. It is set by a push from main's watcher and
 * cleared by reloading or by a save that wins - and it is deliberately *also*
 * settable from a failed save, because the watch is a courtesy and the write's
 * own hash check is the guarantee.
 */

export interface ConfigMcpDraft {
  name: string
  scope: McpScope
  json: string
}

export interface ConfigState {
  scopes: ConfigScope[]
  scopePath: string
  setScopePath: (path: string) => void
  scope: ConfigScope | null

  view: ConfigViewKind
  setView: (view: ConfigViewKind) => void

  tree: ConfigTree | null
  treeLoading: boolean
  refresh: () => void
  refreshing: boolean

  selected: ConfigFile | null
  select: (file: ConfigFile | null) => void
  /** Selects by absolute path, switching scope if the file is in another one. */
  openPath: (path: string) => void
  loaded: ConfigFileContent | null
  snapshots: ConfigSnapshotMeta[]
  saving: boolean
  editorError: string | null
  external: { hash: string; content: string; exists: boolean } | null
  save: (content: string) => void
  reload: () => void
  restore: (snapshot: ConfigSnapshotMeta) => void
  /** The editor's text differs from the file. Marks the row in the list. */
  dirty: boolean
  setDirty: (dirty: boolean) => void

  effectiveProfileId: number | null
  setEffectiveProfileId: (id: number | null) => void
  effectiveCwd: string
  setEffectiveCwd: (cwd: string) => void
  effective: EffectiveView | null
  effectiveLoading: boolean
  effectiveError: string | null

  mcpServers: EffectiveMcpServer[]
  mcpDraft: ConfigMcpDraft
  setMcpDraft: (draft: ConfigMcpDraft) => void
  mcpPreview: McpPreview | null
  requestMcpPreview: () => void
  cancelMcpPreview: () => void
  applyMcp: () => void
  mcpApplying: boolean
  mcpResult: McpResult | null
  dismissMcpResult: () => void
  removeMcp: (server: EffectiveMcpServer) => void
  approveMcp: (server: EffectiveMcpServer, approved: boolean) => void
  mcpListing: McpResult | null
  mcpListing_busy: boolean
  runMcpList: () => void

  doctor: DoctorReport | null
  doctorRunning: boolean
  runDoctor: () => void
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

const EMPTY_DRAFT: ConfigMcpDraft = { name: '', scope: 'project', json: '' }

/**
 * An answer and the question it answers.
 *
 * The same shape `useHistory` uses, for the same reason: "is this still
 * loading" becomes a comparison rather than a second piece of state that has to
 * be set inside the effect which starts the request - and a `loading` flag that
 * can disagree with the value beside it is the bug this makes unrepresentable.
 */
interface Answered<T> {
  key: string
  value: T
}

export function useConfig(): ConfigState {
  const [scopes, setScopes] = useState<ConfigScope[]>([])
  const [scopePath, setScopePathState] = useState('')
  const [view, setView] = useState<ConfigViewKind>('files')

  const [treeAnswer, setTreeAnswer] = useState<Answered<ConfigTree | null> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileAnswer, setFileAnswer] = useState<Answered<ConfigFileContent> | null>(null)
  const [snapshotAnswer, setSnapshotAnswer] = useState<Answered<ConfigSnapshotMeta[]> | null>(null)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [external, setExternal] = useState<ConfigState['external']>(null)
  const [dirty, setDirty] = useState(false)

  const [effectiveProfileId, setEffectiveProfileId] = useState<number | null>(null)
  /** Null until the user types one, in which case the scope on screen is used. */
  const [cwdOverride, setCwdOverride] = useState<string | null>(null)
  const [effectiveAnswer, setEffectiveAnswer] = useState<Answered<EffectiveView> | null>(null)
  const [effectiveError, setEffectiveError] = useState<string | null>(null)

  const [mcpDraft, setMcpDraft] = useState<ConfigMcpDraft>(EMPTY_DRAFT)
  const [mcpPreview, setMcpPreview] = useState<McpPreview | null>(null)
  const [mcpApplying, setMcpApplying] = useState(false)
  const [mcpResult, setMcpResult] = useState<McpResult | null>(null)
  const [mcpListing, setMcpListing] = useState<McpResult | null>(null)
  const [mcpListingBusy, setMcpListingBusy] = useState(false)

  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [doctorRunning, setDoctorRunning] = useState(false)

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------
  const loadScopes = useCallback(() => {
    void helm.invoke('config:scopes').then((list) => {
      setScopes(list)
      // The user scope first: it is the layer under every other one, and the
      // only scope that is always there.
      setScopePathState((current) => (current === '' ? (list[0]?.path ?? '') : current))
    })
  }, [])

  useEffect(loadScopes, [loadScopes])

  /**
   * Discovery finishes after the first paint and a profile can be saved at any
   * time, and both change what the switcher can reach - a profile's root and
   * overlays are scopes whether or not a scanned root contains them.
   */
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
      .invoke('config:tree', { scopePath })
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
  }, [scopePath, treeKey])

  // A stale tree is still shown while the next one loads - a list that blanks
  // between scopes is worse than one that lags by a frame.
  const tree = treeAnswer?.value ?? null
  const treeLoading = scopePath !== '' && treeAnswer?.key !== treeKey

  const setScopePath = useCallback((path: string) => {
    setScopePathState(path)
    setSelectedPath(null)
    setExternal(null)
    setEditorError(null)
    setMcpPreview(null)
    setMcpResult(null)
    setMcpListing(null)
  }, [])

  /**
   * Re-reads the scope list as well as the tree.
   *
   * Both can go stale for reasons Helm did not cause - a repo cloned into a
   * scanned root, a profile imported in another window - and a refresh that
   * only re-walked the directory already on screen would leave the switcher
   * offering yesterday's answer.
   */
  const refresh = useCallback(() => {
    setRefreshing(true)
    loadScopes()
    setTreeVersion((n) => n + 1)
  }, [loadScopes])

  const selected = useMemo(
    () => tree?.files.find((file) => file.path === selectedPath) ?? null,
    [tree, selectedPath]
  )

  // -------------------------------------------------------------------------
  // The open file
  // -------------------------------------------------------------------------
  /** Bumped to re-read the same file after a write, a restore, or a reload. */
  const [fileVersion, setFileVersion] = useState(0)
  const fileKey = `${selectedPath ?? ''}:${String(fileVersion)}`

  const readSelected = useCallback(
    (path: string, key: string) => {
      void helm
        .invoke('config:read', { path })
        .then((content) => setFileAnswer({ key, value: content }))
        .catch((err: unknown) => setEditorError(readable(err)))
      if (scopePath !== '') {
        void helm
          .invoke('config:snapshots', { scopePath, path })
          .then((rows) => setSnapshotAnswer({ key, value: rows }))
      }
    },
    [scopePath]
  )

  useEffect(() => {
    // Releasing the watch matters on Windows, where a handle on a directory is
    // not free: an app that watches every file it has ever shown is an app that
    // eventually gets in another tool's way.
    void helm.invoke('config:watch', { path: selectedPath })
    if (selectedPath === null) return
    readSelected(selectedPath, fileKey)
  }, [selectedPath, fileKey, readSelected])

  const loaded = fileAnswer?.key === fileKey ? fileAnswer.value : null
  const snapshots = snapshotAnswer?.key === fileKey ? snapshotAnswer.value : []

  // Main's watcher, which fires while the user is still typing rather than when
  // they save. The bytes come with it so "reload" is a decision, not a leap.
  useEffect(
    () =>
      helm.on('config:externalChange', (change) => {
        if (selectedPath === null || change.path.toLowerCase() !== selectedPath.toLowerCase()) {
          return
        }
        void helm.invoke('config:read', { path: change.path }).then((content) => {
          // Not a change if it is what we already have - a save of our own that
          // raced the debounce, most plausibly.
          if (loaded !== null && content.hash === loaded.hash) return
          setExternal({ hash: content.hash, content: content.content, exists: content.exists })
        })
      }),
    [selectedPath, loaded]
  )

  const save = useCallback(
    (content: string) => {
      if (selectedPath === null || scope === null) return
      setSaving(true)
      setEditorError(null)
      void helm
        .invoke('config:write', {
          scopePath: scope.path,
          path: selectedPath,
          content,
          // The hash the editor's text was derived from. Null when it believes
          // the file does not exist - in which case a file that has appeared is
          // itself the conflict.
          expectedHash: loaded?.exists === true ? loaded.hash : null,
          reason: 'edit'
        })
        .then((result) => {
          if (result.conflict) {
            // The guarantee, as opposed to the watcher's courtesy: this runs on
            // every write whether or not `fs.watch` ever said anything.
            setExternal({
              hash: result.conflict.onDiskHash,
              content: result.conflict.onDiskContent,
              exists: true
            })
            return
          }
          if (!result.ok) {
            setEditorError(result.error ?? 'The write was refused.')
            return
          }
          setExternal(null)
          setFileVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) => setEditorError(readable(err)))
        .finally(() => setSaving(false))
    },
    [selectedPath, scope, loaded]
  )

  const reload = useCallback(() => {
    setExternal(null)
    setEditorError(null)
    setFileVersion((n) => n + 1)
  }, [])

  const restore = useCallback(
    (snapshot: ConfigSnapshotMeta) => {
      if (selectedPath === null) return
      setSaving(true)
      setEditorError(null)
      void helm
        .invoke('config:restore', { id: snapshot.id, path: selectedPath })
        .then((result) => {
          if (!result.ok) {
            setEditorError(result.error ?? 'The restore was refused.')
            return
          }
          setExternal(null)
          setFileVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) => setEditorError(readable(err)))
        .finally(() => setSaving(false))
    },
    [selectedPath]
  )

  const select = useCallback((file: ConfigFile | null) => {
    setSelectedPath(file?.path ?? null)
    setEditorError(null)
    setExternal(null)
  }, [])

  /**
   * Opens a file by path, from a link somewhere that is not the list - the
   * effective view's entries, or the file an MCP server was defined in.
   *
   * Switches scope when the file belongs to another one, because otherwise the
   * list beside the editor would be showing a different directory's contents.
   */
  const openPath = useCallback(
    (path: string) => {
      const owner = [...scopes]
        .filter((candidate) => path.toLowerCase().startsWith(candidate.path.toLowerCase()))
        // The longest matching prefix: a repo inside a harness matches both,
        // and the repo is the one the file belongs to.
        .sort((a, b) => b.path.length - a.path.length)[0]
      if (owner && owner.path.toLowerCase() !== scopePath.toLowerCase()) {
        setScopePathState(owner.path)
      }
      setView('files')
      setSelectedPath(path)
      setEditorError(null)
      setExternal(null)
    },
    [scopes, scopePath]
  )

  // -------------------------------------------------------------------------
  // Effective view
  // -------------------------------------------------------------------------
  /**
   * The directory the view is computed for.
   *
   * Derived from the scope on screen until the user types something else, so
   * switching to this tab answers the question about what they were just
   * looking at. The user scope has no working directory of its own - it is the
   * layer *under* one - so it falls through to the first real scope.
   */
  const effectiveCwd =
    cwdOverride ??
    (scope !== null && scope.kind !== 'user'
      ? scope.path
      : (scopes.find((candidate) => candidate.kind !== 'user')?.path ?? ''))

  const effectiveKey = `${String(effectiveProfileId)}:${effectiveCwd}:${String(treeVersion)}`
  const effectiveSeq = useRef(0)
  useEffect(() => {
    if (view !== 'effective') return
    if (effectiveProfileId === null && effectiveCwd.trim() === '') return
    const ticket = ++effectiveSeq.current
    void helm
      .invoke('config:effective', {
        profileId: effectiveProfileId,
        cwd: effectiveProfileId === null ? effectiveCwd : null
      })
      .then((result) => {
        if (ticket !== effectiveSeq.current) return
        setEffectiveAnswer({ key: effectiveKey, value: result })
        setEffectiveError(null)
      })
      .catch((err: unknown) => {
        if (ticket !== effectiveSeq.current) return
        setEffectiveError(readable(err))
      })
  }, [view, effectiveProfileId, effectiveCwd, effectiveKey])

  const effective = effectiveAnswer?.value ?? null
  const effectiveLoading = view === 'effective' && effectiveAnswer?.key !== effectiveKey

  // -------------------------------------------------------------------------
  // MCP
  // -------------------------------------------------------------------------
  /**
   * The MCP panel resolves against the scope on screen, and the effective view
   * is what already knows which servers a directory would load - so it is
   * computed there rather than a second time here.
   */
  const [mcpAnswer, setMcpAnswer] = useState<Answered<EffectiveView | null> | null>(null)
  const mcpCwd = scope?.kind === 'user' ? (scopes.find((s) => s.kind !== 'user')?.path ?? '') : (scope?.path ?? '')
  const mcpSeq = useRef(0)
  const [mcpVersion, setMcpVersion] = useState(0)
  const mcpKey = `${mcpCwd}:${String(mcpVersion)}`
  useEffect(() => {
    if (view !== 'mcp' || mcpCwd === '') return
    const ticket = ++mcpSeq.current
    void helm
      .invoke('config:effective', { cwd: mcpCwd })
      .then((result) => {
        if (ticket === mcpSeq.current) setMcpAnswer({ key: mcpKey, value: result })
      })
      .catch(() => {
        if (ticket === mcpSeq.current) setMcpAnswer({ key: mcpKey, value: null })
      })
  }, [view, mcpCwd, mcpKey])

  const requestMcpPreview = useCallback(() => {
    if (mcpCwd === '') return
    void helm
      .invoke('config:mcpPreview', { ...mcpDraft, cwd: mcpCwd })
      .then(setMcpPreview)
      .catch((err: unknown) =>
        setMcpPreview({
          file: '',
          before: '',
          after: '',
          diff: [],
          replaces: null,
          error: readable(err)
        })
      )
  }, [mcpDraft, mcpCwd])

  const applyMcp = useCallback(() => {
    if (mcpCwd === '') return
    setMcpApplying(true)
    void helm
      .invoke('config:mcpAdd', { ...mcpDraft, cwd: mcpCwd })
      .then((result) => {
        setMcpResult(result)
        if (result.ok) {
          setMcpPreview(null)
          setMcpDraft(EMPTY_DRAFT)
        }
        setMcpVersion((n) => n + 1)
        setTreeVersion((n) => n + 1)
      })
      .catch((err: unknown) =>
        setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
      )
      .finally(() => setMcpApplying(false))
  }, [mcpDraft, mcpCwd])

  const removeMcp = useCallback(
    (server: EffectiveMcpServer) => {
      if (mcpCwd === '') return
      void helm
        .invoke('config:mcpRemove', { name: server.name, scope: server.scope, cwd: mcpCwd })
        .then((result) => {
          setMcpResult(result)
          setMcpVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) =>
          setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
        )
    },
    [mcpCwd]
  )

  const approveMcp = useCallback(
    (server: EffectiveMcpServer, approved: boolean) => {
      if (mcpCwd === '') return
      void helm
        .invoke('config:mcpApprove', { cwd: mcpCwd, name: server.name, approved })
        .then((result) => {
          setMcpResult({
            ok: result.ok,
            output: result.ok
              ? `${server.name} is now ${approved ? 'approved' : 'blocked'} for this project.`
              : (result.error ?? 'The write was refused.'),
            exitCode: null,
            after: '',
            snapshotId: result.snapshotId
          })
          setMcpVersion((n) => n + 1)
          setTreeVersion((n) => n + 1)
        })
        .catch((err: unknown) =>
          setMcpResult({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
        )
    },
    [mcpCwd]
  )

  const runMcpList = useCallback(() => {
    if (mcpCwd === '') return
    setMcpListingBusy(true)
    void helm
      .invoke('config:mcpList', { cwd: mcpCwd })
      .then(setMcpListing)
      .catch((err: unknown) =>
        setMcpListing({ ok: false, output: readable(err), exitCode: null, after: '', snapshotId: null })
      )
      .finally(() => setMcpListingBusy(false))
  }, [mcpCwd])

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  const runDoctor = useCallback(() => {
    setDoctorRunning(true)
    void helm
      .invoke('config:doctor')
      .then(setDoctor)
      .catch((err: unknown) =>
        setDoctor({
          output: '',
          rows: [],
          exitCode: null,
          ranAt: new Date().toISOString(),
          durationMs: 0,
          error: readable(err)
        })
      )
      .finally(() => setDoctorRunning(false))
  }, [])

  return {
    scopes,
    scopePath,
    setScopePath,
    scope,
    view,
    setView,
    tree,
    treeLoading,
    refresh,
    refreshing,
    selected,
    select,
    openPath,
    loaded,
    snapshots,
    saving,
    editorError,
    external,
    save,
    reload,
    restore,
    dirty,
    setDirty,
    effectiveProfileId,
    setEffectiveProfileId,
    effectiveCwd,
    setEffectiveCwd: setCwdOverride,
    effective,
    effectiveLoading,
    effectiveError,
    mcpServers: mcpAnswer?.value?.mcpServers ?? [],
    mcpDraft,
    setMcpDraft,
    mcpPreview,
    requestMcpPreview,
    cancelMcpPreview: useCallback(() => setMcpPreview(null), []),
    applyMcp,
    mcpApplying,
    mcpResult,
    dismissMcpResult: useCallback(() => setMcpResult(null), []),
    removeMcp,
    approveMcp,
    mcpListing,
    mcpListing_busy: mcpListingBusy,
    runMcpList,
    doctor,
    doctorRunning,
    runDoctor
  }
}
