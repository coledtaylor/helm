import { useCallback, useEffect, useState } from 'react'
import type { RestoreOffer } from '@helm/core/types'
import type { RestoreSessionsRequest, RestoreSessionsResult } from '../../../shared/ipc'
import { helm } from './bridge'
import { readable } from './errors'

/**
 * The window's half of restoring after a crash: the offer main holds, read
 * when the window mounts and again each time the window gets its host back
 * after losing it (`reconnects`), since the new host offers what the old one
 * lost; and the one call that answers it.
 *
 * Where the reopened sessions go is the caller's - it owns the panes. This
 * owns what is said about it afterwards.
 */
export interface RestoreState {
  /** What a crash took, until it is answered. Null when there was nothing. */
  offer: RestoreOffer | null
  busy: boolean
  /**
   * Reopens these, each at its pane's grid, and answers the offer. Resolves to
   * what main did, or null when it refused outright.
   */
  restore: (
    picks: RestoreSessionsRequest['sessions'],
    options?: RestoreOptions
  ) => Promise<RestoreSessionsResult | null>
  /** "Not now": answers the offer with nothing. */
  dismiss: () => void
  /** One line about how it went, for the toast. */
  report: { text: string; failed: boolean } | null
  dismissReport: () => void
}

export interface RestoreOptions {
  /** Nobody was asked (`restoreWithoutAsking`), so the report says it happened. */
  unasked?: boolean
  /** The host the sessions went with, as the window names it; absent when they went with Helm. */
  lostWith?: string
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`

/**
 * What a restore did, in one line, worst news first: what did not come back
 * and why, then what came back short of something, then - only when nobody
 * was asked - that anything happened at all.
 */
export function restoreReport(
  result: RestoreSessionsResult,
  unasked: boolean,
  lostWith?: string
): { text: string; failed: boolean } | null {
  if (result.failed.length > 0) {
    const reasons = result.failed.map(({ name, reason }) => `“${name}” could not be reopened: ${reason}`)
    const back =
      result.restored.length === 0
        ? ''
        : `Reopened ${plural(result.restored.length, 'session', 'sessions')}. `
    return { text: back + reasons.join(' '), failed: true }
  }
  const warnings = result.restored.flatMap((restored) => restored.launched.warnings)
  if (warnings.length > 0) return { text: warnings.join(' '), failed: false }
  if (unasked && result.restored.length > 0) {
    const reopened = `Reopened ${plural(result.restored.length, 'session', 'sessions')}`
    return {
      text:
        lostWith === undefined
          ? `${reopened} Helm was running when it closed.`
          : `${reopened} ${lostWith} was running when it stopped.`,
      failed: false
    }
  }
  return null
}

export function useRestore(reconnects = 0): RestoreState {
  const [offer, setOffer] = useState<RestoreOffer | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<{ text: string; failed: boolean } | null>(null)

  useEffect(() => {
    let live = true
    void helm
      .invoke('session:restorable')
      .then((answer) => {
        if (live) setOffer(answer)
      })
      // No offer is the state of every ordinary start, and a window that could
      // not ask is no worse off than one that had nothing to ask about.
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [reconnects])

  const restore = useCallback(
    async (
      picks: RestoreSessionsRequest['sessions'],
      options: RestoreOptions = {}
    ): Promise<RestoreSessionsResult | null> => {
      setBusy(true)
      setReport(null)
      try {
        const result = await helm.invoke('session:restore', { sessions: picks })
        setReport(restoreReport(result, options.unasked === true, options.lostWith))
        return result
      } catch (err: unknown) {
        setReport({ text: readable(err), failed: true })
        return null
      } finally {
        // Answered either way: main forgets an offer the moment it is asked.
        setOffer(null)
        setBusy(false)
      }
    },
    []
  )

  const dismiss = useCallback(() => {
    setOffer(null)
    void helm.invoke('session:restore', { sessions: [] }).catch(() => undefined)
  }, [])

  return {
    offer,
    busy,
    restore,
    dismiss,
    report,
    dismissReport: useCallback(() => setReport(null), [])
  }
}
