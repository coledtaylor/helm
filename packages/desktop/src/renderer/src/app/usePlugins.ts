import { useEffect, useMemo, useState } from 'react'
import type { PluginInfo } from '../../../shared/ipc'
import { helm } from './bridge'

export interface PluginsState {
  /**
   * Every registered folder, in the order it was added. Null until main has
   * answered: a restored plugin tab is kept while this is null, and only
   * dropped once the list says its plugin is not there.
   */
  list: PluginInfo[] | null
  /** The plugins that are on - enabled and loaded - by id. Only these have surfaces. */
  live: ReadonlyMap<string, PluginInfo>
}

/** The plugins main has, kept current by `plugins:changed`. */
export function usePlugins(): PluginsState {
  const [list, setList] = useState<PluginInfo[] | null>(null)
  useEffect(() => {
    let takeRead = true
    // Subscribed first, so a change landing during the read is not lost; the
    // read only fills in when no change has arrived yet.
    const off = helm.on('plugins:changed', (next) => {
      takeRead = false
      setList(next)
    })
    void helm.invoke('plugins:list').then(
      (first) => {
        if (takeRead) setList(first)
      },
      () => {
        if (takeRead) setList([])
      }
    )
    return () => {
      takeRead = false
      off()
    }
  }, [])
  const live = useMemo(
    () =>
      new Map(
        (list ?? []).flatMap((plugin): Array<[string, PluginInfo]> =>
          plugin.enabled && plugin.error === null && plugin.id !== null ? [[plugin.id, plugin]] : []
        )
      ),
    [list]
  )
  return { list, live }
}
