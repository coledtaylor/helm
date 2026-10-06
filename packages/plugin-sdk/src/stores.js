// @ts-check
/**
 * Helm's state as stores, for any framework or none.
 *
 * A store's `subscribe(run)` calls `run` with the current value straight away
 * and again on every change, and returns the function that unsubscribes. That
 * is Svelte's store contract, so a Svelte component reads `$settings` with no
 * adapter, and the React hooks and Vue composables are built on these.
 */
import { bridge } from './bridge.js'

/**
 * @template T
 * @typedef {import('./stores').HelmStore<T>} HelmStore
 */

/**
 * Hands `value` to `run`. A subscriber that throws is its own bug: the error
 * is reported on its own, as the bridge does for its listeners, and the
 * subscribers after it are still told.
 *
 * @template T
 * @param {(value: T) => void} run
 * @param {T} value
 */
function deliver(run, value) {
  try {
    run(value)
  } catch (error) {
    setTimeout(() => {
      throw error
    })
  }
}

/**
 * A value the bridge holds as a property, and the event that says it changed.
 *
 * @template {'theme' | 'visibility'} K
 * @param {(helm: import('./types').HelmBridge) => import('./types').HelmEvents[K]} read
 * @param {K} event
 * @returns {HelmStore<import('./types').HelmEvents[K]>}
 */
function property(read, event) {
  return {
    get current() {
      return read(bridge())
    },
    subscribe(run) {
      const helm = bridge()
      run(read(helm))
      // A listener of its own: the bridge keeps a set, so two subscriptions
      // passing the same function would otherwise share one entry.
      return helm.on(event, (value) => run(value))
    }
  }
}

/**
 * A value Helm has to be asked for, then kept current by an event. It is null
 * until the first read answers. However many subscribe, there is one read and
 * one listener; when the last one leaves the value is forgotten, since nothing
 * kept it current after that, and the next subscriber reads again.
 *
 * `update` takes a value newer than any read in flight - an event's, or what a
 * request answered - so a read that answers after one is dropped.
 *
 * @template T
 * @param {(helm: import('./types').HelmBridge) => Promise<T>} read
 * @param {(helm: import('./types').HelmBridge, update: (value: T) => void) => () => void} listen
 * @returns {{ store: HelmStore<T | null>, update: (value: T) => void }}
 */
function loaded(read, listen) {
  /** @type {T | null} */
  let value = null
  /** @type {Set<{ run: (value: T | null) => void }>} */
  const subscribers = new Set()
  /**
   * While anybody is subscribed: the listener, and whether something newer
   * than the read has arrived.
   *
   * @type {{ off: () => void, overtaken: boolean } | null}
   */
  let running = null

  /** @param {T} next */
  const publish = (next) => {
    if (Object.is(next, value)) return
    value = next
    for (const subscriber of [...subscribers]) {
      // One that unsubscribed while an earlier one ran is not told.
      if (subscribers.has(subscriber)) deliver(subscriber.run, next)
    }
  }

  /** @param {T} next */
  const update = (next) => {
    if (running === null) return
    running.overtaken = true
    publish(next)
  }

  const start = () => {
    const helm = bridge()
    const run = { off: listen(helm, update), overtaken: false }
    running = run
    void read(helm).then((first) => {
      if (running === run && !run.overtaken) publish(first)
    })
  }

  const stop = () => {
    running?.off()
    running = null
    value = null
  }

  return {
    store: {
      get current() {
        return value
      },
      subscribe(run) {
        if (subscribers.size === 0) start()
        const subscriber = { run }
        subscribers.add(subscriber)
        run(value)
        return () => {
          if (subscribers.delete(subscriber) && subscribers.size === 0) stop()
        }
      }
    },
    update
  }
}

/** Helm's theme. The tokens are on the page as CSS variables already; this is for code that needs the values. */
export const theme = property((helm) => helm.theme, 'theme')

/** Whether the surface is on screen. A plugin that polls should poll only while this is true. */
export const visible = property((helm) => helm.visible, 'visibility')

/** The plugin's settings: null until they have been read, then kept current. */
export const settings = loaded(
  (helm) => helm.settings.get(),
  (helm, update) => helm.on('settings', (values) => update(values))
).store

/** @type {Map<string, import('./stores').SecretStore>} */
const secrets = new Map()

/**
 * Whether a declared secret is ready: null until it has been read, then kept
 * current. The same key is always the same store.
 *
 * @param {string} key
 * @returns {import('./stores').SecretStore}
 */
export function secret(key) {
  const known = secrets.get(key)
  if (known !== undefined) return known
  const { store, update } = loaded(
    (helm) => helm.secrets.state(key),
    (helm, set) =>
      helm.on('secrets', (states) => {
        const state = states[key]
        if (state !== undefined) set(state)
      })
  )
  /** @type {import('./stores').SecretStore} */
  const made = {
    get current() {
      return store.current
    },
    subscribe: store.subscribe,
    async request() {
      const state = await bridge().secrets.request(key)
      update(state)
      return state
    }
  }
  secrets.set(key, made)
  return made
}
