import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullDetailView } from '@helm/core'
import { helm } from './bridge'

/**
 * One pull request's tab, and what fills it.
 *
 * Shaped like the other per-pane hooks: an invoke on mount, a state, and a
 * `refresh` the pane's own control calls. The one thing it does that they do
 * not is remember what it painted **after the pane unmounts**, and that is not
 * an optimisation - it is the difference between a tab strip you can move
 * around in and one that flashes "Reading…" every time you come back to a tab
 * you already had open.
 *
 * Workspace panes are unmounted when their tab is not in front (unlike session
 * panes, which are only hidden, because a terminal cannot rebuild its
 * scrollback from props). Every other pane survives that because its state
 * lives in a hook mounted at the top of `App`; there can be a dozen pull
 * request tabs, so this one keeps its answers in a small map beside the hook
 * instead. `pr:detail` is a SQLite read when the detail is cached, so this
 * would be fast anyway - the map is about the *frame*, not the milliseconds:
 * the pane paints the pull request on the first frame after the tab is
 * clicked, with no empty state in between.
 */

/** Enough for as many pull request tabs as anybody keeps open, and bounded. */
const REMEMBER = 24

const painted = new Map<string, PullDetailView>()

const keyOf = (repoPath: string, number: number): string => `${repoPath}#${String(number)}`

function remember(key: string, view: PullDetailView): void {
  painted.delete(key)
  painted.set(key, view)
  // Insertion order, so the oldest tab's answer is the one that goes.
  for (const stale of painted.keys()) {
    if (painted.size <= REMEMBER) break
    painted.delete(stale)
  }
}

/** Drops what a closed tab was showing. Called when a PR tab is closed. */
export function forgetPullDetail(repoPath: string, number: number): void {
  painted.delete(keyOf(repoPath, number))
}

export interface PullDetailState {
  view: PullDetailView | null
  loading: boolean
  /** Fetches again, ignoring the cached detail. */
  refresh: () => void
  refreshing: boolean
  /** A rejected `pr:detail` - gh missing, unauthenticated, or the fetch failed. */
  error: string | null
}

/** Everything this hook holds, and the pull request it holds it about. */
interface Held {
  key: string
  view: PullDetailView | null
  loading: boolean
  refreshing: boolean
  error: string | null
}

const held = (key: string): Held => ({
  key,
  view: painted.get(key) ?? null,
  // Only a pull request nothing has painted before is worth an empty state.
  loading: !painted.has(key),
  refreshing: false,
  error: null
})

/** Electron prefixes a renderer-side rejection with the channel it came from. */
function readable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '')
}

export function usePullDetail(repoPath: string, number: number): PullDetailState {
  const key = keyOf(repoPath, number)
  const [state, setState] = useState<Held>(() => held(key))
  /** Which pull request the answers arriving are for. */
  const live = useRef(key)

  /**
   * Derived rather than reset in an effect.
   *
   * A hook whose arguments have moved to a different pull request is already
   * showing the wrong one, and an effect that corrected it would paint the old
   * conversation for a frame first. Comparing the key here means the very first
   * render after a change is the new pull request's cached answer.
   */
  const current = state.key === key ? state : held(key)

  /**
   * The fetch, and nothing else.
   *
   * Deliberately free of any synchronous state change so that mounting can call
   * it directly: an effect that set state on its way out would render twice for
   * a value this hook can already derive. Saying "refreshing" is the refresh
   * control's own business, below, where it is an event and not an effect.
   */
  const ask = useCallback(
    (refresh: boolean) => {
      live.current = key

      void helm
        .invoke('pr:detail', { repoPath, number, ...(refresh ? { refresh: true } : {}) })
        .then((next) => {
          remember(key, next)
          if (live.current !== key) return
          setState({ key, view: next, loading: false, refreshing: false, error: null })
        })
        .catch((err: unknown) => {
          if (live.current !== key) return
          // Whatever was painted stays underneath the sentence: a failed
          // refresh is a reason the figures are old, not a reason to take them
          // away.
          setState((was) => ({
            ...(was.key === key ? was : held(key)),
            loading: false,
            refreshing: false,
            error: readable(err)
          }))
        })
    },
    [key, repoPath, number]
  )

  useEffect(() => {
    ask(false)
  }, [ask])

  const refresh = useCallback(() => {
    setState((was) => ({
      ...(was.key === key ? was : held(key)),
      refreshing: true,
      error: null
    }))
    ask(true)
  }, [ask, key])

  return {
    view: current.view,
    loading: current.loading,
    refresh,
    refreshing: current.refreshing,
    error: current.error
  }
}
