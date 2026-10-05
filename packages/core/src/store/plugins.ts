import { and, eq, sql } from 'drizzle-orm'
import type { Store } from './db'
import { pluginSettings, plugins } from './schema'

/**
 * The plugin folders the user registered, and what they set on each plugin's
 * settings page. What a plugin *is* is never stored here: it is read from the
 * folder every time (see `schema.ts`).
 */

export interface PluginFolder {
  path: string
  enabled: boolean
  addedAt: string
}

/** A value a plugin's settings page can hold. */
export type PluginSettingValue = string | number | boolean

/**
 * In the order they were added, which is the order the rail and Settings list
 * them. By `rowid` rather than `added_at`, which two folders added in one
 * millisecond would share.
 */
export function readPluginFolders(store: Store): PluginFolder[] {
  return store.db
    .select()
    .from(plugins)
    .orderBy(sql`rowid`)
    .all()
    .map((row) => ({ path: row.path, enabled: row.enabled, addedAt: row.addedAt }))
}

/**
 * Registers a folder, enabled. Two spellings of one Windows path are one
 * folder, so the comparison ignores case; a folder already registered is
 * returned as it is rather than added twice.
 */
export function addPluginFolder(store: Store, path: string): PluginFolder {
  const existing = findFolder(store, path)
  if (existing !== null) return existing
  const addedAt = new Date().toISOString()
  store.db.insert(plugins).values({ path, enabled: true, addedAt }).run()
  return { path, enabled: true, addedAt }
}

export function setPluginEnabled(store: Store, path: string, enabled: boolean): void {
  const existing = findFolder(store, path)
  if (existing === null) return
  store.db.update(plugins).set({ enabled }).where(eq(plugins.path, existing.path)).run()
}

export function removePluginFolder(store: Store, path: string): void {
  const existing = findFolder(store, path)
  if (existing === null) return
  store.db.delete(plugins).where(eq(plugins.path, existing.path)).run()
}

function findFolder(store: Store, path: string): PluginFolder | null {
  const row = store.db
    .select()
    .from(plugins)
    .where(sql`lower(${plugins.path}) = lower(${path})`)
    .get()
  return row === undefined ? null : { path: row.path, enabled: row.enabled, addedAt: row.addedAt }
}

/** What the user set for one plugin. Keys the manifest no longer declares are the caller's to ignore. */
export function readPluginSettings(store: Store, plugin: string): Record<string, PluginSettingValue> {
  const out: Record<string, PluginSettingValue> = {}
  for (const row of store.db.select().from(pluginSettings).where(eq(pluginSettings.plugin, plugin)).all()) {
    out[row.key] = row.value
  }
  return out
}

/** One value, or null to go back to the manifest's default. */
export function writePluginSetting(
  store: Store,
  plugin: string,
  key: string,
  value: PluginSettingValue | null
): void {
  if (value === null) {
    store.db
      .delete(pluginSettings)
      .where(and(eq(pluginSettings.plugin, plugin), eq(pluginSettings.key, key)))
      .run()
    return
  }
  const updatedAt = new Date().toISOString()
  store.db
    .insert(pluginSettings)
    .values({ plugin, key, value, updatedAt })
    .onConflictDoUpdate({ target: [pluginSettings.plugin, pluginSettings.key], set: { value, updatedAt } })
    .run()
}

export function forgetPluginSettings(store: Store, plugin: string): void {
  store.db.delete(pluginSettings).where(eq(pluginSettings.plugin, plugin)).run()
}
