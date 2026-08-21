import { useCallback, useEffect, useState } from 'react'
import type { LiveSession, SessionResources, SessionsOverview } from '@helm/core'
import { helm } from './bridge'

/**
 * Every live Claude Code session on the machine, and what Helm's own are
 * holding.
 *
 * Two facts with two different costs, so two channels and two lifetimes.
 *
 * The **overview** is machine-wide and effectively free - main is already
 * reading Claude Code's registry every 750ms for the tab dots, and this is the
 * same `readdir`. It is subscribed for the whole life of the window, because
 * the launch-time warning needs it on the project pane and not only on the
 * sessions pane.
 *
 * The **resources** - process tree and ports - cost a 400ms child process per
 * pass, so they are asked for only while something is looking. `watch()` is the
 * whole of that: a pane calls it while it is on screen and main runs no timer
 * and spawns nothing while nobody has. Reference-counted in main, so two
 * watchers cannot switch each other off.
 */

export interface LiveSessionsState {
  /** Every live session on the machine, hosted first. */
  sessions: LiveSession[]
  /** When main last read the registry, epoch ms. Null before the first answer. */
  readAtMs: number | null
  /** What each hosted session is holding, by Helm's session row id. */
  resources: Map<number, SessionResources>
  /**
   * Ask main to run the resource pass while this is true.
   *
   * Balanced: every `watch(true)` needs its `watch(false)`, which is what a
   * `useEffect` cleanup is for.
   */
  watch: (on: boolean) => void
}

export function useLiveSessions(): LiveSessionsState {
  const [overview, setOverview] = useState<SessionsOverview | null>(null)
  const [resources, setResources] = useState<Map<number, SessionResources>>(new Map())

  useEffect(() => {
    const offs = [
      helm.on('sessions:overview', (next) => setOverview(next)),
      // The whole set every time, for the reason `session:activity` sends the
      // whole set: a window that missed one push - mounted late, or reloaded -
      // is corrected by the next one rather than carrying a stale tree.
      helm.on('sessions:resources', (next) => {
        setResources(new Map(next.map((snapshot) => [snapshot.id, snapshot])))
      })
    ]

    // Adopted on mount rather than waited for. An idle machine publishes
    // nothing until something moves, so a pane that waited for the next push
    // would be blank for as long as nobody did anything.
    void helm.invoke('sessions:overview').then(setOverview)
    void helm
      .invoke('sessions:resources')
      .then((next) => setResources(new Map(next.map((snapshot) => [snapshot.id, snapshot]))))

    return () => {
      for (const off of offs) off()
    }
  }, [])

  const watch = useCallback((on: boolean) => {
    helm.send('sessions:watch', { watching: on })
  }, [])

  return {
    sessions: overview?.sessions ?? [],
    readAtMs: overview?.readAtMs ?? null,
    resources,
    watch
  }
}
