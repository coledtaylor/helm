import { useEffect, useState } from 'react'
import type { DetectedShell } from '@helm/core'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { bridgeFor } from './bridge'

/**
 * The shells a host has, for the two pickers that offer them: the default in
 * the settings pane, and the per-pane override in a project shell's header.
 *
 * Asked once per host per window and shared, because the answer is a property
 * of that machine's installation - the host probes its shells a single time
 * and memoises it for the same reason. Two components asking would be two
 * identical round trips for a list that cannot have changed in between.
 */

const inFlight = new Map<string, Promise<DetectedShell[]>>()

function load(host: string): Promise<DetectedShell[]> {
  let asked = inFlight.get(host)
  if (asked === undefined) {
    asked = bridgeFor(host)
      .invoke('pterm:shells')
      .catch((): DetectedShell[] => {
        // Asked again next time: a host not reached yet has not said it has none.
        inFlight.delete(host)
        return []
      })
    inFlight.set(host, asked)
  }
  return asked
}

/**
 * The shells `host` has: this PC's by default, or a host on another
 * computer's, asked through its bridge. Null asks nothing and has none.
 */
export function useShells(host: string | null = LOCAL_HOST_KEY): DetectedShell[] {
  const [shells, setShells] = useState<{ host: string | null; found: DetectedShell[] }>({ host, found: [] })

  useEffect(() => {
    if (host === null) return
    let live = true
    void load(host).then((found) => {
      if (live) setShells({ host, found })
    })
    return () => {
      live = false
    }
  }, [host])

  return shells.host === host ? shells.found : []
}
