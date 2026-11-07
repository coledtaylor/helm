import { useEffect, useState } from 'react'
import {
  commandState,
  endedHeaderText,
  isCommandChild,
  type SessionActivityState,
  type SessionRecord
} from '@helm/core/types'
import type { CrumbParent, CrumbTag, CrumbTone, Tab, TabIndicator } from '@helm/ui'
import { commandWord } from './treeFamilies'

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
export function indicatorOf(session: SessionRecord, activity: SessionActivityState | undefined): TabIndicator {
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
  if (isCommandChild(session)) return commandCrumbStatus(session, now)
  const age = since === null ? '' : ` · ${shortAge(now - since)}`
  switch (state) {
    case 'waiting':
      return { text: `Needs you${age}`, tone: 'warn' }
    case 'error':
      return { text: message === null ? 'Error' : `Error · ${message}`, tone: 'danger' }
    case 'busy':
      return { text: `Working${age}`, tone: 'accent' }
    // A session handing control back says how long it has been idle, as its
    // card's header does; a background task still running is the dot's
    // hover text, not the crumb's.
    case 'idle':
    case 'shell':
      return { text: `Idle${age}`, tone: 'success' }
    case 'failed':
      return { text: `Exited ${String(session.exitCode ?? '')}`.trim(), tone: 'danger' }
    case 'ended':
      return {
        text: session.durationMs === null ? 'Ended' : `Ended after ${shortAge(session.durationMs)}`,
        tone: 'subtle'
      }
    default:
      // A run counts its seconds until it has run a minute, as a command
      // child's card does while its output scrolls.
      return { text: since === null ? 'Running' : `Running · ${runAge(now - since)}`, tone: 'subtle' }
  }
}

/** When a session started, in milliseconds, or null for a time that is not one: how long a command has run. */
export function startedMs(session: Pick<SessionRecord, 'startedAt'>): number | null {
  const started = Date.parse(session.startedAt)
  return Number.isNaN(started) ? null : started
}

/**
 * A command child's crumb. A command has no conversation to be busy or waiting
 * in, so neither the registry nor the OSC indicator is read for it: it runs,
 * counted from when it started (never from the registry's moment, which is an
 * agent's), and once it exited it says what its ended header says -
 * "exited 0 · 14:52" - in fg-subtle after exit 0 and in danger for any other
 * code. A code never seen keeps the ended header's agent wording.
 */
function commandCrumbStatus(session: SessionRecord, now: number): { text: string; tone: CrumbTone } {
  const state = commandState(session)
  if (state !== 'running') return { text: endedHeaderText(session), tone: state === 'failed' ? 'danger' : 'subtle' }
  const from = startedMs(session)
  return { text: from === null ? 'Running' : `Running · ${runAge(now - from)}`, tone: 'success' }
}

/** How long a command has run: seconds under a minute, then as {@link shortAge} says it. */
export function runAge(ms: number): string {
  return ms < 60_000 ? `${String(Math.max(1, Math.floor(ms / 1000)))}s` : shortAge(ms)
}

/**
 * A child's state in its card's header: what the crumb says of a session, kept
 * to a few words. A session handing control back says how long it has been
 * idle (the header has the room for it and a card's reader wants it), and an
 * error is the one word because its program's message does not fit a header
 * (the crumb, the tab and the tooltip of its dot have it).
 */
export function childStatus(session: SessionRecord, state: TabIndicator, since: number | null, now: number): string {
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
  /** A command child whose command is still running: it takes no turns, so it is neither working nor idle. */
  running: number
  /** Alive and none of the above: ready, handed back, or saying nothing. */
  idle: number
}

/** Counts the running sessions by the state each paints. */
export function statusCounts(
  sessions: readonly SessionRecord[],
  stateOf: (session: SessionRecord) => TabIndicator
): StatusCounts {
  const counts: StatusCounts = { working: 0, waiting: 0, error: 0, running: 0, idle: 0 }
  for (const session of sessions) {
    if (session.status !== 'running') continue
    if (isCommandChild(session)) {
      counts.running += 1
      continue
    }
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

/**
 * The time to the second while `active`: the window's clock (`now`, which
 * moves every half minute and can be that old) is too coarse for a command
 * that counts its seconds. While `active` this is the real time, re-read each
 * second; with `active` off it is `now`.
 */
export function useSecondsClock(now: number, active: boolean): number {
  const [sampled, setSampled] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const sample = (): void => setSampled(Date.now())
    // The first sample is at once, because the one held may be from before
    // this became active.
    const first = setTimeout(sample, 0)
    const timer = setInterval(sample, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [active])
  return active ? Math.max(sampled, now) : now
}

/**
 * What the crumb of a child's own tab begins with: its tag (`command` for a
 * command child, the role an agent child was started in, none for a child
 * with no role) and the session that started it. `openParent` is given only
 * where the window lists that session, so the link is plain text otherwise.
 */
export function childCrumb(
  session: Pick<SessionRecord, 'command' | 'role' | 'parentId' | 'parentName'>,
  openParent: (parentId: number) => void,
  listsParent: (parentId: number) => boolean
): { tag: CrumbTag | undefined; parent: CrumbParent | undefined } {
  const tag: CrumbTag | undefined = isCommandChild(session)
    ? { kind: 'command', text: 'command' }
    : typeof session.role === 'string' && session.role !== ''
      ? { kind: 'role', text: session.role }
      : undefined
  const { parentId, parentName } = session
  const parent: CrumbParent | undefined =
    parentId === null || parentId === undefined || typeof parentName !== 'string' || parentName === ''
      ? undefined
      : { name: parentName, onOpen: listsParent(parentId) ? () => openParent(parentId) : undefined }
  return { tag, parent }
}

/**
 * What a child's own tab adds to a session tab. A command child's indicator is
 * the terminal glyph in the glyph's tones (success while it runs, fg-subtle
 * after exit 0, danger otherwise), read from its command and never from the
 * registry, and its accessible name says `running` or `exited <code>`. Any
 * child, command or agent, carries the name of the session that started it as
 * the muted badge after its title, and the tab's accessible name ends with
 * `started by <parent>`.
 */
export function childTab(
  session: Pick<SessionRecord, 'status' | 'exitCode' | 'command' | 'parentName'>,
  indicator: TabIndicator
): Pick<Tab, 'indicator' | 'command' | 'stateWord' | 'badge' | 'startedBy'> {
  const parent = typeof session.parentName === 'string' && session.parentName !== '' ? session.parentName : undefined
  const marks = isCommandChild(session)
    ? { indicator: commandState(session), command: true, stateWord: commandWord(session) }
    : { indicator }
  return parent === undefined ? marks : { ...marks, badge: parent, startedBy: parent }
}
