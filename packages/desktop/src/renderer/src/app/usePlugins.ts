import { useEffect, useMemo, useState } from 'react'
import type { PluginInfo } from '../../../shared/ipc'
import { helm } from './bridge'

/** The plugins main loaded at start, by id. Read once: the spike loads them once. */
export function usePlugins(): ReadonlyMap<string, PluginInfo> {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  useEffect(() => {
    let live = true
    void helm.invoke('plugins:list').then((list) => {
      if (live) setPlugins(list)
    })
    return () => {
      live = false
    }
  }, [])
  return useMemo(() => new Map(plugins.map((plugin) => [plugin.id, plugin])), [plugins])
}
