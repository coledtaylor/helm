import { useEffect, useRef, useState } from 'react'
import type { UsageSnapshot } from '@helm/core'
import { helm } from './bridge'

/**
 * Claude Code's cached plan-limit figures, kept current in the window.
 *
 * A push and one read, and nothing else: the main process watches
 * `~/.claude.json` and sends a new reading whenever the CLI refreshes it, so
 * this hook never polls and never asks twice. What may be *shown* from a
 * reading is not decided here - that changes with the clock rather than with
 * the file, and `UsageStatus` re-derives it on its own tick.
 */
export function useUsage(): UsageSnapshot | null {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  /** A push that beat the initial read must not be overwritten by it. */
  const pushed = useRef(false)

  useEffect(() => {
    const off = helm.on('usage:changed', (next) => {
      pushed.current = true
      setSnapshot(next)
    })
    void helm.invoke('usage:read').then((next) => {
      if (!pushed.current) setSnapshot(next)
    })
    return off
  }, [])

  return snapshot
}
