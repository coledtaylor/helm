import { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@helm/core'
import type { ClaudeStatus } from '../../../shared/ipc'
import { helm } from './bridge'

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

export interface SetupState {
  status: ClaudeStatus | null
  checking: boolean
  suggestions: string[]
  /** Whether the setup pane owns the window. */
  needed: boolean
  recheck: () => void
  locateClaude: () => void
  acceptSuggestion: (path: string) => void
  finish: () => void

  /** The create-a-harness dialog, which is reachable long after first run. */
  dialog: HarnessDialogMode | null
  dialogDir: string
  dialogProblems: string[]
  creating: boolean
  openDialog: (mode: HarnessDialogMode) => void
  closeDialog: () => void
  chooseDialogDir: () => void
  createHarness: (request: { mode: HarnessDialogMode; dir: string; name: string }) => void

  /** Set for the session once the version banner has been dismissed. */
  bannerDismissed: boolean
  dismissBanner: () => void
}

export function useSetup(
  settings: AppSettings | null,
  /** Called when the roots have changed and the tree should be rebuilt. */
  onRootsChanged: () => void
): SetupState {
  const [status, setStatus] = useState<ClaudeStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [dialog, setDialog] = useState<HarnessDialogMode | null>(null)
  const [dialogDir, setDialogDir] = useState('')
  const [dialogProblems, setDialogProblems] = useState<string[]>([])
  const [creating, setCreating] = useState(false)
  const [bannerDismissed, setBannerDismissed] = useState(false)

  /** The button. Shows a spinner, because the user asked and is waiting. */
  const recheck = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:status')
      .then(setStatus)
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    void helm.invoke('roots:suggest').then(setSuggestions)
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
    void helm.invoke('setup:status').then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [settings?.claudePath])

  const locateClaude = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('setup:locateClaude')
      .then((next) => {
        setStatus(next)
        // A newly picked CLI is a reason to look at the banner again, whether it
        // fixed the warning or introduced one.
        setBannerDismissed(false)
      })
      .finally(() => setChecking(false))
  }, [])

  const acceptSuggestion = useCallback(
    (path: string) => {
      void helm.invoke('roots:accept', { path }).then(() => onRootsChanged())
    },
    [onRootsChanged]
  )

  // No local state to update: the main process emits `settings:changed` from
  // the same handler, and the launcher's copy of the settings is the one the
  // pane's visibility is derived from.
  const finish = useCallback(() => {
    void helm.invoke('setup:complete')
  }, [])

  const openDialog = useCallback(
    (mode: HarnessDialogMode) => {
      setDialogProblems([])
      // Seeded with somewhere plausible so the common case is two clicks: the
      // parent of an existing root for a new harness, and nothing at all for a
      // conversion, which has to be pointed at a specific folder.
      setDialogDir(mode === 'new' ? (settings?.scanRoots[0] ?? '') : '')
      setDialog(mode)
    },
    [settings]
  )

  const closeDialog = useCallback(() => {
    setDialog(null)
    setDialogProblems([])
  }, [])

  const chooseDialogDir = useCallback(() => {
    void helm
      .invoke('path:chooseDirectory', {
        title: dialog === 'convert' ? 'Choose the folder to convert' : 'Create the harness inside'
      })
      .then(({ path }) => {
        if (path !== null) setDialogDir(path)
      })
  }, [dialog])

  const createHarness = useCallback(
    (request: { mode: HarnessDialogMode; dir: string; name: string }) => {
      setCreating(true)
      setDialogProblems([])
      void helm
        .invoke('harness:create', {
          mode: request.mode,
          dir: request.dir,
          ...(request.name !== '' ? { name: request.name } : {})
        })
        .then((result) => {
          if (result.path === null) {
            setDialogProblems(result.problems)
            return
          }
          setDialog(null)
          // The root was added by the main process in the same call, so what is
          // left is to look at the disk again.
          onRootsChanged()
        })
        .catch((err: unknown) => {
          setDialogProblems([err instanceof Error ? err.message : String(err)])
        })
        .finally(() => setCreating(false))
    },
    [onRootsChanged]
  )

  // One question: has this profile been through setup. Deliberately not "does
  // it have roots" - the pane is where roots are acquired, and one that closed
  // itself when the first folder landed would close halfway through its own job.
  const needed = settings !== null && settings.firstRunCompletedAt === null

  return {
    status,
    checking,
    suggestions,
    needed,
    recheck,
    locateClaude,
    acceptSuggestion,
    finish,
    dialog,
    dialogDir,
    dialogProblems,
    creating,
    openDialog,
    closeDialog,
    chooseDialogDir,
    createHarness,
    bannerDismissed,
    dismissBanner: () => setBannerDismissed(true)
  }
}
