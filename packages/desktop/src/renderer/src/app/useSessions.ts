import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, SessionRecord } from '@helm/core'
import { helm } from './bridge'
import { disposeTerminal, estimateGrid } from './terminals'

/**
 * The renderer's half of session ownership.
 *
 * Main owns the processes and the rows; this owns which of them have a tab and
 * in what order. The split matters at both ends: a tab closed here does not
 * decide whether the process died (main confirms first, and the user can say
 * no), and a process that exits on its own does not remove its tab - the
 * scrollback is still worth reading.
 */

export interface SessionsState {
  /** Open session tabs, in tab-strip order. */
  sessions: SessionRecord[]
  /** Set when the last launch failed, until the next one is attempted. */
  launchError: string | null
  dismissLaunchError: () => void
  /** Spawns a session against a project and returns its id, or null on failure. */
  launch: (project: Project, paneSize: HTMLElement | null) => Promise<number | null>
  /**
   * Takes ownership of a session someone else spawned - a profile launch, which
   * goes out on its own channel because the composition is main's to build.
   * Idempotent, so a record that has already arrived does not open a second tab.
   */
  adopt: (record: SessionRecord) => void
  /** Asks main to end and forget it. Main may ask the user first. */
  close: (id: number) => Promise<boolean>
  /**
   * Helm's own label for a tab. Null clears it, and the tab goes back to the
   * name the CLI was given - which this never changes.
   */
  rename: (id: number, label: string | null) => Promise<void>
  /** Moves a session tab to `toIndex` within the session tabs. */
  reorder: (id: number, toIndex: number) => void
  /** Tells main which pane is on screen, for the exit notification. */
  reportFocus: (id: number | null) => void
}

export function useSessions(onActivate: (id: number) => void): SessionsState {
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [launchError, setLaunchError] = useState<string | null>(null)

  // The subscription below is registered once, so it reaches the caller
  // through a ref rather than closing over the callback it was mounted with.
  const activateRef = useRef(onActivate)
  useEffect(() => {
    activateRef.current = onActivate
  }, [onActivate])

  useEffect(() => {
    const offs = [
      helm.on('session:exit', (record) => {
        // Replaced rather than removed: an exited session keeps its tab and its
        // scrollback until someone closes it.
        setSessions((current) => current.map((s) => (s.id === record.id ? record : s)))
      }),
      helm.on('session:activate', ({ id }) => activateRef.current(id))
    ]

    // A renderer reload (dev HMR, or a crashed renderer) leaves main holding
    // processes this side has forgotten. Adopting them back is the difference
    // between a reload and an orphan.
    void helm.invoke('session:list').then((live) => {
      setSessions((current) => (current.length > 0 ? current : live))
    })

    return () => {
      for (const off of offs) off()
    }
  }, [])

  const launch = useCallback(
    async (project: Project, paneSize: HTMLElement | null): Promise<number | null> => {
      setLaunchError(null)
      const { cols, rows } = estimateGrid(paneSize)
      try {
        const record = await helm.invoke('session:start', {
          cwd: project.path,
          projectPath: project.path,
          name: project.name,
          cols,
          rows
        })
        setSessions((current) => [...current, record])
        return record.id
      } catch (err: unknown) {
        // Electron prefixes the renderer-side rejection with the channel it
        // came from; the sentence main wrote is what the user needs.
        const message = err instanceof Error ? err.message : String(err)
        setLaunchError(message.replace(/^Error invoking remote method '[^']*':\s*/, ''))
        return null
      }
    },
    []
  )

  const adopt = useCallback((record: SessionRecord) => {
    setSessions((current) =>
      current.some((s) => s.id === record.id) ? current : [...current, record]
    )
  }, [])

  const close = useCallback(async (id: number): Promise<boolean> => {
    const { closed } = await helm.invoke('session:close', { id })
    if (!closed) return false
    setSessions((current) => current.filter((s) => s.id !== id))
    disposeTerminal(id)
    return true
  }, [])

  /**
   * The row main answers with is adopted, not the label that was sent - the
   * same shape `settings:write` uses and for the same reason: main normalises
   * (a label of spaces becomes null), and a window that trusted its own input
   * would paint something the database does not hold.
   */
  const rename = useCallback(async (id: number, label: string | null): Promise<void> => {
    const record = await helm.invoke('session:rename', { id, label })
    setSessions((current) => current.map((s) => (s.id === record.id ? record : s)))
  }, [])

  const reorder = useCallback((id: number, toIndex: number) => {
    setSessions((current) => {
      const from = current.findIndex((s) => s.id === id)
      if (from < 0) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      if (!moved) return current
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved)
      return next
    })
  }, [])

  const reportFocus = useCallback((id: number | null) => {
    helm.send('session:focus', { id })
  }, [])

  const dismissLaunchError = useCallback(() => setLaunchError(null), [])

  return {
    sessions,
    launchError,
    dismissLaunchError,
    launch,
    adopt,
    close,
    rename,
    reorder,
    reportFocus
  }
}
