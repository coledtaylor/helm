import type { JSX } from 'react'
import { isCommandChild, type SessionRecord } from '@helm/core/types'
import { PaneCrumb, type PaneCrumbProps, type TabIndicator } from '@helm/ui'
import { crumbStatus, useSecondsClock } from './sessionView'

export interface SessionCrumbProps extends Omit<PaneCrumbProps, 'status'> {
  session: SessionRecord
  /** What its dot says. */
  state: TabIndicator
  /** When it entered `state`, in milliseconds, or null where nothing says. */
  since: number | null
  /** The window's clock, which moves every half minute. */
  now: number
  /** A reported error's message, or null. */
  message: string | null
}

/**
 * The crumb under a session's tab, with its status.
 *
 * A command that runs counts its seconds, which the window's half-minute clock
 * cannot. The second-by-second clock is held here, so only this crumb renders
 * each second and the window never does; for any other session it is off and
 * the status moves with `now` alone.
 */
export function SessionCrumb({ session, state, since, now, message, ...place }: SessionCrumbProps): JSX.Element {
  const running = session.status === 'running' && isCommandChild(session)
  const clock = useSecondsClock(now, running)
  return <PaneCrumb {...place} status={crumbStatus(session, state, since, clock, message)} />
}
