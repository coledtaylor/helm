import { useEffect, useState } from 'react'
import type { UsageSnapshot } from '@helm/core'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { bridgeFor } from './bridge'
import { readable } from './errors'

export interface UsageState {
  /** The last reading of the host shown, or null before the first one. */
  snapshot: UsageSnapshot | null
  /** Why the host shown could not be read, while it could not; its figures are then not shown. */
  error: string | null
}

/** What was read, and from which host: a reading is only ever shown for the host it came from. */
interface Read extends UsageState {
  host: string
}

/**
 * Claude Code's cached plan-limit figures on one host (this PC's by default),
 * kept current in the window.
 *
 * A push and one read, and nothing else: the host watches `~/.claude.json`
 * there and sends a new reading whenever the CLI refreshes it, so this hook
 * never polls and never asks twice. What may be *shown* from a reading is not
 * decided here - that changes with the clock rather than with the file, and
 * `UsageStatus` re-derives it on its own tick.
 *
 * Switched to another host, it reads and hears that host's bridge only, and
 * says nothing until that host answers: one host's figures are never shown as
 * another's, and a host that cannot be read says why.
 */
export function useUsage(host: string = LOCAL_HOST_KEY): UsageState {
  const [read, setRead] = useState<Read | null>(null)

  useEffect(() => {
    const helm = bridgeFor(host)
    let live = true
    /** A push that beat the initial read must not be overwritten by it. */
    let pushed = false
    const off = helm.on('usage:changed', (next) => {
      pushed = true
      if (live) setRead({ host, snapshot: next, error: null })
    })
    helm.invoke('usage:read').then(
      (next) => {
        if (live && !pushed) setRead({ host, snapshot: next, error: null })
      },
      (failure: unknown) => {
        if (live && !pushed) setRead({ host, snapshot: null, error: readable(failure) })
      }
    )
    return () => {
      live = false
      off()
    }
  }, [host])

  return read !== null && read.host === host ? { snapshot: read.snapshot, error: read.error } : NOTHING_YET
}

const NOTHING_YET: UsageState = { snapshot: null, error: null }
