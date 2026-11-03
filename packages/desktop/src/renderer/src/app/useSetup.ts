import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, TemplateChoice, TemplatePreview } from '@helm/core'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import type { ClaudeStatus } from '../../../shared/ipc'
import { bridgeFor, helm } from './bridge'

/**
 * First run, and everything that stays true afterwards.
 *
 * The pane is on screen whenever `settings` says there is nothing to scan and
 * no completion stamp - a *state*, not a wizard the app remembers having shown.
 * That is why nothing here holds a "step": quitting halfway through leaves the
 * settings exactly as they were, so the next launch resumes rather than
 * dropping the user into an empty launcher with a small button in the corner.
 *
 * The CLI status is fetched here and used twice: by the setup pane, and by the
 * version banner that outlives it. One request, one answer, so the two surfaces
 * cannot disagree about what version is installed.
 */

export type HarnessDialogMode = 'new' | 'convert'

/**
 * The built-in scaffold's id, written out rather than imported.
 *
 * `MINIMAL_TEMPLATE` is a *value* in `@helm/core`, and a value import of the
 * package root from the renderer reaches `launch/` and `store/` and fails at
 * rollup rather than at typecheck (CLAUDE.md, "Boundaries"). It is one word and
 * it is also the string the main process would answer with; if the two drift,
 * `template:list` disagrees with the picker's default.
 */
const MINIMAL = 'minimal'

const sentence = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * What the pane shows when Claude Code's status could not be read at all -
 * the local host out of reach: nothing found and nothing known, with the
 * sentence that says why in the places the pane says why.
 */
export function unreadableStatus(err: unknown): ClaudeStatus {
  const why = sentence(err)
  return {
    path: null,
    source: null,
    version: null,
    semver: null,
    tested: false,
    testedRange: { min: '', max: '' },
    configDir: '',
    configDirExists: false,
    auth: 'unknown',
    authSignal: why,
    error: why
  }
}

export interface SetupState {
  status: ClaudeStatus | null
  checking: boolean
  suggestions: string[]
  /** Why the suggestions could not be looked for; null when they were. */
  suggestionsError: string | null
  /** Whether the setup pane owns the window. */
  needed: boolean
  recheck: () => void
  locateClaude: () => void
  acceptSuggestion: (path: string) => void
  finish: () => void

  /** The create-a-harness dialog, which is reachable long after first run. */
  dialog: HarnessDialogMode | null
  /**
   * The host the dialog creates on: this PC's (`LOCAL_HOST_KEY`), or a host on
   * another computer by its id. Its templates, its suggested folder, the
   * preview and the harness itself all go through that host's bridge only.
   */
  dialogHost: string
  dialogDir: string
  /** A folder typed for a host on another computer, where there is no picker. */
  typeDialogDir: (dir: string) => void
  dialogProblems: string[]
  creating: boolean
  /** Opens the dialog on `host`, this PC's by default. */
  openDialog: (mode: HarnessDialogMode, host?: string) => void
  closeDialog: () => void
  chooseDialogDir: () => void
  /** The dialog owns its mode once open; the preview has to follow it. */
  setDialogMode: (mode: HarnessDialogMode) => void
  createHarness: (request: {
    mode: HarnessDialogMode
    dir: string
    name: string
    template: string
  }) => void

  /** The picker: `minimal` first, then whatever is in the templates directory. */
  templates: TemplateChoice[]
  templatesDir: string
  templateProblems: string[]
  /** Re-reads them, for when the manager has been authoring over this dialog. */
  refreshTemplates: () => void
  /** Which one is chosen. Reset to `minimal` every time the dialog opens. */
  template: string
  chooseTemplate: (template: string) => void
  /** What "What gets written" lists. Null until the first answer lands. */
  templatePreview: TemplatePreview | null

  /** Set for the session once the version banner has been dismissed. */
  bannerDismissed: boolean
  dismissBanner: () => void
}

