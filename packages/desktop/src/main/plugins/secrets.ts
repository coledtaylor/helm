import { safeStorage } from 'electron'
import {
  deleteSecret,
  readSecret,
  readSecrets,
  writeSecret,
  type Store
} from '@helm/core'
import { ID_PATTERN, originMatches, parseOrigin, SECRET_KEY_PATTERN } from '@coledtaylor/helm-plugin-sdk/manifest'
import { PluginCallError } from './errors'
import type { Reveal } from './substitute'

/**
 * Settings > Secrets: values the user stores so plugins can use them without
 * ever holding them.
 *
 * A secret is a key, a value, and two lists the user controls - the origins
 * the value may be sent to and the plugins that may use it. A plugin writes
 * `{{key}}` where the value goes; Helm puts it there at the last moment, in
 * this process, after checking that the plugin declared the key, that the user
 * allowed this plugin, and - for a request - that the user allowed the
 * request's origin. The value never goes back to the window or to any page,
 * plugin or Helm's own, once it is saved.
 *
 * Stored encrypted (`SecretCrypto`), and only encrypted: if this computer
 * cannot encrypt, storing is refused rather than falling back to plaintext.
 */

export interface SecretCrypto {
  available(): boolean
  encrypt(text: string): Buffer
  decrypt(data: Buffer): string
}

/** Electron's `safeStorage`: DPAPI on Windows, bound to the signed-in user. */
export const safeStorageCrypto: SecretCrypto = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data)
}

/** What the window may know about a secret: everything except the value. */
export interface SecretInfo {
  key: string
  hosts: string[]
  plugins: string[]
  updatedAt: string
}

export interface SecretInput {
  key: string
  /** Null keeps the stored value: editing who may use a secret is not typing it again. */
  value: string | null
  hosts: string[]
  plugins: string[]
}

/** `ready`: usable by this plugin. `not-allowed`: stored, but this plugin is not on its list. */
export type SecretStatus = 'ready' | 'missing' | 'not-allowed'

/** Long enough for a key file; a value past this was pasted by mistake. */
const VALUE_MAX = 16 * 1024

/** Where a revealed value is going. */
export type SecretTarget = { kind: 'request'; url: URL } | { kind: 'program' }

export interface SecretStore {
  available(): boolean
  list(): SecretInfo[]
  /** Throws an `Error` whose message is the sentence the form shows. */
  save(input: SecretInput): SecretInfo[]
  remove(key: string): SecretInfo[]
  status(plugin: string, key: string): SecretStatus
  /**
   * The function that fills `{{key}}` for one plugin and one destination.
   * Every refusal is a `PluginCallError('secret')` naming the reason, which is
   * what the plugin's call rejects with.
   */
  revealer(plugin: string, declared: readonly string[], target: SecretTarget): Reveal
}

export function createSecretStore(options: { store: Store; crypto: SecretCrypto; onChange: () => void }): SecretStore {
  const { store, crypto } = options

  const list = (): SecretInfo[] =>
    readSecrets(store).map((row) => ({ key: row.key, hosts: row.hosts, plugins: row.plugins, updatedAt: row.updatedAt }))

  return {
    available: () => crypto.available(),
    list,

    save(input) {
      const key = input.key.trim()
      if (!SECRET_KEY_PATTERN.test(key)) {
        throw new Error('A key is letters, digits, dots, dashes and underscores, starting with a letter or digit.')
      }
      const hosts: string[] = []
      for (const host of input.hosts) {
        const pattern = parseOrigin(host)
        if (pattern === null) {
          throw new Error(`"${host}" is not an origin. Write it as https://api.example.com or https://*.example.com.`)
        }
        if (!hosts.includes(pattern.origin)) hosts.push(pattern.origin)
      }
      const plugins = [...new Set(input.plugins)]
      for (const plugin of plugins) {
        if (!ID_PATTERN.test(plugin)) throw new Error(`"${plugin}" is not a plugin id.`)
      }
      let value: Buffer | null = null
      if (input.value !== null) {
        if (input.value === '') throw new Error('A secret needs a value.')
        if (input.value.length > VALUE_MAX) throw new Error('That value is longer than a secret can be.')
        if (!crypto.available()) {
          throw new Error(
            'Helm cannot encrypt on this computer, so it will not store a secret. Nothing was saved.'
          )
        }
        value = crypto.encrypt(input.value)
      } else if (readSecret(store, key) === null) {
        throw new Error('A secret needs a value.')
      }
      writeSecret(store, { key, value, hosts, plugins })
      options.onChange()
      return list()
    },

    remove(key) {
      if (deleteSecret(store, key)) options.onChange()
      return list()
    },

    status(plugin, key) {
      const row = readSecret(store, key)
      if (row === null) return 'missing'
      return row.plugins.includes(plugin) ? 'ready' : 'not-allowed'
    },

    revealer(plugin, declared, target) {
      return (key) => {
        if (!declared.includes(key)) {
          throw new PluginCallError('secret', `{{${key}}} is not one of the secrets the manifest declares`)
        }
        const row = readSecret(store, key)
        if (row === null) {
          throw new PluginCallError('secret', `the secret "${key}" is not stored - add it in Settings > Secrets`)
        }
        if (!row.plugins.includes(plugin)) {
          throw new PluginCallError('secret', `the secret "${key}" is not allowed for this plugin`)
        }
        if (target.kind === 'request') {
          const allowed = row.hosts.some((host) => {
            const pattern = parseOrigin(host)
            return pattern !== null && originMatches(pattern, target.url)
          })
          if (!allowed) {
            throw new PluginCallError('secret', `the secret "${key}" may not be sent to ${target.url.origin}`)
          }
        }
        try {
          return crypto.decrypt(row.value)
        } catch {
          throw new PluginCallError('secret', `the secret "${key}" could not be decrypted on this computer`)
        }
      }
    }
  }
}
