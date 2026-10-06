import { useCallback, useEffect, useState } from 'react'
import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginLogLine, PluginMetrics, SecretInput, SecretsState } from '../../../shared/ipc'
import { helm } from './bridge'
import { readable } from './errors'

/** How often a plugin's page re-reads what it costs and what it printed, while it is on screen. */
const WATCH_MS = 2000

export interface PluginSettingsState {
  /** Null until main has answered. Kept current by `secrets:changed`. */
  secrets: SecretsState | null
  /** Why the last folder picked was not added. */
  addError: string | null
  add: () => void
  setEnabled: (path: string, enabled: boolean) => void
  setTools: (path: string, enabled: boolean) => void
  reload: (path: string) => void
  remove: (path: string, deleteSecrets: string[]) => void
  ownSecrets: (path: string) => Promise<string[]>
  /** Each resolves null when main took it, or main's sentence when it did not. */
  setSetting: (plugin: string, key: string, value: SettingValue) => Promise<string | null>
  saveSecret: (input: SecretInput) => Promise<string | null>
  removeSecret: (key: string) => Promise<string | null>
  /** The watched plugin's figures and log; null until read. */
  metrics: PluginMetrics | null
  log: PluginLogLine[] | null
}

/**
 * What Settings does with plugins and secrets, and what it shows of them.
 *
 * `watching` is the folder of the plugin whose page is on screen. Only then
 * are its figures and log read, every two seconds - the figures cost a walk of
 * every process, and nobody reads a log that is not in front of them.
 */
export function usePluginSettings(watching: string | null): PluginSettingsState {
  const [secrets, setSecrets] = useState<SecretsState | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const [watched, setWatched] = useState<{ path: string; metrics: PluginMetrics | null; log: PluginLogLine[] | null } | null>(
    null
  )

  useEffect(() => {
    let takeRead = true
    const off = helm.on('secrets:changed', (next) => {
      takeRead = false
      setSecrets(next)
    })
    void helm.invoke('secrets:list').then(
      (first) => {
        if (takeRead) setSecrets(first)
      },
      () => undefined
    )
    return () => {
      takeRead = false
      off()
    }
  }, [])

  useEffect(() => {
    if (watching === null) return undefined
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // One read at a time: the next is scheduled when this one lands, so a
    // slow walk never stacks reads behind it.
    const read = (): void => {
      void Promise.all([
        helm.invoke('plugins:metrics').catch(() => null),
        helm.invoke('plugins:log', { path: watching }).catch(() => null)
      ]).then(([metrics, log]) => {
        if (!live) return
        setWatched({
          path: watching,
          metrics: metrics?.find((entry) => entry.path === watching) ?? null,
          log
        })
        timer = setTimeout(read, WATCH_MS)
      })
    }
    read()
    return () => {
      live = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [watching])

  const add = useCallback(() => {
    void helm.invoke('plugins:add').then(
      (result) => setAddError(result.error),
      (error: unknown) => setAddError(readable(error))
    )
  }, [])

  const setEnabled = useCallback((path: string, enabled: boolean) => {
    void helm.invoke('plugins:setEnabled', { path, enabled })
  }, [])

  const setTools = useCallback((path: string, enabled: boolean) => {
    void helm.invoke('plugins:setTools', { path, enabled })
  }, [])

  const reload = useCallback((path: string) => {
    void helm.invoke('plugins:reload', { path })
  }, [])

  const remove = useCallback((path: string, deleteSecrets: string[]) => {
    void helm.invoke('plugins:remove', { path, deleteSecrets })
  }, [])

  const ownSecrets = useCallback((path: string) => helm.invoke('plugins:ownSecrets', { path }), [])

  const setSetting = useCallback(
    (plugin: string, key: string, value: SettingValue) =>
      helm.invoke('plugins:setSetting', { plugin, key, value }).then(
        () => null,
        (error: unknown) => readable(error)
      ),
    []
  )

  const saveSecret = useCallback(
    (input: SecretInput) =>
      helm.invoke('secrets:save', input).then(
        (next) => {
          setSecrets(next)
          return null
        },
        (error: unknown) => readable(error)
      ),
    []
  )

  const removeSecret = useCallback(
    (key: string) =>
      helm.invoke('secrets:remove', { key }).then(
        (next) => {
          setSecrets(next)
          return null
        },
        (error: unknown) => readable(error)
      ),
    []
  )

  const current = watched !== null && watched.path === watching ? watched : null
  return {
    secrets,
    addError,
    add,
    setEnabled,
    setTools,
    reload,
    remove,
    ownSecrets,
    setSetting,
    saveSecret,
    removeSecret,
    metrics: current?.metrics ?? null,
    log: current?.log ?? null
  }
}
