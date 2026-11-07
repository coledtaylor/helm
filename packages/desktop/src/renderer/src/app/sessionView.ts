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
    case 'error':
      return 'error'
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

/**
 * The crumb's status: what the session is doing, and for how long. A reported
 * error carries its program's own message, which the host already cut to 200
 * characters.
 */
export function crumbStatus(
  session: SessionRecord,
  state: TabIndicator,
  since: number | null,
  now: number,
  message: string | null = null
): { text: string; tone: CrumbTone } {
  const age = since === null ? '' : ` · ${shortAge(now - since)}`
  switch (state) {
    case 'waiting':
      return { text: `Needs you${age}`, tone: 'warn' }
    case 'error':
      return { text: message === null ? 'Error' : `Error · ${message}`, tone: 'danger' }
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
      // A run of less than a minute says only that it runs: its age would be "now".
      return { text: since === null || now - since < 60_000 ? 'Running' : `Running${age}`, tone: 'subtle' }
  }
}

/**
 * A child's state in its card's header: what the crumb says of a session, kept
 * to a few words. A session handing control back says how long it has been
 * idle (the header has the room for it and a card's reader wants it), and an
 * error is the one word because its program's message does not fit a header
 * (the crumb, the tab and the tooltip of its dot have it).
 */
export function childStatus(
  session: SessionRecord,
  state: TabIndicator,
  since: number | null,
  now: number
): string {
  if (state === 'idle' || state === 'shell') return since === null ? 'Idle' : `Idle · ${shortAge(now - since)}`
  if (state === 'error') return 'Error'
  return crumbStatus(session, state, since, now).text
}

/**
 * What a running session's hint adds to its folder: what a waiting one waits
 * on, and a reported error's message. The CLI's sentence and the program's
 * message are shown verbatim and never matched against. Null when it says
 * nothing more.
 */
export function statusHint(
  status: Pick<SessionActivityState, 'activity' | 'waitingFor' | 'message'> | undefined
): string | null {
  if (status === undefined) return null
  if (status.activity === 'error') return status.message === null ? null : `Error: ${status.message}`
  return status.waitingFor === null ? null : `Waiting: ${status.waitingFor}`
}

/** Running sessions by what they are doing, for the status bar. */
export interface StatusCounts {
  working: number
  waiting: number
  /** Alive, and its program reports an error: never counted idle. */
  error: number
  /** Alive and none of the above: ready, handed back, or saying nothing. */
  idle: number
}

/** Counts the running sessions by the state each paints. */
export function statusCounts(
  sessions: readonly SessionRecord[],
  stateOf: (session: SessionRecord) => TabIndicator
): StatusCounts {
  const counts: StatusCounts = { working: 0, waiting: 0, error: 0, idle: 0 }
  for (const session of sessions) {
    if (session.status !== 'running') continue
    const state = stateOf(session)
    if (state === 'busy') counts.working += 1
    else if (state === 'waiting') counts.waiting += 1
    else if (state === 'error') counts.error += 1
    else counts.idle += 1
  }
  return counts
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
