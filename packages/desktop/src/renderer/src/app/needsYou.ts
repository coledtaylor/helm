import {
  childPlace,
  isCommandChild,
  needsYouToast,
  type ChildMember,
  type NeedsYouToast,
  type PaneLayout,
  type PlaceScope,
  type StandingNotice
} from '@helm/core/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoticesView } from './host/notices'
import { noticeKey } from './host/notices'

/**
 * A child that needs a person, as this window tells them of it: a toast for
 * one that is not on screen as a card or a tab, and an OS notification while
 * the window is not in front. The host keeps the notices (`notices:changed`)
 * and ends a needs-you notice when its child stops waiting, so a toast is
 * derived from them and is gone by itself when the child answers.
 */

/** One host's notices and its listed sessions, as the window has them. */
export interface HostAttention<T extends ChildMember> {
  host: string
  notices: NoticesView
  sessions: readonly T[]
}

/** One toast: a child that needs a person, who started it, what it waits on, and the one thing the toast offers besides Open as tab. */
export interface NeedsYouToastView {
  /** Names this toast in this window; a child that waits again is a new one. */
  key: string
  host: string
  childId: number
  childName: string
  /** What it waits on: the permission prompt, question or sign-in, or the agent's own sentence. */
  waitsOn: string
  /** The session that started it. */
  startedBy: string
  /** `show` swaps a child shown as a header into its parent's family view; `peek` opens its peek. */
  action: NeedsYouToast
}

const toastKey = (host: string, notice: StandingNotice): string => `${host}\n${noticeKey(notice)}`

/** The needs-you notices of one host that belong to a running child this window lists. */
function needsYouOf<T extends ChildMember>(attention: HostAttention<T>): Array<{ notice: StandingNotice; child: T }> {
  const out: Array<{ notice: StandingNotice; child: T }> = []
  for (const notice of attention.notices.notices) {
    if (notice.kind !== 'needs-you' || notice.childId === null) continue
    const child = attention.sessions.find((session) => session.id === notice.childId)
    // A command has no conversation to wait in: whatever a notice says, it never needs a person.
    if (child === undefined || child.status !== 'running' || isCommandChild(child)) continue
    out.push({ notice, child })
  }
  return out
}

/**
 * The toasts to show: one for each needs-you notice whose child is a header,
 * a chip or on screen nowhere (`needsYouToast`), and none for a child shown as
 * a card or with a tab, whose warn edge says it. `closed` holds the toasts the
 * user closed in this window.
 */
export function needsYouToasts<T extends ChildMember>(
  hosts: readonly HostAttention<T>[],
  layout: PaneLayout,
  scope: PlaceScope,
  closed: ReadonlySet<string>
): NeedsYouToastView[] {
  const toasts: NeedsYouToastView[] = []
  for (const attention of hosts) {
    for (const { notice, child } of needsYouOf(attention)) {
      const key = toastKey(attention.host, notice)
      if (closed.has(key)) continue
      const action = needsYouToast(childPlace(layout, attention.sessions, attention.host, child.id, scope))
      if (action === null) continue
      toasts.push({
        key,
        host: attention.host,
        childId: child.id,
        childName: notice.childName ?? '',
        waitsOn: notice.text,
        startedBy: notice.parentName,
        action
      })
    }
  }
  return toasts
}

/** `closed` with the toasts that no longer stand forgotten, so it does not grow, or the same set when none left. */
export function pruneClosed(
  closed: ReadonlySet<string>,
  hosts: ReadonlyArray<Pick<HostAttention<ChildMember>, 'host' | 'notices'>>
): ReadonlySet<string> {
  if (closed.size === 0) return closed
  const standing = new Set<string>()
  for (const { host, notices } of hosts) {
    for (const notice of notices.notices) standing.add(toastKey(host, notice))
  }
  const kept = [...closed].filter((key) => standing.has(key))
  return kept.length === closed.size ? closed : new Set(kept)
}

