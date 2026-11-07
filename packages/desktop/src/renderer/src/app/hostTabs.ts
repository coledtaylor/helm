import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LOCAL_HOST_KEY,
  childMark,
  closeTab,
  hostOf,
  paneId,
  sessionLabel,
  sessionRef,
  shownSessionIds,
  type ChildMember,
  type CloseParentPlan,
  type FamilyMember,
  type FamilyRoomOf,
  type PaneLayout,
  type PaneRef,
  type SessionRecord,
  type UrgentState
} from '@helm/core/types'
import type { ConfirmChild } from '@helm/ui'
import type { HelmBridge, SessionConfirmRequest } from '../../../shared/ipc'
import type { HostWorkspace } from './useHostWorkspaces'

/**
 * The window's session tabs across hosts: which of a host's tabs stay while
 * that host is away, which sessions each host's connection carries, the
 * question a host asks before a running session's tab closes, and Close tab,
 * keep running. App wires these; each is tested here without the window.
 */

/** What the window knows of the hosts on other computers, for deciding whether one of their tabs stays. */
export interface RemoteTabsView {
  /** Whether this device's settings have been read: until then, no host is known to be gone. */
  settingsLoaded: boolean
  /** The hosts on other computers this device has added. */
  listed: readonly string[]
  /** What the window has read of each, by id (`useHostWorkspaces`). */
  byHost: ReadonlyMap<string, Pick<HostWorkspace, 'discovery' | 'sessions' | 'listed'>>
  /**
   * Whether `host`'s plugin still declares `tab`: null while that host's list
   * has not been read, which is no word that it has gone.
   */
  pluginTab: (host: string, plugin: string, tab: string) => boolean | null
}

/**
 * Whether a tab of a host on another computer stays, or undefined for any tab
 * that is not one (this PC's are App's own to decide).
 *
 * A tab stays while its host is away: a session there is still running, and
 * its tab keeps its last screen and reattaches once the host is back. It goes
 * once its host is removed from this device, or once that host's own word
 * (its scan, its session list, its plugin list) says its thing is gone.
 */
export function keepRemoteTab(ref: PaneRef, view: RemoteTabsView): boolean | undefined {
  const host = hostOf(ref)
  if (host === LOCAL_HOST_KEY) return undefined
  if (ref.kind !== 'project' && ref.kind !== 'session' && ref.kind !== 'plugin') return undefined
  if (!view.settingsLoaded) return true
  if (!view.listed.includes(host)) return false
  const work = view.byHost.get(host)
  switch (ref.kind) {
    case 'project': {
      const scanned = work?.discovery ?? null
      return scanned === null || scanned.projects.some((project) => project.path === ref.path)
    }
    case 'session':
      return work === undefined || !work.listed || work.sessions.some((session) => session.id === ref.id)
    case 'plugin':
      return view.pluginTab(host, ref.plugin, ref.tab) ?? true
  }
}

/**
 * What the window knows of children shown in their parent's tab, passed while
 * this device shows them and null while it does not. Memoised by the caller:
 * a new object is a new question about who is open here.
 */
export interface FamilyScope {
  /** The sessions each host lists, running or ended, children among them. */
  sessions: ReadonlyMap<string, readonly FamilyMember[]>
  /** Whether a parent tab's pane has room for its family view (`FamilyRoomOf`). */
  roomOf: FamilyRoomOf
}

/** The ids of `host`'s sessions this window shows, in order, as one string a memo can compare. */
const shownIds = (layout: PaneLayout, host: string, family: FamilyScope | null): string =>
  shownSessionIds(layout, family?.sessions.get(host) ?? [], host, family?.roomOf ?? null).join(',')

/** Tells one host's connection which of its sessions are shown in this window. */
export type ShowSessionTabs = (ids: readonly number[], host: string) => void

/**
 * Which sessions each host's connection carries: those with a tab here, and
 * the running children a parent's tab here shows in its family view (`family`),
 * which count as open here though none has a tab.
 *
 * This PC's is told each time the layout changes. Each host on another
 * computer is told while the window is connected to it, and told
 * again each time it is connected again: a tab whose host dropped kept its
 * last screen, and reattaches here on a new stream that starts with the
 * session's screen as it is now.
 */
