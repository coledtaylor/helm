// @ts-check
/**
 * React hooks over `window.helm`, built on the stores in `./stores.js`.
 * Optional: everything here is a few lines over the bridge, which a plugin
 * can use directly.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { bridge } from './bridge.js'
import { secret, settings, theme, visible } from './stores.js'

/**
 * A store's value, re-rendering when it changes. A store's `subscribe` reads
 * no `this` and is the same function every render, so React holds it as it is.
 *
 * @template T
 * @param {import('./stores').HelmStore<T>} store
 * @returns {T}
 */
function useStore(store) {
  return useSyncExternalStore(store.subscribe, () => store.current)
}

/**
 * Calls `listener` on every `event`, always the latest `listener` passed.
 *
 * @template {keyof import('./types').HelmEvents} K
 * @param {K} event
 * @param {(data: import('./types').HelmEvents[K]) => void} listener
 */
export function useHelmEvent(event, listener) {
  const latest = useRef(listener)
  useEffect(() => {
    latest.current = listener
  })
  useEffect(() => bridge().on(event, (data) => latest.current(data)), [event])
}

/**
 * Helm's theme, re-rendering when it changes. The tokens are on the page as
 * CSS variables already; this is for code that needs the values.
 *
 * @returns {import('./types').HelmTheme}
 */
export function useHelmTheme() {
  return useStore(theme)
}

/**
 * Whether the surface is on screen. A plugin that polls should poll only
 * while this is true.
 *
 * @returns {boolean}
 */
export function useHelmVisible() {
  return useStore(visible)
}

/**
 * The plugin's settings, or null until they have been read.
 *
 * @returns {Record<string, import('./types').SettingValue> | null}
 */
export function useHelmSettings() {
  return useStore(settings)
}

/**
 * Whether a declared secret is ready, and a function that asks the user to
 * add it. The state is null until it has been read.
 *
 * @param {string} key
 * @returns {[import('./types').SecretState | null, () => Promise<void>]}
 */
export function useSecret(key) {
  const store = secret(key)
  const state = useStore(store)
  const request = useCallback(async () => {
    await store.request()
  }, [store])
  return [state, request]
}
