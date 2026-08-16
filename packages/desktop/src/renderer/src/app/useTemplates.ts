import { useCallback, useEffect, useState } from 'react'
import type {
  ConfigScope,
  ConfigTree,
  FolderTemplateKind,
  FolderTemplatePreview,
  TemplateChoice,
  TemplateDetail
} from '@helm/core'
import { helm } from './bridge'

/**
 * Template authoring, in one hook.
 *
 * Two surfaces share it and neither owns it: the manager is reachable from the
 * New Harness dialog *and* from Settings, and "Save as template" is reachable
 * from a harness's project pane. Templates are app-level, so their state is
 * app-level too - a copy per entry point is a copy that goes stale the moment
 * the other one writes.
 *
 * Everything here re-reads rather than patching what it has. A template is a
 * directory somebody can also change in Explorer while Helm is open - that is
 * the whole point of the format - so the list after a write is fetched, never
 * assumed, and the same goes for the file list behind it.
 */

export interface SaveTemplateDialog {
  kind: FolderTemplateKind
  /** The folder being frozen. Empty in folder mode until one is chosen. */
  dir: string
}

export interface TemplatesState {
  templates: TemplateChoice[]
  templatesDir: string
  listProblems: string[]
  /** Re-reads the picker's rows. Called by whatever else shows them, too. */
  refresh: () => void

  managerOpen: boolean
  openManager: () => void
  closeManager: () => void

  selected: string | null
  select: (template: string | null) => void
  detail: TemplateDetail | null

  scopes: ConfigScope[]
  importScope: string | null
  setImportScope: (scopePath: string | null) => void
  importTree: ConfigTree | null

  busy: boolean
  problems: string[]
  notice: string | null

  create: (name: string) => void
  saveMetadata: (request: { name: string; label: string; description: string }) => void
  remove: (template: string) => void
  makeSubstitutable: (path: string) => void
  importFiles: (paths: string[]) => void

  /** The save-as-template / import-folder dialog, or null when it is closed. */
  saveDialog: SaveTemplateDialog | null
  savePreview: FolderTemplatePreview | null
  saveBusy: boolean
  saveProblems: string[]
  /** "Save as template" on a harness's project pane. */
  openSaveAs: (dir: string) => void
  /** "Import folder as template…" in the manager. Opens the folder picker. */
  openImportFolder: () => void
  chooseSaveDir: () => void
  closeSaveDialog: () => void
  save: (request: {
    name: string
    label: string
    description: string
    include: string[]
  }) => void
}

