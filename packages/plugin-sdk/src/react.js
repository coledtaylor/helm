// @ts-check
/**
 * React hooks over `window.helm`. Optional: everything here is a few lines
 * over the bridge, which a plugin can use directly.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** @returns {import('./types').HelmBridge} */
function bridge() {
  const helm = /** @type {{ helm?: import('./types').HelmBridge }} */ (/** @type {unknown} */ (window)).helm
  if (helm === undefined) throw new Error('window.helm is missing: this page is not being served by Helm')
  return helm
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
  return useSyncExternalStore(
    (onChange) => bridge().on('theme', onChange),
    () => bridge().theme
  )
}

/**
 * Whether the surface is on screen. A plugin that polls should poll only
 * while this is true.
 *
 * @returns {boolean}
 */
export function useHelmVisible() {
  return useSyncExternalStore(
    (onChange) => bridge().on('visibility', onChange),
    () => bridge().visible
  )
}

/**
 * The plugin's settings, or null until they have been read.
 *
 * @returns {Record<string, import('./types').SettingValue> | null}
 */
export function useHelmSettings() {
  const [values, setValues] = useState(/** @type {Record<string, import('./types').SettingValue> | null} */ (null))
  useEffect(() => {
    let live = true
    const off = bridge().on('settings', setValues)
    void bridge()
      .settings.get()
      .then((read) => {
        if (live) setValues(read)
      })
    return () => {
      live = false
      off()
    }
  }, [])
  return values
}

/**
 * Whether a declared secret is ready, and a function that asks the user to
 * add it. The state is null until it has been read.
 *
 * @param {string} key
 * @returns {[import('./types').SecretState | null, () => Promise<void>]}
 */
export function useSecret(key) {
  const [state, setState] = useState(/** @type {import('./types').SecretState | null} */ (null))
  useEffect(() => {
    let live = true
    const off = bridge().on('secrets', (states) => {
      const next = states[key]
      if (next !== undefined) setState(next)
    })
    void bridge()
      .secrets.state(key)
      .then((read) => {
        if (live) setState(read)
      })
    return () => {
      live = false
      off()
    }
  }, [key])
  const request = useCallback(async () => {
    setState(await bridge().secrets.request(key))
  }, [key])
  return [state, request]
}
