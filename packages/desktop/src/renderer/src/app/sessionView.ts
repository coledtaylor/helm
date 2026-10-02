import { useEffect, useState } from 'react'
import type { SessionActivityState, SessionRecord } from '@helm/core/types'
import type { CrumbTone, TabIndicator } from '@helm/ui'

/**
 * What a session's dot says.
 *
 * How the session *ended* outranks what it last said it was doing: a row that
 * has exited is a fact Helm established, and the registry's last word about a
 * dead process is by definition out of date.
 *
 * While it runs, the session's own answer is preferred and `running` is the
 * fallback for every way of not having one - a record that has not appeared
 * yet, a process that cannot be proved alive, a status this build does not
 * recognise. All three paint what a tab painted before the registry was read,
 * which is the point: a CLI that renames a status degrades to the old
 * behaviour rather than to a guess.
 */
export function indicatorOf(
  session: SessionRecord,
  activity: SessionActivityState | undefined
): TabIndicator {
  if (session.status !== 'running') return session.exitCode ? 'failed' : 'ended'
  return activity?.activity ?? 'running'
}

/**
 * A span as one short figure: "now", "4m", "2h", "3d". The sidebar and the
 * crumb say how long a session has been doing what it is doing, and nobody
 * reading "working for 4 minutes" wants the seconds.
 */
export function shortAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${String(minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${String(hours)}h`
  return `${String(Math.floor(hours / 24))}d`
}

/**
 * The word at the right of a session's row in the tree.
 *
 * `since` is when the session entered its current state, from the registry,
 * or null where nothing says - in which case a working session says nothing
 * rather than an age measured from the wrong moment.
 */
export function sessionNote(state: TabIndicator, since: number | null, now: number): string {
  switch (state) {
    case 'waiting':
      return 'needs you'
    case 'busy':
      return since === null ? '' : shortAge(now - since)
    case 'idle':
    case 'shell':
      return 'idle'
    case 'ended':
      return 'ended'
    case 'failed':
      return 'failed'
    default:
      return ''
  }
}

/** The crumb's status: what the session is doing, and for how long. */
export function crumbStatus(
  session: SessionRecord,
  state: TabIndicator,
  since: number | null,
  now: number
): { text: string; tone: CrumbTone } {
  const age = since === null ? '' : ` · ${shortAge(now - since)}`
  switch (state) {
    case 'waiting':
      return { text: `Needs you${age}`, tone: 'warn' }
    case 'busy':
      return { text: `Working${age}`, tone: 'accent' }
    case 'idle':
      return { text: 'Idle', tone: 'success' }
    case 'shell':
      return { text: 'Idle · background task running', tone: 'success' }
    case 'failed':
      return { text: `Exited ${String(session.exitCode ?? '')}`.trim(), tone: 'danger' }
    case 'ended':
      return {
        text: session.durationMs === null ? 'Ended' : `Ended after ${shortAge(session.durationMs)}`,
        tone: 'subtle'
      }
    default:
      return { text: 'Running', tone: 'subtle' }
  }
}

/**
 * The time, re-read every `intervalMs`, for figures that age on screen.
 *
 * A clock rather than a timer per row: one interval for the whole window, and
 * the rows it feeds are a re-render of strings, so thirty seconds is as often
 * as "4m" can change in a way anybody would read.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