export function useTemplates(): TemplatesState {
  const [templates, setTemplates] = useState<TemplateChoice[]>([])
  const [templatesDir, setTemplatesDir] = useState('')
  const [listProblems, setListProblems] = useState<string[]>([])
  const [managerOpen, setManagerOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<TemplateDetail | null>(null)
  const [scopes, setScopes] = useState<ConfigScope[]>([])
  const [importScope, setImportScopePath] = useState<string | null>(null)
  const [importTree, setImportTree] = useState<ConfigTree | null>(null)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [saveDialog, setSaveDialog] = useState<SaveTemplateDialog | null>(null)
  const [savePreview, setSavePreview] = useState<FolderTemplatePreview | null>(null)
  const [saveBusy, setSaveBusy] = useState(false)
  const [saveProblems, setSaveProblems] = useState<string[]>([])
  /** Bumped after every write, so the reads below re-run without a patch. */
  const [generation, setGeneration] = useState(0)

  const refresh = useCallback(() => setGeneration((current) => current + 1), [])

  /**
   * The list: once at mount, again whenever the manager opens, and again after
   * anything writes.
   *
   * The mount read is for the Settings group's count, which is on a pane
   * somebody scrolls past rather than a surface they opened. The read *on open*
   * is the one that matters: a template is a directory somebody can add in
   * Explorer while Helm is running - that is the whole point of the format - so
   * a list fetched once at startup would be stale for the rest of the session.
   */
  useEffect(() => {
    let cancelled = false
    void helm.invoke('template:list').then((listing) => {
      if (cancelled) return
      setTemplates(listing.templates)
      setTemplatesDir(listing.dir)
      setListProblems(listing.problems)
    })
    return () => {
      cancelled = true
    }
  }, [managerOpen, generation])

  /**
   * The chosen template's files.
   *
   * Nothing is *cleared* here: `select` clears the last answer as it changes
   * the selection, because "there are no files to show yet" is something that
   * function knows rather than something for an effect to synchronise - which
   * is the shape `react-hooks/set-state-in-effect` is an error about, and the
   * same call `useSetup` makes for the harness preview.
   */
  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    void helm
      .invoke('template:detail', { template: selected })
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [selected, generation])

  // The import picker's sources: every `.claude` tree the config console can
  // see, `~/.claude` included. Read when the manager opens rather than at
  // mount, for the same reason the list is.
  useEffect(() => {
    if (!managerOpen) return
    let cancelled = false
    void helm.invoke('config:scopes').then((next) => {
      if (!cancelled) setScopes(next)
    })
    return () => {
      cancelled = true
    }
  }, [managerOpen])

  // Same shape: `setImportScope` below clears the tree it is leaving.
  useEffect(() => {
    if (importScope === null) return
    let cancelled = false
    void helm
      .invoke('config:tree', { scopePath: importScope })
      .then((next) => {
        if (!cancelled) setImportTree(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [importScope, generation])

  /**
   * One place every write lands, because they all end the same way: clear the
   * last answer, run, keep whatever refusal came back, and re-read. A surface
   * that patched its own list from a result would be a surface that disagrees
   * with the disk the first time something else writes there.
   */
  const run = useCallback(
    async <T extends { problems: string[] }>(
      action: Promise<T>,
      onDone: (result: T) => string | null
    ): Promise<void> => {
      setBusy(true)
      setProblems([])
      setNotice(null)
      try {
        const result = await action
        setProblems(result.problems)
        const said = onDone(result)
        if (said !== null) setNotice(said)
      } catch (err) {
        setProblems([err instanceof Error ? err.message : String(err)])
      } finally {
        setBusy(false)
        refresh()
      }
    },
    [refresh]
  )

  const create = useCallback(
    (name: string) => {
      void run(helm.invoke('template:create', { name }), (result) => {
        if (result.template === null) return null
        setSelected(result.template)
        return `${result.template} was created.`
      })
    },
    [run]
  )

  /**
   * The form's Save, which is a rename and a metadata write in that order.
   *
   * Order rather than choice: the folder name *is* the id, so writing the
   * metadata first would write it into the template's old directory and then
   * move it - which works, but leaves the two halves of one Save able to
   * succeed and fail independently in the confusing direction. Renaming first
   * means a refused rename stops before anything is written at all.
   */
  const saveMetadata = useCallback(
    (request: { name: string; label: string; description: string }) => {
      const from = selected
      if (from === null) return
      void run(
        (async () => {
          if (request.name !== '' && request.name !== from) {
            const renamed = await helm.invoke('template:rename', {
              template: from,
              name: request.name
            })
            if (!renamed.ok) return renamed
            setSelected(renamed.template)
          }
          return helm.invoke('template:metadata', {
            template: request.name === '' ? from : request.name,
            label: request.label,
            description: request.description
          })
        })(),
        (result) => (result.ok ? 'Saved.' : null)
      )
    },
    [run, selected]
  )

  const remove = useCallback(
    (template: string) => {
      void run(helm.invoke('template:delete', { template }), (result) => {
        if (!result.ok) return null
        setSelected(null)
        return `${template} was deleted.`
      })
    },
    [run]
  )

  const makeSubstitutable = useCallback(
    (path: string) => {
      if (selected === null) return
      void run(helm.invoke('template:substitute', { template: selected, path }), (result) =>
        result.ok ? `${path} is now ${path}.tpl, and its variables are filled in.` : null
      )
    },
    [run, selected]
  )

  const importFiles = useCallback(
    (paths: string[]) => {
      if (selected === null || importScope === null) return
      void run(
        helm.invoke('template:import', { template: selected, scopePath: importScope, paths }),
        (result) => {
          const parts: string[] = []
          if (result.created.length > 0) parts.push(`copied ${String(result.created.length)} in`)
          if (result.replaced.length > 0) {
            // Named rather than counted: replacing a file the author wrote by
            // hand is the one outcome here nobody would want to discover later.
            parts.push(`replaced ${result.replaced.join(', ')}`)
          }
          return parts.length === 0 ? null : `${parts.join(', ')}.`
        }
      )
    },
    [run, selected, importScope]
  )

  // The preview, whenever the dialog has a folder. The four functions that
  // open, re-point and close the dialog clear the last one; this only fetches.
  useEffect(() => {
    if (saveDialog === null || saveDialog.dir === '') return
    let cancelled = false
    void helm
      .invoke('template:folderPreview', { dir: saveDialog.dir, kind: saveDialog.kind })
      .then((next) => {
        if (!cancelled) setSavePreview(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [saveDialog])

  const openSaveAs = useCallback((dir: string) => {
    setSaveProblems([])
    setSavePreview(null)
    setSaveDialog({ kind: 'harness', dir })
  }, [])

  const chooseSaveDir = useCallback(() => {
    void helm
      .invoke('path:chooseDirectory', { title: 'Choose the folder to import as a template' })
      .then(({ path }) => {
        if (path === null) return
        setSavePreview(null)
        setSaveDialog((current) => (current === null ? current : { ...current, dir: path }))
      })
  }, [])

  const openImportFolder = useCallback(() => {
    setSaveProblems([])
    setSavePreview(null)
    setSaveDialog({ kind: 'folder', dir: '' })
    void helm
      .invoke('path:chooseDirectory', { title: 'Choose the folder to import as a template' })
      .then(({ path }) => {
        // Cancelling the picker closes the dialog rather than leaving an empty
        // one up: it was opened *by* the picker, so an empty one is a dialog
        // nobody asked for.
        setSaveDialog((current) =>
          current === null ? current : path === null ? null : { ...current, dir: path }
        )
      })
  }, [])

  const closeSaveDialog = useCallback(() => {
    setSaveDialog(null)
    setSavePreview(null)
    setSaveProblems([])
  }, [])

  const save = useCallback(
    (request: { name: string; label: string; description: string; include: string[] }) => {
      const dialog = saveDialog
      if (dialog === null) return
      setSaveBusy(true)
      setSaveProblems([])
      void helm
        .invoke('template:fromFolder', {
          dir: dialog.dir,
          kind: dialog.kind,
          name: request.name,
          label: request.label,
          description: request.description,
          include: request.include
        })
        .then((result) => {
          refresh()
          if (!result.ok) {
            setSaveProblems(result.problems)
            return
          }
          setSaveDialog(null)
          setSavePreview(null)
          setSelected(result.template)
          setNotice(
            `${result.template ?? 'The template'} was written - ${String(result.fileCount)} ${
              result.fileCount === 1 ? 'file' : 'files'
            }.`
          )
          // A partial copy is honest rather than silent: the template exists and
          // is in the list behind this, so the entries that could not be copied
          // are carried into the manager rather than closed away with the
          // dialog. The same call `useSetup` makes for a partly-applied template.
          if (result.problems.length > 0) {
            setProblems(result.problems)
            setManagerOpen(true)
          }
        })
        .catch((err: unknown) => {
          setSaveProblems([err instanceof Error ? err.message : String(err)])
        })
        .finally(() => setSaveBusy(false))
    },
    [saveDialog, refresh]
  )

  const openManager = useCallback(() => {
    setProblems([])
    setNotice(null)
    setManagerOpen(true)
  }, [])

  const closeManager = useCallback(() => {
    setManagerOpen(false)
    setSelected(null)
    setImportScopePath(null)
    setProblems([])
    setNotice(null)
  }, [])

  /**
   * Changing the selection, and clearing what belonged to the last one.
   *
   * Both halves here rather than in an effect: the pane has to say "reading"
   * for the template that was just clicked rather than showing the previous
   * one's file list under the new one's name, and *when* that stops being true
   * is something this function knows.
   */
  const select = useCallback((template: string | null) => {
    setSelected(template)
    setDetail(null)
  }, [])

  const setImportScope = useCallback((scopePath: string | null) => {
    setImportScopePath(scopePath)
    setImportTree(null)
  }, [])

  return {
    templates,
    templatesDir,
    listProblems,
    refresh,
    managerOpen,
    openManager,
    closeManager,
    selected,
    select,
    detail,
    scopes,
    importScope,
    setImportScope,
    importTree,
    busy,
    problems,
    notice,
    create,
    saveMetadata,
    remove,
    makeSubstitutable,
    importFiles,
    saveDialog,
    savePreview,
    saveBusy,
    saveProblems,
    openSaveAs,
    openImportFolder,
    chooseSaveDir,
    closeSaveDialog,
    save
  }
}
