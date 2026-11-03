import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiscoveryResult, SessionActivityState, SessionRecord } from '@helm/core'
import { isProjectPinned, withProjectPinned } from '@helm/core/types'
import type { HelmBridge } from '../../../shared/ipc'
import { bridgeFor } from './bridge'
import { readable } from './errors'

/**
 * What the window knows of each host on another computer: its harnesses and
 * projects, its pinned projects and its sessions, each read through that
 * host's own bridge (`bridgeFor`) and never through this PC's.
 *
 * - A host is read once the window is connected to it, and again each time it
 *   is connected again. While it is not, what was last read stays, for the
 *   sidebar to list dimmed: its sessions are still running there.
 * - A pin is that host's: it is written through its own bridge, whose router
 *   carries only that host's half of the settings.
 * - Nothing here ends a session, on any host.
 */
export interface HostWorkspace {
  discovery: DiscoveryResult | null
  scanning: boolean
  /** Why its folders could not be read, until a read succeeds. */
  scanError: string | undefined
  pinnedProjects: readonly string[]
  /** Its sessions, as it listed them last, with those this window started there since. */
  sessions: readonly SessionRecord[]
  /** What each of its running sessions is doing, by its row id there. */
  activity: ReadonlyMap<number, SessionActivityState>
  /** Whether it has listed its sessions yet: until then, a saved tab is not a session that has gone. */
  listed: boolean
}

export interface HostWorkspaces {
  /** Each host on another computer read so far, by id. */
  byHost: ReadonlyMap<string, HostWorkspace>
  rescan: (host: string) => void
  togglePin: (host: string, path: string) => void
  /** A session this window started or renamed there, as the host answered; before it lists it. */
  adopt: (host: string, record: SessionRecord) => void
  /** A session whose tab closed after it ended there. */
  forget: (host: string, id: number) => void
}

const EMPTY: HostWorkspace = {
  discovery: null,
  scanning: false,
  scanError: undefined,
  pinnedProjects: [],
  sessions: [],
  activity: new Map(),
  listed: false
}

/**
 * @param hosts every host on another computer the window lists, by id.
 * @param connected those the window is connected to now.
 * @param bridges each host's bridge; `bridgeFor` outside a test.
 */
