import { sql } from 'drizzle-orm'
import { DEFAULT_SETTINGS, type AppSettings } from '../types'
import type { Store } from './db'
import { appSettings } from './schema'

/**
 * `app_settings` as a typed object rather than a key-value bag at the call
 * site. Unknown keys in the table are ignored and missing keys fall back to
 * `DEFAULT_SETTINGS`, so a database written by an older or newer build still
 * loads.
 */

export function readSettings(store: Store): AppSettings {
  const rows = store.db.select().from(appSettings).all()
  const result: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue
    try {
      // A hand-edited or truncated value must not take the whole app down with
      // it; one unreadable key falls back to its default.
      Object.assign(result, { [row.key]: JSON.parse(row.value) as unknown })
    } catch {
      continue
    }
  }
  return result
}

export function writeSetting<K extends keyof AppSettings>(
  store: Store,
  key: K,
  value: AppSettings[K]
): void {
  store.db
    .insert(appSettings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: JSON.stringify(value),
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      }
    })
    .run()
}

export function writeSettings(store: Store, patch: Partial<AppSettings>): AppSettings {
  const apply = store.raw.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue
      writeSetting(store, key as keyof AppSettings, value as AppSettings[keyof AppSettings])
    }
  })
  apply()
  return readSettings(store)
}
