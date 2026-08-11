import { useEffect, useState } from 'react'
import type { DetectedShell } from '@helm/core'
import { helm } from './bridge'

/**
 * The shells this machine has, for the two pickers that offer them: the default
 * in the settings pane, and the per-pane override in a project shell's header.
 *
 * Asked once per window and shared, because the answer is a property of the
 * installation - the main process probes `where.exe` a single time and memoises
 * it for the same reason. Two components asking would be two identical IPC
 * round trips for a list that cannot have changed in between.
 */

let inFlight: Promise<DetectedShell[]> | null = null

function load(): Promise<DetectedShell[]> {
  inFlight ??= helm.invoke('pterm:shells').catch(() => [])
  return inFlight
}

export function useShells(): DetectedShell[] {
  const [shells, setShells] = useState<DetectedShell[]>([])

  useEffect(() => {
    let live = true
    void load().then((found) => {
      if (live) setShells(found)
    })
    return () => {
      live = false
    }
  }, [])

  return shells
}