/** What the OS notification for a child that needs a person says, and the child it brings forward when clicked. */
export interface NeedsYouAlert {
  key: string
  host: string
  id: number
  title: string
  body: string
}

/**
 * The notifications to show now: each needs-you notice that began since the
 * window's connection to its host opened (those standing then are listed under
 * While you were away) and has not been shown yet. `seen` is the keys already
 * shown; the caller keeps it. Nothing is shown while the window is in front.
 */
export function needsYouAlerts<T extends ChildMember>(
  hosts: readonly HostAttention<T>[],
  seen: ReadonlySet<string>,
  inFront: boolean
): NeedsYouAlert[] {
  if (inFront) return []
  const alerts: NeedsYouAlert[] = []
  for (const attention of hosts) {
    for (const { notice, child } of needsYouOf(attention)) {
      const key = toastKey(attention.host, notice)
      if (seen.has(key) || attention.notices.atConnect.has(noticeKey(notice))) continue
      alerts.push({
        key,
        host: attention.host,
        id: child.id,
        title: `${notice.childName ?? 'A session'} needs you`,
        body: `${notice.text}, started by ${notice.parentName}`
      })
    }
  }
  return alerts
}

/** Every needs-you notice of `hosts` as its key, which is `seen` once told of or while the window is in front. */
export function needsYouKeys(hosts: ReadonlyArray<Pick<HostAttention<ChildMember>, 'host' | 'notices'>>): string[] {
  const keys: string[] = []
  for (const { host, notices } of hosts) {
    for (const notice of notices.notices) if (notice.kind === 'needs-you') keys.push(toastKey(host, notice))
  }
  return keys
}

export interface UseNeedsYouDeps<T extends ChildMember> {
  hosts: readonly HostAttention<T>[]
  layout: PaneLayout
  scope: PlaceScope
  /** Whether the window is in front. */
  inFront: () => boolean
  /** Hands main the notification to show (`windowSessions:needsYou`). */
  notify: (alert: NeedsYouAlert) => void
}

export interface NeedsYou {
  toasts: NeedsYouToastView[]
  /** The toast's close button: closes it in this window. */
  closeToast: (key: string) => void
}

/**
 * The window's needs-you state: its toasts, and the OS notification for each
 * child that begins to need a person while the window is not in front. A
 * notice is told of once; the notification of one that began while the window
 * was in front is not shown when the window is left.
 */
export function useNeedsYou<T extends ChildMember>(deps: UseNeedsYouDeps<T>): NeedsYou {
  const { hosts, layout, scope } = deps
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const seen = useRef<Set<string>>(new Set())
  const latest = useRef(deps)
  useEffect(() => {
    latest.current = deps
  })

  const toasts = useMemo(
    () => needsYouToasts(hosts, layout, scope, closed),
    // `scope` is rebuilt each render by the caller and means the same until the layout or sessions change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hosts, layout, scope.enabled, scope.roomOf, scope.capacityOf, closed]
  )

  useEffect(() => {
    const { inFront, notify } = latest.current
    const keys = needsYouKeys(hosts)
    const standing = new Set(keys)
    // A notice that ended is forgotten, so the same child waiting again is told of again.
    for (const key of [...seen.current]) if (!standing.has(key)) seen.current.delete(key)
    const front = inFront()
    for (const alert of needsYouAlerts(hosts, seen.current, front)) {
      seen.current.add(alert.key)
      notify(alert)
    }
    // What began while the window was in front was seen there, and is not told of when it is left.
    if (front) for (const key of keys) seen.current.add(key)
  }, [hosts])

  // What was closed is forgotten with the notice, each time another is closed.
  const closeToast = useCallback(
    (key: string) =>
      setClosed((current) => pruneClosed(new Set(current).add(key), latest.current.hosts)),
    []
  )
  return { toasts, closeToast }
}