export function useShownSessionTabs(
  layout: PaneLayout,
  connected: readonly string[],
  show: ShowSessionTabs,
  family: FamilyScope | null = null
): void {
  const showRef = useRef(show)
  useEffect(() => {
    showRef.current = show
  }, [show])
  const local = useMemo(() => shownIds(layout, LOCAL_HOST_KEY, family), [layout, family])
  // A host is told when it has something shown, and once more when the last of
  // it goes, so a child that lost its pane's room is let go of.
  const toldLocal = useRef('')
  useEffect(() => {
    const before = toldLocal.current
    toldLocal.current = local
    if (local === '' && before === '') return
    showRef.current(local === '' ? [] : local.split(',').map(Number), LOCAL_HOST_KEY)
  }, [local])
  const remote = useMemo(
    () => connected.map((host) => `${host}=${shownIds(layout, host, family)}`).join('\n'),
    [connected, layout, family]
  )
  const toldRemote = useRef(new Map<string, string>())
  useEffect(() => {
    const told = toldRemote.current
    for (const host of [...told.keys()]) {
      if (!connected.includes(host)) told.delete(host)
    }
    for (const line of remote === '' ? [] : remote.split('\n')) {
      const at = line.lastIndexOf('=')
      const shown = line.slice(at + 1)
      const host = line.slice(0, at)
      const before = told.get(host) ?? ''
      told.set(host, shown)
      if (shown === '' && before === '') continue
      showRef.current(shown === '' ? [] : shown.split(',').map(Number), host)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `remote` is `connected` and the layout, joined
  }, [remote])
}

/** Every host's bridge, as the window reaches them (`eachHostBridge` and `bridgeFor` in `bridge.ts`). */
export interface HostBridgeReach {
  each: (listener: (host: string, bridge: HelmBridge) => void) => () => void
  bridgeFor: (host: string) => HelmBridge
}

export interface SessionConfirm {
  /** The question in front, and the host that asked it; null when none is. */
  ask: { host: string; request: SessionConfirmRequest } | null
  /** Answers it on the bridge of the host that asked. `keep` is the quit question's Keep running. */
  answer: (agreed: boolean, keep?: boolean) => void
}

/**
 * "This session is still running", asked by a host and answered here. Each
 * host asks on its own bridge and is answered on it, and one on another
 * computer names itself in what it asks. The answer is sent only while a
 * question is in front: a second reply is for a decision already taken.
 */
export function useSessionConfirm(reach: HostBridgeReach): SessionConfirm {
  const [ask, setAsk] = useState<SessionConfirm['ask']>(null)
  const reachRef = useRef(reach)
  useEffect(() => {
    reachRef.current = reach
  }, [reach])
  useEffect(() => {
    const offs: (() => void)[] = []
    const stop = reachRef.current.each((host, bridge) => {
      offs.push(bridge.on('session:confirm', (request) => setAsk({ host, request })))
    })
    return () => {
      stop()
      for (const off of offs) off()
    }
  }, [])
  const answer = useCallback(
    (agreed: boolean, keep = false) => {
      if (ask === null) return
      const { host, request } = ask
      reachRef.current
        .bridgeFor(host)
        .send('session:confirmed', keep ? { id: request.id, agreed, keep } : { id: request.id, agreed })
      setAsk(null)
    },
    [ask]
  )
  return { ask, answer }
}

/**
 * The children a close question names: those that end with the session whose
 * tab closes (`endingIds`), and those started to outlive it (`outlivingIds`),
 * each with the dot or glyph it wears. The ids are the host's, from its own
 * question for a close another client made and from the window's for its own,
 * so the dialog draws the same list for both. A child this window does not list
 * is left out: it has no name to show.
 */
export function confirmChildren<T extends ChildMember>(
  request: Pick<SessionConfirmRequest, 'endingIds' | 'outlivingIds'>,
  sessions: readonly T[],
  stateOf: (session: T) => UrgentState | null
): CloseParentPlan<T> {
  const named = (ids: readonly number[] | undefined): CloseParentPlan<T>['ends'] =>
    (ids ?? []).flatMap((id) => {
      const child = sessions.find((session) => session.id === id)
      return child === undefined ? [] : [{ child, mark: childMark(child, stateOf(child)) }]
    })
  return { ends: named(request.endingIds), outlives: named(request.outlivingIds) }
}

/**
 * A child as the close question lists it: its dot or glyph, its name and, at
 * the right, its role and branch, or `command` for one that runs a command.
 */
export function confirmRows(
  plan: CloseParentPlan<SessionRecord & ChildMember>
): { ends: ConfirmChild[]; outlives: ConfirmChild[] } {
  const row = ({ child, mark }: CloseParentPlan<SessionRecord & ChildMember>['ends'][number]): ConfirmChild => ({
    id: child.id,
    name: sessionLabel(child),
    mark,
    meta: child.command === true ? 'command' : [child.role, child.branch].filter((part) => part != null && part !== '').join(' · ')
  })
  return { ends: plan.ends.map(row), outlives: plan.outlives.map(row) }
}

/**
 * A host's own close question names the session and not the host it asks for:
 * it does not know the name this window gives it. The window adds it, as the
 * questions it asks itself have it ("on this PC’s host"), and leaves a question
 * that already names a host, and every other question, as it is.
 */
export function hostQuestionMessage(message: string, host: string): string {
  const suffix = ' is still running.'
  return message.endsWith(suffix) ? `${message.slice(0, -1)} on ${host}.` : message
}

/** What Close tab, keep running lets go of (the host's stream, the terminal drawn from it) and the panes it changes. */
export interface KeepRunningDeps {
  release: (id: number, host: string) => void
  disposeTerminal: (id: number, host: string) => void
  commit: (op: (layout: PaneLayout) => PaneLayout) => void
}

/**
 * Close tab, keep running: the session's tab goes, its host stops carrying
 * its terminal to this window, and nothing is asked or ended there. The
 * session stays listed under its host as not open here, where Open brings its
 * tab back on a new stream.
 *
 * A child that `returnsToFamily` is the exception: its parent's tab shows it
 * in its family view next, so its stream and its terminal stay, and only the
 * tab goes.
 */
export function closeKeepingRunning(
  id: number,
  host: string,
  deps: KeepRunningDeps,
  staysInFamily = false
): void {
  if (!staysInFamily) {
    deps.release(id, host)
    deps.disposeTerminal(id, host)
  }
  deps.commit((layout) => closeTab(layout, paneId(sessionRef(id, host))))
}
