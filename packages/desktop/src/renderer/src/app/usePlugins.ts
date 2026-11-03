import { useEffect, useMemo, useState } from 'react'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import type { HelmBridge, PluginInfo } from '../../../shared/ipc'
import { bridgeFor } from './bridge'
import { readable } from './errors'

export interface PluginsState {
  /**
   * Every registered folder, in the order it was added. Null until the host
   * has answered: a restored plugin tab is kept while this is null, and only
   * dropped once the list says its plugin is not there.
   */
  list: PluginInfo[] | null
  /**
   * Why the host could not say which plugins there are while `list` is still
   * null. "Could not look" is never read as "no plugins": the list stays
   * unknown and restored plugin tabs are kept.
   */
  error: string | null
  /** The plugins that are on - enabled and loaded - by id. Only these have surfaces. */
  live: ReadonlyMap<string, PluginInfo>
}

/** The plugins that are on, by id, out of a list. */
export function livePlugins(list: readonly PluginInfo[] | null): ReadonlyMap<string, PluginInfo> {
  return new Map(
    (list ?? []).flatMap((plugin): Array<[string, PluginInfo]> =>
      plugin.enabled && plugin.error === null && plugin.id !== null ? [[plugin.id, plugin]] : []
    )
  )
}

/**
 * One host's plugin list through its bridge, kept current by
 * `plugins:changed`: `onList` with each list, `onError` when the first read
 * failed before any list came. Returns the stop.
 */
export function watchPlugins(
  helm: HelmBridge,
  onList: (list: PluginInfo[]) => void,
  onError: (reason: string) => void
): () => void {
  let takeRead = true
  let live = true
  // Subscribed first, so a change landing during the read is not lost; the
  // read only fills in when no change has arrived yet.
  const off = helm.on('plugins:changed', (next) => {
    takeRead = false
    if (live) onList(next)
  })
  helm.invoke('plugins:list').then(
    (first) => {
      if (live && takeRead) onList(first)
    },
    (failure: unknown) => {
      if (live && takeRead) onError(readable(failure))
    }
  )
  return () => {
    live = false
    off()
  }
}

/** What was read, and from which host. */
interface Read {
  host: string
  list: PluginInfo[] | null
  error: string | null
}

/**
 * The plugins one host has (this PC's by default), through that host's
 * bridge only. Switched to another host, it says nothing until that host
 * answers: one host's list is never shown as another's.
 */
export function usePlugins(host: string = LOCAL_HOST_KEY): PluginsState {
  const [read, setRead] = useState<Read | null>(null)
  useEffect(
    () =>
      watchPlugins(
        bridgeFor(host),
        (list) => setRead({ host, list, error: null }),
        (error) => setRead({ host, list: null, error })
      ),
    [host]
  )
  const current = read !== null && read.host === host ? read : null
  const list = current?.list ?? null
  const live = useMemo(() => livePlugins(list), [list])
  return { list, error: current?.error ?? null, live }
}

/**
 * The plugins of each host on another computer in `hosts`, each read through
 * its own bridge while it is listed: for the rail, which shows each connected
 * host's plugins after this PC's. A host that leaves `hosts` is dropped.
 */
export function useHostPlugins(hosts: readonly string[]): ReadonlyMap<string, PluginsState> {
  const [reads, setReads] = useState<ReadonlyMap<string, Read>>(new Map())
  const key = hosts.join('\n')
  useEffect(() => {
    const ids = key === '' ? [] : key.split('\n')
    const put = (next: Read): void =>
      setReads((current) => {
        const map = new Map(current)
        map.set(next.host, next)
        return map
      })
    const stops = ids.map((host) =>
      watchPlugins(
        bridgeFor(host),
        (list) => put({ host, list, error: null }),
        (error) => put({ host, list: null, error })
      )
    )
    return () => {
      for (const stop of stops) stop()
    }
  }, [key])
  return useMemo(() => {
    const ids = key === '' ? [] : key.split('\n')
    return new Map(
      ids.map((host): [string, PluginsState] => {
        const read = reads.get(host)
        return [host, { list: read?.list ?? null, error: read?.error ?? null, live: livePlugins(read?.list ?? null) }]
      })
    )
  }, [key, reads])
}
