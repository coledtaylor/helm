// @ts-check
/**
 * Vue composables over `window.helm`, built on the stores in `./stores.js`.
 * Optional: everything here is a few lines over the bridge, which a plugin
 * can use directly.
 *
 * A subscription ends with the effect scope it was made in: a component's
 * `setup()`, or an `effectScope()`. Made outside one, it lasts as long as the
 * page.
 */
import { getCurrentScope, onScopeDispose, shallowRef, toValue, watch } from 'vue'
import { bridge } from './bridge.js'
import { secret, settings, theme, visible } from './stores.js'

/** @param {() => void} off */
function endWithScope(off) {
  if (getCurrentScope() !== undefined) onScopeDispose(off)
}

/**
 * A store's value as a ref, kept current until the scope ends.
 *
 * @template T
 * @param {import('./stores').HelmStore<T>} store
 * @returns {Readonly<import('vue').Ref<T>>}
 */
function refOf(store) {
  const ref = shallowRef(store.current)
  endWithScope(
    store.subscribe((value) => {
      ref.value = value
    })
  )
  return ref
}

/**
 * Calls `listener` on every `event` until the scope ends.
 *
 * @template {keyof import('./types').HelmEvents} K
 * @param {K} event
 * @param {(data: import('./types').HelmEvents[K]) => void} listener
 */
export function useHelmEvent(event, listener) {
  endWithScope(bridge().on(event, (data) => listener(data)))
}

/**
 * Helm's theme. The tokens are on the page as CSS variables already; this is
 * for code that needs the values.
 *
 * @returns {Readonly<import('vue').Ref<import('./types').HelmTheme>>}
 */
export function useHelmTheme() {
  return refOf(theme)
}

/**
 * Whether the surface is on screen. A plugin that polls should poll only
 * while this is true.
 *
 * @returns {Readonly<import('vue').Ref<boolean>>}
 */
export function useHelmVisible() {
  return refOf(visible)
}

/**
 * The plugin's settings, or null until they have been read.
 *
 * @returns {Readonly<import('vue').Ref<Record<string, import('./types').SettingValue> | null>>}
 */
export function useHelmSettings() {
  return refOf(settings)
}

/**
 * Whether a declared secret is ready, and a function that asks the user to
 * add it. The state is null until it has been read. `key` may be a ref or a
 * getter; when it changes, the state follows the new key.
 *
 * @param {import('vue').MaybeRefOrGetter<string>} key
 * @returns {[Readonly<import('vue').Ref<import('./types').SecretState | null>>, () => Promise<void>]}
 */
export function useSecret(key) {
  const state = shallowRef(/** @type {import('./types').SecretState | null} */ (null))
  watch(
    () => toValue(key),
    (current, _previous, onCleanup) => {
      onCleanup(
        secret(current).subscribe((value) => {
          state.value = value
        })
      )
    },
    { immediate: true }
  )
  const request = async () => {
    await secret(toValue(key)).request()
  }
  return [state, request]
}
