import { useCallback, useEffect, useState } from 'react'
import type { ForwardedPort } from '../../../shared/ipc'
import { helm } from './bridge'

/** What the window asks of the Browser tab: a page at `url`, belonging to no project. */
export type OpenBrowserPage = (request: { url: string; project: null }) => void

export interface ForwardedPorts {
  /** The ports of sessions on other computers main forwards to this PC's loopback now. */
  forwards: readonly ForwardedPort[]
  /** The sentence the last Open in browser that failed said, by session key, until another is pressed. */
  portProblems: ReadonlyMap<string, string>
  /**
   * Open in browser on port `port` of session `session` on host `host`, whose
   * row is `key`: main forwards it to this PC's loopback, and the Browser tab
   * opens that address. What went wrong is kept under `key`.
   */
  openRemotePort: (host: string, session: number, key: string, port: number) => void
}

/** The address on this PC a forwarded port is reached at. */
export const forwardedAddress = (forward: ForwardedPort): string => `http://localhost:${String(forward.local)}/`

/**
 * The window's half of a remote session's forwarded ports. The Browser tab
 * opens the forwarded address through `openPage`, which goes through
 * `browser:open`, so it meets the reach rule a typed address does.
 */
export function useForwardedPorts(openPage: OpenBrowserPage): ForwardedPorts {
  const [forwards, setForwards] = useState<readonly ForwardedPort[]>([])
  const [portProblems, setPortProblems] = useState<ReadonlyMap<string, string>>(new Map())

  useEffect(() => {
    let current = true
    const off = helm.on('forwards:changed', (list) => setForwards(list))
    void helm.invoke('forwards:read').then(
      (list) => {
        if (current) setForwards(list)
      },
      () => undefined
    )
    return () => {
      current = false
      off()
    }
  }, [])

  const openRemotePort = useCallback(
    (host: string, session: number, key: string, port: number) => {
      setPortProblems((last) => {
        if (!last.has(key)) return last
        const next = new Map(last)
        next.delete(key)
        return next
      })
      helm.invoke('forwards:open', { host, session, port }).then(
        (forward) => openPage({ url: forwardedAddress(forward), project: null }),
        (error: unknown) =>
          setPortProblems((last) => new Map(last).set(key, error instanceof Error ? error.message : String(error)))
      )
    },
    [openPage]
  )

  return { forwards, portProblems, openRemotePort }
}
