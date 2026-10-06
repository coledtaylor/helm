import type { MaybeRefOrGetter, Ref } from 'vue'
import type { HelmEvents, HelmTheme, SecretState, SettingValue } from './types'

/** Calls `listener` on every `event` until the effect scope it was called in ends. */
export function useHelmEvent<K extends keyof HelmEvents>(event: K, listener: (data: HelmEvents[K]) => void): void

/** Helm's theme, kept current. */
export function useHelmTheme(): Readonly<Ref<HelmTheme>>

/** Whether the surface is on screen. */
export function useHelmVisible(): Readonly<Ref<boolean>>

/** The plugin's settings, or null until they have been read. */
export function useHelmSettings(): Readonly<Ref<Record<string, SettingValue> | null>>

/**
 * Whether a declared secret is ready (null until read), and a function that
 * asks the user to add it. `key` may be a ref or a getter.
 */
export function useSecret(key: MaybeRefOrGetter<string>): [Readonly<Ref<SecretState | null>>, () => Promise<void>]
