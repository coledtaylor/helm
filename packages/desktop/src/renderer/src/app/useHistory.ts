import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  HistoryPage,
  HistoryPrompt,
  HistorySession,
  HistorySummary,
  SessionRecord
} from '@helm/core'
import { helm } from './bridge'
import { estimateGrid } from './terminals'

/**
 * The launcher's view of every session on the machine.
 *
 * The list is never filtered in the renderer. Every keystroke is a query
 * against the index in the main process - which measures around a millisecond
 * over 3,470 prompts - because the alternative is shipping the whole prompt
 * corpus across the IPC boundary to filter it in a component that then has to
 * be told when the file underneath it changed.
 */

export type HistoryGrouping = 'recent' | 'project'

export interface HistoryState {
  summary: HistorySummary | null
  page: HistoryPage | null
  loading: boolean
  error: string | null

  search: string
  setSearch: (value: string) => void
  grouping: HistoryGrouping
  setGrouping: (value: HistoryGrouping) => void
  resumableOnly: boolean
  setResumableOnly: (value: boolean) => void
  project: string | null
  setProject: (value: string | null) => void

  /** The row whose detail is on screen, re-read from the current page. */
  selected: HistorySession | null
  select: (session: HistorySession | null) => void
  prompts: HistoryPrompt[]
  promptsLoading: boolean

  refresh: () => void
  refreshing: boolean

  /** Reopens the conversation in a tab. Null when it could not be started. */
  resume: (session: HistorySession, paneSize: HTMLElement | null) => Promise<SessionRecord | null>
  resuming: string | null
  resumeError: string | null
  dismissResumeError: () => void
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

/**
 * Long enough that a typed word is one query rather than seven, short enough
 * that the list feels attached to the keyboard. The query itself is ~1ms; this
 * is about not re-rendering 800 rows per keystroke.
 */
const SEARCH_DEBOUNCE_MS = 90

/**
 * A page and the query it answers.
 *
 * Kept together so "is this list still loading" is a comparison rather than a
 * second piece of state - which would have to be set synchronously inside the
 * effect that starts the query, and a `loading` flag that can disagree with
 * the rows beside it is the bug this shape makes unrepresentable.
 */
interface Answered<T> {
  key: string
  value: T
}

export function useHistory(): HistoryState {
  const [summary, setSummary] = useState<HistorySummary | null>(null)
  const [answer, setAnswer] = useState<Answered<HistoryPage> | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [grouping, setGrouping] = useState<HistoryGrouping>('recent')
  const [resumableOnly, setResumableOnly] = useState(false)
  const [project, setProject] = useState<string | null>(null)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [promptAnswer, setPromptAnswer] = useState<Answered<HistoryPrompt[]> | null>(null)

  const [refreshing, setRefreshing] = useState(false)
  const [resuming, setResuming] = useState<string | null>(null)
  const [resumeError, setResumeError] = useState<string | null>(null)

  useEffect(() => {
    const off = helm.on('history:changed', setSummary)
    void helm.invoke('history:summary').then(setSummary)
    return off
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search])

  /**
   * Re-queried whenever the filters change *or* the index does - a session
   * started in a terminal has to appear in the list, not only in the count in
   * the corner. Keyed on `indexedBytes` and the session count rather than the
   * whole summary object, which is a new reference on every push.
   */
  const indexVersion = `${String(summary?.indexedBytes ?? -1)}:${String(summary?.sessions ?? -1)}`
  const queryKey = JSON.stringify([debouncedSearch, resumableOnly, project, indexVersion])
  const seq = useRef(0)

  useEffect(() => {
    const ticket = ++seq.current
    void helm
      .invoke('history:sessions', {
        search: debouncedSearch,
        resumableOnly,
        ...(project === null ? {} : { project })
      })
      .then((result) => {
        // A slower earlier query must not overwrite a faster later one.
        if (ticket !== seq.current) return
        setAnswer({ key: queryKey, value: result })
        setError(null)
      })
      .catch((err: unknown) => {
        if (ticket !== seq.current) return
        setError(readable(err))
      })
  }, [debouncedSearch, resumableOnly, project, queryKey])

  // Re-read on an index change too: a selected session that is still running
  // in a terminal gains prompts while its detail is on screen.
  const promptKey = selectedId === null ? null : `${selectedId}:${indexVersion}`

  useEffect(() => {
    if (promptKey === null || selectedId === null) return
    let live = true
    void helm.invoke('history:prompts', { sessionId: selectedId }).then((rows) => {
      if (live) setPromptAnswer({ key: promptKey, value: rows })
    })
    return () => {
      live = false
    }
  }, [promptKey, selectedId])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void helm
      .invoke('history:refresh')
      .then(setSummary)
      .catch((err: unknown) => setError(readable(err)))
      .finally(() => setRefreshing(false))
  }, [])

  const resume = useCallback(
    async (session: HistorySession, paneSize: HTMLElement | null) => {
      setResumeError(null)
      setResuming(session.sessionId)
      try {
        const { cols, rows } = estimateGrid(paneSize)
        const result = await helm.invoke('history:resume', {
          sessionId: session.sessionId,
          cols,
          rows
        })
        return result.session
      } catch (err: unknown) {
        setResumeError(readable(err))
        return null
      } finally {
        setResuming(null)
      }
    },
    []
  )

  // The page is only the answer to the query that is current. A stale one is
  // still shown - a list that blanks between keystrokes is worse than one that
  // lags by a frame - but it is reported as loading rather than as the truth.
  const page = answer?.value ?? null
  const loading = answer === null || answer.key !== queryKey
  const prompts = promptAnswer?.key === promptKey ? promptAnswer.value : []
  const promptsLoading = selectedId !== null && promptAnswer?.key !== promptKey

  // Resolved from the current page rather than held as state, so a row whose
  // resumability changed under it shows the new answer instead of the one it
  // was selected with.
  const selected = page?.sessions.find((s) => s.sessionId === selectedId) ?? null

  const select = useCallback((session: HistorySession | null) => {
    setSelectedId(session?.sessionId ?? null)
    setResumeError(null)
  }, [])

  return {
    summary,
    page,
    loading,
    error,
    search,
    setSearch,
    grouping,
    setGrouping,
    resumableOnly,
    setResumableOnly,
    project,
    setProject,
    selected,
    select,
    prompts,
    promptsLoading,
    refresh,
    refreshing,
    resume,
    resuming,
    resumeError,
    dismissResumeError: useCallback(() => setResumeError(null), [])
  }
}
