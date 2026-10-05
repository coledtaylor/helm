import { asc, eq } from 'drizzle-orm'
import type { Store } from './db'
import { secrets } from './schema'

/**
 * The secrets table, as rows. The value is ciphertext and this module never
 * sees anything else: encrypting and decrypting is the host's, because the
 * key that does it belongs to the Windows user and is reached through
 * Electron, which core never imports.
 */

export interface SecretRow {
  key: string
  /** Ciphertext. */
  value: Buffer
  hosts: string[]
  plugins: string[]
  createdAt: string
  updatedAt: string
}

export function readSecrets(store: Store): SecretRow[] {
  return store.db.select().from(secrets).orderBy(asc(secrets.key)).all()
}

export function readSecret(store: Store, key: string): SecretRow | null {
  return store.db.select().from(secrets).where(eq(secrets.key, key)).get() ?? null
}

/**
 * Stores a secret, or changes who may use one.
 *
 * `value` is required for a new key and optional for an existing one: editing
 * the hosts or plugins of a stored secret does not mean typing it again, and
 * the form never has the old value to send back.
 */
export function writeSecret(
  store: Store,
  entry: { key: string; value: Buffer | null; hosts: string[]; plugins: string[] }
): void {
  const updatedAt = new Date().toISOString()
  const existing = readSecret(store, entry.key)
  if (existing === null) {
    if (entry.value === null) throw new Error(`secret ${entry.key} has no value`)
    store.db
      .insert(secrets)
      .values({ key: entry.key, value: entry.value, hosts: entry.hosts, plugins: entry.plugins, createdAt: updatedAt, updatedAt })
      .run()
    return
  }
  store.db
    .update(secrets)
    .set({
      ...(entry.value === null ? {} : { value: entry.value }),
      hosts: entry.hosts,
      plugins: entry.plugins,
      updatedAt
    })
    .where(eq(secrets.key, entry.key))
    .run()
}

export function deleteSecret(store: Store, key: string): boolean {
  return store.db.delete(secrets).where(eq(secrets.key, key)).run().changes > 0
}
