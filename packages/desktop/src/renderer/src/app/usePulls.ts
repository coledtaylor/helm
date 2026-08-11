import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullsSnapshot } from '@helm/core'
import { helm } from './bridge'

/**
 * The window's view of every open pull request.
 *
 * The shape `useHistory` and `useUsage` share: one read for the cache and a
 * subscription for everything after it. Nothing here polls - the timer lives in
 * the main process, where it belongs, because it drives subprocesses and has to
 * keep running whether or not this pane has ever been opened.
 *
 * The first call is `pr:snapshot`, which touches no network at all: it is the
 * SQLite cache, so the pane paints on the frame it mounts and the fetch pass
 * arrives as `pr:changed` whenever it lands.
 */

export interface PullsState {
  snapshot: PullsSnapshot | null
  /** No argument sweeps everything; a path checks one repository. */
  refresh: (repoPath?: string) => void
  refreshing: boolean
  /** A rejected `pr:refresh`. Repository-level failures live on the snapshot. */
  error: string | null
}

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

export function usePulls(): PullsState {
  const [snapshot, setSnapshot] = useState<PullsSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A push that beat the initial read must not be overwritten by it. */
  const pushed = useRef(false)

  useEffect(() => {
    const off = helm.on('pr:changed', (next) => {
      pushed.current = true
      setSnapshot(next)
    })
    void helm.invoke('pr:snapshot').then((next) => {
      if (!pushed.current) setSnapshot(next)
    })
    return off
  }, [])

  const refresh = useCallback((repoPath?: string) => {
    setRefreshing(true)
    setError(null)
    void helm
      .invoke('pr:refresh', repoPath === undefined ? {} : { repoPath })
      .then((next) => {
        pushed.current = true
        setSnapshot(next)
      })
      .catch((err: unknown) => setError(readable(err)))
      .finally(() => setRefreshing(false))
  }, [])

  // `fetching` as well as the local flag: a pass started by the timer, the
  // focus refresh or a settings change is still a pass, and the control that
  // says "checking" has to say so for those too.
  return { snapshot, refresh, refreshing: refreshing || (snapshot?.fetching ?? false), error }
}
