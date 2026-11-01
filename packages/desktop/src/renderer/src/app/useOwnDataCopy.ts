import { useEffect, useState } from 'react'
import type { OwnDataCopyState } from '../../../shared/ipc'
import { helm } from './bridge'

export interface OwnDataNotice {
  /** Set while a copy of Helm's own data into the local host stopped part way and was not dismissed. */
  unfinished: string | null
  dismiss: () => void
}

/**
 * Where main's copy of Helm's own database into the local host stands, for
 * the notice that it did not finish. Always `idle` with sessions in Helm.
 * Dismissed for the session; a later attempt that finishes takes it away.
 */
export function useOwnDataCopy(): OwnDataNotice {
  const [state, setState] = useState<OwnDataCopyState>({ state: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let live = true
    let heard = false
    // Subscribed before asking, so a change between the two is not missed.
    const off = helm.on('ownData:changed', (next) => {
      heard = true
      setState(next)
    })
    void helm.invoke('ownData:state').then(
      (next) => {
        if (live && !heard) setState(next)
      },
      () => undefined
    )
    return () => {
      live = false
      off()
    }
  }, [])

  return {
    unfinished: state.state === 'unfinished' && !dismissed ? state.reason : null,
    dismiss: () => setDismissed(true)
  }
}
