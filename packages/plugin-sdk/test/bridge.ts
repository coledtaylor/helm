import type { HelmBridge, HelmEvents, HelmTheme, SecretState, SettingValue } from '../src/types'

/**
 * A `window.helm` the framework helpers' tests drive. Events fire when the
 * test says, and every read waits until the test answers it, so the order of
 * a read and an event is the test's to choose. Property and event behave as
 * the real bridge does: the property changes first, then the event fires.
 */

export interface Pending<T> {
  /** Resolves the call, then waits for whatever was waiting on it. */
  answer(value: T): Promise<void>
}

interface Call<T> extends Pending<T> {
  key: string
}

export interface FakeBridge {
  readonly settingsReads: Array<Pending<Record<string, SettingValue>>>
  readonly stateReads: Array<Call<SecretState>>
  readonly requests: Array<Call<SecretState>>
  emit<K extends keyof HelmEvents>(event: K, data: HelmEvents[K]): void
  /** How many listeners `event` has. */
  listeners(event: keyof HelmEvents): number
}

export const DARK: HelmTheme = { kind: 'dark', tokens: {} as HelmTheme['tokens'], radius: 6, density: 'comfortable' }
export const LIGHT: HelmTheme = { kind: 'light', tokens: {} as HelmTheme['tokens'], radius: 6, density: 'compact' }

function pending<T>(): { promise: Promise<T>; call: Pending<T> } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return {
    promise,
    call: {
      async answer(value) {
        resolve(value)
        await promise
      }
    }
  }
}

/** Puts a fake `window.helm` on the global object, in place of any before it. */
export function installBridge(): FakeBridge {
  let theme = DARK
  let visible = false
  const listeners = new Map<keyof HelmEvents, Set<(data: never) => void>>()
  const settingsReads: Array<Pending<Record<string, SettingValue>>> = []
  const stateReads: Array<Call<SecretState>> = []
  const requests: Array<Call<SecretState>> = []

  const keyed = (into: Array<Call<SecretState>>, key: string): Promise<SecretState> => {
    const { promise, call } = pending<SecretState>()
    into.push({ ...call, key })
    return promise
  }

  const helm = {
    get theme() {
      return theme
    },
    get visible() {
      return visible
    },
    settings: {
      get() {
        const { promise, call } = pending<Record<string, SettingValue>>()
        settingsReads.push(call)
        return promise
      }
    },
    secrets: {
      state: (key: string) => keyed(stateReads, key),
      request: (key: string) => keyed(requests, key)
    },
    on<K extends keyof HelmEvents>(event: K, listener: (data: HelmEvents[K]) => void) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener as (data: never) => void)
      listeners.set(event, set)
      return () => {
        set.delete(listener as (data: never) => void)
      }
    }
  }
  ;(globalThis as { helm?: unknown }).helm = helm as unknown as HelmBridge

  return {
    settingsReads,
    stateReads,
    requests,
    emit(event, data) {
      if (event === 'theme') theme = data as HelmTheme
      if (event === 'visibility') visible = data as boolean
      for (const listener of [...(listeners.get(event) ?? [])]) (listener as (value: typeof data) => void)(data)
    },
    listeners: (event) => listeners.get(event)?.size ?? 0
  }
}

export function removeBridge(): void {
  delete (globalThis as { helm?: unknown }).helm
}
