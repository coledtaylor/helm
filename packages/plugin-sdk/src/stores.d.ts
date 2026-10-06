import type { HelmTheme, SecretState, SettingValue } from './types'

/**
 * A value Helm keeps current. `subscribe` calls `run` with the value straight
 * away and again whenever it changes, and returns the function that
 * unsubscribes. That is Svelte's store contract, so `$store` works in a Svelte
 * component as it is.
 */
export interface HelmStore<T> {
  /** The value now. */
  readonly current: T
  subscribe(this: void, run: (value: T) => void): () => void
}

/** A declared secret's state: null until it has been read. */
export interface SecretStore extends HelmStore<SecretState | null> {
  /** Opens Helm's dialog for adding the key, scoped to this plugin. Resolves with the state once it closes, which the store takes too. */
  request(): Promise<SecretState>
}

/** Helm's theme. The tokens are on the page as CSS variables already; this is for code that needs the values. */
export const theme: HelmStore<HelmTheme>

/** Whether the surface is on screen. Always false for the background page. */
export const visible: HelmStore<boolean>

/** The plugin's settings: null until they have been read, then kept current. */
export const settings: HelmStore<Record<string, SettingValue> | null>

/** A declared secret's state. The same key is always the same store. */
export function secret(key: string): SecretStore
