import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  LOCAL_HOST_KEY,
  closeTab,
  hostOf,
  paneId,
  sessionRef,
  sessionTabIds,
  type PaneLayout,
  type PaneRef
} from '@helm/core/types'
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

/** The ids of `host`'s sessions with a tab here, in order, as one string a memo can compare. */
const tabbedIds = (layout: PaneLayout, host: string): string =>
  [...sessionTabIds(layout, host)].sort((a, b) => a - b).join(',')

/** Tells one host's connection which of its sessions have a tab in this window. */
export type ShowSessionTabs = (ids: readonly number[], host: string) => void

/**
 * Which sessions each host's connection carries: those with a tab here.
 *
 * This PC's is told while sessions run in the local host. Each host on
 * another computer is told while the window is connected to it, and told
 * again each time it is connected again: a tab whose host dropped kept its
 * last screen, and reattaches here on a new stream that starts with the
 * session's screen as it is now.
 */
export function useShownSessionTabs(
  layout: PaneLayout,
  localInHost: boolean,
  connected: readonly string[],
  show: ShowSessionTabs
): void {
  const showRef = useRef(show)
  useEffect(() => {
    showRef.current = show
  }, [show])
  const local = useMemo(() => tabbedIds(layout, LOCAL_HOST_KEY), [layout])
  useEffect(() => {
    if (!localInHost || local === '') return
    showRef.current(local.split(',').map(Number), LOCAL_HOST_KEY)
  }, [localInHost, local])
  const remote = useMemo(
    () => connected.map((host) => `${host}=${tabbedIds(layout, host)}`).join('\n'),
    [connected, layout]
  )
  useEffect(() => {
    if (remote === '') return
    for (const line of remote.split('\n')) {
      const at = line.lastIndexOf('=')
      const shown = line.slice(at + 1)
      if (shown !== '') showRef.current(shown.split(',').map(Number), line.slice(0, at))
    }
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
 */
export function closeKeepingRunning(id: number, host: string, deps: KeepRunningDeps): void {
  deps.release(id, host)
  deps.disposeTerminal(id, host)
  deps.commit((layout) => closeTab(layout, paneId(sessionRef(id, host))))
}
