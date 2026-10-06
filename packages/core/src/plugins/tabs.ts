import { ID_PATTERN, NAME_PATTERN } from '@coledtaylor/helm-plugin-sdk/manifest'

/**
 * A plugin's tab as the layout holds it: which plugin, which of its tabs, and
 * the parameters it was opened with.
 *
 * Pure and browser-safe, like `layout/panes.ts`: the renderer opens these
 * tabs, the settings validator checks them on the way into the database, and
 * main checks what a plugin asked to open - and all three must agree on what
 * a tab's parameters may be and on the one string that names a tab.
 */

/** A tab's parameters. Part of its identity: the same tab with other parameters is another tab. */
export type PluginParams = Record<string, string | number | boolean>

/** How much a tab may carry. Parameters name a thing (`{ run: 1234 }`); they are not the thing's data. */
export const PLUGIN_PARAMS_LIMITS = { keys: 16, keyLength: 64, valueLength: 512 } as const

/** A tab title a page may set, at most this long. */
export const PLUGIN_TITLE_MAX = 120

const PARAM_KEY = /^[A-Za-z0-9_.-]+$/

/** Why `value` is not a tab's parameters, or null when it is. */
export function pluginParamsProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'expected parameters as an object'
  }
  const entries = Object.entries(value)
  if (entries.length > PLUGIN_PARAMS_LIMITS.keys) {
    return `expected at most ${String(PLUGIN_PARAMS_LIMITS.keys)} parameters, got ${String(entries.length)}`
  }
  for (const [key, entry] of entries) {
    if (key.length > PLUGIN_PARAMS_LIMITS.keyLength || !PARAM_KEY.test(key)) {
      return `parameter name ${JSON.stringify(key)} must be letters, digits, dots, dashes and underscores`
    }
    if (typeof entry === 'string') {
      if (entry.length > PLUGIN_PARAMS_LIMITS.valueLength) {
        return `parameter ${key} is longer than ${String(PLUGIN_PARAMS_LIMITS.valueLength)} characters`
      }
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return `parameter ${key} must be a finite number`
    } else if (typeof entry !== 'boolean') {
      return `parameter ${key} must be a string, a number or true/false`
    }
  }
  return null
}

/** Whether a plugin id and tab name are ones a manifest could have declared. */
export function pluginTabNameProblem(plugin: unknown, tab: unknown): string | null {
  if (typeof plugin !== 'string' || !ID_PATTERN.test(plugin)) return `expected a plugin id, got ${JSON.stringify(plugin)}`
  if (typeof tab !== 'string' || !NAME_PATTERN.test(tab)) return `expected a plugin tab name, got ${JSON.stringify(tab)}`
  return null
}

/**
 * The parameters in one spelling: keys sorted, so `{ a, b }` and `{ b, a }`
 * open one tab rather than two.
 */
export function canonicalParams(params: PluginParams): string {
  const keys = Object.keys(params).sort()
  return keys.length === 0 ? '' : JSON.stringify(Object.fromEntries(keys.map((key) => [key, params[key]])))
}

/** The tab's identity in the layout: `plugin:<id>/<tab>`, with `?<parameters>` when it has any. */
export function pluginTabId(plugin: string, tab: string, params: PluginParams): string {
  const query = canonicalParams(params)
  return `plugin:${plugin}/${tab}${query === '' ? '' : `?${query}`}`
}

/**
 * A plugin's place on the rail, as `railHidden` and `data-rail` name it.
 * Prefixed so a plugin can never take the id of one of Helm's own destinations.
 */
export type PluginRailId = `plugin:${string}`

export function pluginRailId(plugin: string): PluginRailId {
  return `plugin:${plugin}`
}

export function isPluginRailId(value: string): value is PluginRailId {
  return value.startsWith('plugin:') && ID_PATTERN.test(value.slice('plugin:'.length))
}
