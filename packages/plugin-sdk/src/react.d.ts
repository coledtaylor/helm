import type { HelmEvents, HelmTheme, SecretState, SettingValue } from './types'

/** Calls `listener` on every `event`, always the latest `listener` passed. */
export function useHelmEvent<K extends keyof HelmEvents>(event: K, listener: (data: HelmEvents[K]) => void): void

/** Helm's theme, re-rendering when it changes. */
export function useHelmTheme(): HelmTheme

/** Whether the surface is on screen. */
export function useHelmVisible(): boolean

/** The plugin's settings, or null until they have been read. */
export function useHelmSettings(): Record<string, SettingValue> | null

/** Whether a declared secret is ready (null until read), and a function that asks the user to add it. */
export function useSecret(key: string): [SecretState | null, () => Promise<void>]