export function useSetup(
  settings: AppSettings | null,
  /** Called when a host's roots have changed and its tree should be rebuilt. */
  onRootsChanged: (host: string) => void,
  /**
   * Called with a harness that was created whole. Creating one is a step on
   * the way to working in it, so the caller starts a session there rather
   * than leaving somebody on a page.
   */
  onHarnessCreated?: (path: string, host: string) => void
): SetupState {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<HarnessDialogMode | null>(null)
  const [dialogHost, setDialogHost] = useState<string>(LOCAL_HOST_KEY)
  /** The dialog's host as the last opening left it, for callbacks that outlive a render. */
  const dialogHostRef = useRef<string>(LOCAL_HOST_KEY)
  const [dialogDir, setDialogDir] = useState('')
  const [dialogMode, setDialogMode] = useState<HarnessDialogMode>('new')
  const [dialogProblems, setDialogProblems] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [templates, setTemplates] = useState<TemplateChoice[]>([])
  const [templatesDir, setTemplatesDir] = useState('')
  const [templateProblems, setTemplateProblems] = useState<string[]>([])
  const [template, setTemplate] = useState(MINIMAL)
  const [templatePreview, setTemplatePreview] = useState<TemplatePreview | null>(null)

  /** The button. Shows a spinner, because the user asked and is waiting. */
  const recheck = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:status')
      .then(setStatus, (err: unknown) => setStatus(unreadableStatus(err)))
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    void helm.invoke('roots:suggest').then(
      (next) => {
        setSuggestions(next)
        setSuggestionsError(null)
      },
      (err: unknown) => setSuggestionsError(sentence(err))
    )
  }, [])

  /**
   * Read on mount, and again whenever the chosen CLI changes - however it
   * changed. The picker is one way; a settings write is another, and a banner
   * that only updated for the first would describe a version that is no longer
   * the one Helm would launch.
   *
   * No spinner here: nobody asked for this one, and `checking` is about a
   * button someone is looking at.
   */
  useEffect(() => {
    let cancelled = false
    void helm.invoke('setup:status').then(
      (next) => {
        if (!cancelled) setStatus(next)
      },
      (err: unknown) => {
        if (!cancelled) setStatus(unreadableStatus(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [settings?.claudePath])

  const locateClaude = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:locateClaude')
      .then(
        (next) => {
          setStatus(next)
          // A newly picked CLI is a reason to look at the banner again, whether it
          // fixed the warning or introduced one.
          setBannerDismissed(false)
        },
        (err: unknown) => setStatus(unreadableStatus(err))
      )
      .finally(() => setChecking(false))
  }, [])

  const acceptSuggestion = useCallback(
    (path: string) => {
      void helm.invoke('roots:accept', { path }).then(() => onRootsChanged(LOCAL_HOST_KEY))
    },
    [onRootsChanged]
  )

  // No local state to update: the main process emits `settings:changed` from
  // the same handler, and the launcher's copy of the settings is the one the
  // pane's visibility is derived from.
  const finish = useCallback(() => {
    void helm.invoke('setup:complete')
  }, [])

  /**
   * Re-reads the picker's rows.
   *
   * Called when the dialog opens, and again when the template manager closes
   * over the top of it - those are the two moments the list can have changed
   * under a dialog somebody is still filling in, and the second one is the
   * whole reason this is a callback rather than three lines inside `openDialog`.
   */
  const refreshTemplates = useCallback(() => {
    void bridgeFor(dialogHostRef.current).invoke('template:list').then(
      (listing) => {
        setTemplates(listing.templates)
        setTemplatesDir(listing.dir)
        setTemplateProblems(listing.problems)
      },
      // Could not look: the sentence, in the place a template that could not
      // be read is named, rather than a picker that lists none.
      (err: unknown) => setTemplateProblems([sentence(err)])
    )
  }, [])

  const openDialog = useCallback(
    (mode: HarnessDialogMode, host: string = LOCAL_HOST_KEY) => {
      setDialogProblems([])
      dialogHostRef.current = host
      setDialogHost(host)
      if (host === LOCAL_HOST_KEY) {
        // Seeded with somewhere plausible so the common case is two clicks: the
        // parent of an existing root for a new harness, and nothing at all for a
        // conversion, which has to be pointed at a specific folder.
        setDialogDir(mode === 'new' ? (settings?.scanRoots[0] ?? '') : '')
      } else {
        // A host on another computer has no picker here: its folder is typed in
        // its own path form, prefilled with the first folder it suggests.
        setDialogDir('')
        if (mode === 'new') {
          void bridgeFor(host)
            .invoke('roots:suggest')
            .then(
              (suggested) => {
                if (dialogHostRef.current !== host) return
                setDialogDir((typed) => (typed === '' ? (suggested[0] ?? '') : typed))
              },
              // Nothing suggested: the field stays empty for a path to be typed.
              () => undefined
            )
        }
      }
      setDialogMode(mode)
      // Back to `minimal` every time, deliberately. The picker is not a
      // preference: someone who used a template once has a harness from it, and
      // the next one is a fresh decision rather than a repeat of the last.
      setTemplate(MINIMAL)
      // Nothing from the last open: the effect below fills this in, and until
      // it does an empty list is the truthful thing to show.
      setTemplatePreview(null)
      setDialog(mode)
      // Read on open rather than at mount: a template is a directory somebody
      // can add while Helm is running, and a list fetched once at startup would
      // be stale for the rest of the session.
      refreshTemplates()
    },
    [settings, refreshTemplates]
  )

  /**
   * The file list, re-read whenever the answer would change.
   *
   * Only while the dialog is open, because it is the only thing that shows it.
   * Clearing is `openDialog`'s and `closeDialog`'s job rather than this
   * effect's - a `setState` in an effect body is a cascading render and the
   * lint rule that says so is right here, since "there is no preview" is
   * something those two *know* rather than something to be synchronised.
   */
  useEffect(() => {
    if (dialog === null) return
    let cancelled = false
    void bridgeFor(dialogHost)
      .invoke('template:preview', { template, mode: dialogMode })
      .then((next) => {
        if (!cancelled) setTemplatePreview(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [dialog, dialogHost, dialogMode, template])

  const closeDialog = useCallback(() => {
    setDialog(null)
    setDialogProblems([])
    setTemplatePreview(null)
  }, [])

  const chooseDialogDir = useCallback(() => {
    // The picker browses this PC's folders: a host on another computer's path is typed.
    if (dialogHostRef.current !== LOCAL_HOST_KEY) return
    void helm
      .invoke('path:chooseDirectory', {
        title: dialog === 'convert' ? 'Choose the folder to convert' : 'Create the harness inside'
      })
      .then(({ path }) => {
        if (path !== null) setDialogDir(path)
      })
  }, [dialog])

  const createHarness = useCallback(
    (request: { mode: HarnessDialogMode; dir: string; name: string; template: string }) => {
      const host = dialogHostRef.current
      setCreating(true)
      setDialogProblems([])
      void bridgeFor(host)
        .invoke('harness:create', {
          mode: request.mode,
          dir: request.dir,
          ...(request.name !== '' ? { name: request.name } : {}),
          ...(request.mode === 'new' ? { template: request.template } : {})
        })
        .then((result) => {
          if (result.path === null) {
            setDialogProblems(result.problems)
            return
          }
          // The root was added by the main process in the same call, so the
          // disk is worth another look either way.
          onRootsChanged(host)
          if (result.problems.length > 0) {
            /*
             * A template that applied only partly. The harness exists and is in
             * the tree behind this dialog, so closing would take the only
             * account of what did *not* get written off the screen with it -
             * there is no second place that list is kept. It stays up, saying
             * so, and Cancel is what dismisses it.
             *
             * The first line names what *did* happen, and it is not decoration:
             * this box is the same red one a refusal uses, and a list of
             * problems with no preamble over a harness that was in fact created
             * reads as "nothing happened". Honest about the partial write means
             * honest about both halves of it.
             */
            setDialogProblems([
              `${result.path} was created, but not everything in the template could be written:`,
              ...result.problems
            ])
            return
          }
          setDialog(null)
          onHarnessCreated?.(result.path, host)
        })
        .catch((err: unknown) => {
          setDialogProblems([err instanceof Error ? err.message : String(err)])
        })
        .finally(() => setCreating(false))
    },
    [onRootsChanged, onHarnessCreated]
  )

  // One question: has this profile been through setup. Deliberately not "does
  // it have roots" - the pane is where roots are acquired, and one that closed
  // itself when the first folder landed would close halfway through its own job.
  const needed = settings !== null && settings.firstRunCompletedAt === null

  return {
    status,
    checking,
    suggestions,
    suggestionsError,
    needed,
    recheck,
    locateClaude,
    acceptSuggestion,
    finish,
    dialog,
    dialogHost,
    dialogDir,
    typeDialogDir: setDialogDir,
    dialogProblems,
    creating,
    openDialog,
    closeDialog,
    chooseDialogDir,
    setDialogMode,
    createHarness,
    templates,
    templatesDir,
    templateProblems,
    refreshTemplates,
    template,
    chooseTemplate: setTemplate,
    templatePreview,
    bannerDismissed,
    dismissBanner: () => setBannerDismissed(true)
  }
}