export function useHostWorkspaces(
  hosts: readonly string[],
  connected: readonly string[],
  bridges: (host: string) => HelmBridge = bridgeFor
): HostWorkspaces {
  const [byHost, setByHost] = useState<ReadonlyMap<string, HostWorkspace>>(new Map())
  const bridgesRef = useRef(bridges)
  useEffect(() => {
    bridgesRef.current = bridges
  }, [bridges])

  const patch = useCallback((host: string, change: (current: HostWorkspace) => HostWorkspace) => {
    setByHost((current) => new Map(current).set(host, change(current.get(host) ?? EMPTY)))
  }, [])

  const relist = useCallback(
    (host: string) => {
      void bridgesRef.current(host)
        .invoke('session:list')
        .then(
          (rows) => patch(host, (current) => ({ ...current, sessions: rows, listed: true })),
          // Not listed: a host that cannot be reached has not said there are none.
          () => undefined
        )
    },
    [patch]
  )

  const rescan = useCallback(
    (host: string) => {
      patch(host, (current) => ({ ...current, scanning: true }))
      void bridgesRef.current(host)
        .invoke('discovery:scan', { includeGit: true })
        .then(
          (discovery) => patch(host, (current) => ({ ...current, discovery, scanning: false, scanError: undefined })),
          (error: unknown) => patch(host, (current) => ({ ...current, scanning: false, scanError: readable(error) }))
        )
    },
    [patch]
  )

  // What each listed host pushes, heard for as long as it is listed.
  const hostsKey = hosts.join('\n')
  useEffect(() => {
    if (hostsKey === '') return undefined
    const offs = hostsKey.split('\n').flatMap((host) => {
      const bridge = bridgesRef.current(host)
      return [
        bridge.on('discovery:updated', (discovery) =>
          patch(host, (current) => ({ ...current, discovery, scanError: undefined }))
        ),
        bridge.on('scan:status', (status) =>
          patch(host, (current) => ({
            ...current,
            scanning: status.running,
            ...(status.error === undefined ? {} : { scanError: status.error })
          }))
        ),
        bridge.on('settings:changed', (settings) =>
          patch(host, (current) => ({ ...current, pinnedProjects: settings.pinnedProjects }))
        ),
        bridge.on('session:exit', (record) =>
          patch(host, (current) => ({
            ...current,
            sessions: current.sessions.map((session) => (session.id === record.id ? record : session))
          }))
        ),
        bridge.on('session:activity', (states) => {
          let unknown = false
          patch(host, (current) => {
            const known = new Set(current.sessions.map((session) => session.id))
            unknown = states.some((state) => !known.has(state.id))
            return { ...current, activity: new Map(states.map((state) => [state.id, state])) }
          })
          // A session started elsewhere, such as from another device: listed again.
          if (unknown) relist(host)
        })
      ]
    })
    return () => {
      for (const off of offs) off()
    }
  }, [hostsKey, patch, relist])

  // Read afresh each time the window is connected to a host again.
  const connectedKey = connected.join('\n')
  const read = useRef(new Set<string>())
  useEffect(() => {
    const now = new Set(connectedKey === '' ? [] : connectedKey.split('\n'))
    for (const host of now) {
      if (read.current.has(host)) continue
      const bridge = bridgesRef.current(host)
      void bridge.invoke('settings:read').then(
        (settings) => patch(host, (current) => ({ ...current, pinnedProjects: settings.pinnedProjects })),
        () => undefined
      )
      void bridge.invoke('discovery:cached').then(
        (cached) => {
          if (cached.length === 0) return
          patch(host, (current) =>
            current.discovery !== null
              ? current
              : {
                  ...current,
                  discovery: {
                    roots: [],
                    harnesses: cached
                      .filter((project) => project.kind === 'harness')
                      .map((project) => ({
                        path: project.path,
                        name: project.name,
                        template: project.template,
                        version: null,
                        repoPaths: cached.filter((each) => each.harnessPath === project.path).map((each) => each.path)
                      })),
                    projects: cached,
                    errors: [],
                    scannedAt: cached[0]?.lastSeenAt ?? new Date().toISOString(),
                    durationMs: 0
                  }
                }
          )
        },
        (error: unknown) => patch(host, (current) => ({ ...current, scanError: readable(error) }))
      )
      rescan(host)
      relist(host)
      void bridge.invoke('session:activity').then(
        (states) => patch(host, (current) => ({ ...current, activity: new Map(states.map((state) => [state.id, state])) })),
        () => undefined
      )
    }
    read.current = now
  }, [connectedKey, patch, rescan, relist])

  const togglePin = useCallback(
    (host: string, path: string) => {
      const held = byHost.get(host)?.pinnedProjects ?? []
      const pinnedProjects = withProjectPinned([...held], path, !isProjectPinned(held, path))
      patch(host, (current) => ({ ...current, pinnedProjects }))
      void bridgesRef.current(host)
        .invoke('settings:write', { pinnedProjects })
        .then(
          (settings) => patch(host, (current) => ({ ...current, pinnedProjects: settings.pinnedProjects })),
          () => patch(host, (current) => ({ ...current, pinnedProjects: held }))
        )
    },
    [byHost, patch]
  )

  const adopt = useCallback(
    (host: string, record: SessionRecord) =>
      patch(host, (current) =>
        current.sessions.some((session) => session.id === record.id)
          ? { ...current, sessions: current.sessions.map((session) => (session.id === record.id ? record : session)) }
          : { ...current, sessions: [...current.sessions, record] }
      ),
    [patch]
  )

  const forget = useCallback(
    (host: string, id: number) =>
      patch(host, (current) => ({ ...current, sessions: current.sessions.filter((session) => session.id !== id) })),
    [patch]
  )

  return { byHost, rescan, togglePin, adopt, forget }
}
