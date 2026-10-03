import { useCallback, useRef, useState } from 'react'
import type { HistorySession } from '@helm/core/types'
import type { LaunchedSession, LaunchSessionRequest } from '../../../shared/ipc'
import { helm } from './bridge'
import { readable } from './errors'
import { estimateGrid } from './terminals'

/**
 * The new-session launcher's state: whether it is open, what it reads, and the
 * one call it makes.
 *
 * What it reads is read when it opens and not before. Recency and conversations
 * are facts about the session index, which moves every time a session does, and
 * a launcher that showed the index as it was at startup would offer to reopen
 * the conversation somebody just ended at the bottom of the list - or not at
 * all.
 */
export interface NewSessionState {
  open: boolean
  /** The folder highlighted when it opened. */
  initialPath: string | null
  show: (initialPath: string | null) => void
  hide: () => void
  /** When each folder was last worked in, by lower-cased path. */
  recency: ReadonlyMap<string, number>
  /** Conversations that can be reopened, by lower-cased folder path, for those read so far. */
  resumable: ReadonlyMap<string, readonly HistorySession[]>
  /** Reads the conversations of any of these folders not read since it opened. */
  loadResumable: (paths: readonly string[]) => void
  busy: boolean
  /** Why the last launch failed. */
  error: string | null
  dismissError: () => void
  /** What a launch that did start could not compose. */
  warning: string | null
  dismissWarning: () => void
  /** Starts a session; null, with `error` set, when it could not. */
  launch: (
    request: Omit<LaunchSessionRequest, 'cols' | 'rows'>,
    paneSize: HTMLElement | null
  ) => Promise<LaunchedSession | null>
}

/** Conversations read per folder: the launcher shows three, and a spare costs nothing. */
const PER_FOLDER = 3

export function useNewSession(): NewSessionState {
  const [open, setOpen] = useState(false)
  const [initialPath, setInitialPath] = useState<string | null>(null)
  const [recency, setRecency] = useState<ReadonlyMap<string, number>>(new Map())
  const [resumable, setResumable] = useState<ReadonlyMap<string, readonly HistorySession[]>>(
    new Map()
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  /**
   * Folders asked about since it opened, answered or not, so a folder that
   * scrolls back into view is not asked about twice. Bumped with each opening:
   * an answer to an earlier one belongs to a list that has since been read
   * again.
   */
  const asked = useRef(new Set<string>())
  const opening = useRef(0)

  const show = useCallback((path: string | null) => {
    opening.current += 1
    const current = opening.current
    asked.current = new Set()
    setResumable(new Map())
    setInitialPath(path)
    setError(null)
    setOpen(true)
    void helm
      .invoke('history:projects')
      .then((projects) => {
        if (current !== opening.current) return
        setRecency(new Map(projects.map((project) => [project.project.toLowerCase(), project.lastAt])))
      })
      // Recency only orders the list. Without it the list is alphabetical,
      // which is a worse launcher and still a working one.
      .catch(() => undefined)
  }, [])

  const hide = useCallback(() => {
    setOpen(false)
    setError(null)
  }, [])

  const loadResumable = useCallback((paths: readonly string[]) => {
    const current = opening.current
    for (const path of paths) {
      const key = path.toLowerCase()
      if (asked.current.has(key)) continue
      asked.current.add(key)
      void helm
        .invoke('history:sessions', { project: path, resumableOnly: true, limit: PER_FOLDER })
        .then((page) => {
          if (current !== opening.current) return
          setResumable((map) => new Map(map).set(key, page.sessions))
        })
        // A folder whose conversations could not be read offers none, and
        // starting a new session there still works.
        .catch(() => undefined)
    }
  }, [])

  const launch = useCallback(
    async (
      request: Omit<LaunchSessionRequest, 'cols' | 'rows'>,
      paneSize: HTMLElement | null
    ): Promise<LaunchedSession | null> => {
      setBusy(true)
      setError(null)
      setWarning(null)
      try {
        const { cols, rows } = estimateGrid(paneSize)
        const launched = await helm.invoke('session:launch', { ...request, cols, rows })
        // What did start is in the tab; what could not be composed into it is
        // said once, because the terminal will never say it.
        if (launched.warnings.length > 0) setWarning(launched.warnings.join(' '))
        return launched
      } catch (err: unknown) {
        setError(readable(err))
        return null
      } finally {
        setBusy(false)
      }
    },
    []
  )

  return {
    open,
    initialPath,
    show,
    hide,
    recency,
    resumable,
    loadResumable,
    busy,
    error,
    dismissError: useCallback(() => setError(null), []),
    warning,
    dismissWarning: useCallback(() => setWarning(null), []),
    launch
  }
}
