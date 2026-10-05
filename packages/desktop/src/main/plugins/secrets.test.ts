import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, readSecret, type Store } from '@helm/core'
import type { SecretCrypto, SecretStore } from './secrets'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { createSecretStore } = await import('./secrets')
const { PluginCallError } = await import('./errors')

/**
 * The secret store: values go in encrypted and only encrypted, the user's two
 * lists (hosts and plugins) are held to on the way out, and every refusal is a
 * `secret` error naming the reason.
 */

/** Reversible and visibly not plaintext, so a test can tell a stored value was encrypted. */
const fakeCrypto: SecretCrypto = {
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${Buffer.from(text, 'utf8').toString('base64')}`),
  decrypt: (data) => {
    const raw = data.toString('utf8')
    if (!raw.startsWith('enc:')) throw new Error('not ours')
    return Buffer.from(raw.slice(4), 'base64').toString('utf8')
  }
}

const noCrypto: SecretCrypto = {
  available: () => false,
  encrypt: () => {
    throw new Error('encryption is not available')
  },
  decrypt: () => {
    throw new Error('encryption is not available')
  }
}

let store: Store
let changes: number
let secrets: SecretStore

beforeEach(() => {
  store = openStore({ file: ':memory:' })
  changes = 0
  secrets = createSecretStore({ store, crypto: fakeCrypto, onChange: () => (changes += 1) })
})

afterEach(() => {
  store.close()
})

const request = (url: string): { kind: 'request'; url: URL } => ({ kind: 'request', url: new URL(url) })

function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PluginCallError)
    return { code: (error as InstanceType<typeof PluginCallError>).code, message: (error as Error).message }
  }
  throw new Error('expected a refusal')
}

describe('save', () => {
  it('stores the value encrypted, with its hosts in canonical form, and says so', () => {
    const listed = secrets.save({
      key: 'gh-token',
      value: 'ghp_secret',
      hosts: ['https://API.github.com/', 'https://api.github.com', 'https://*.example.com'],
      plugins: ['sample', 'sample']
    })
    expect(listed).toEqual([
      expect.objectContaining({ key: 'gh-token', hosts: ['https://api.github.com', 'https://*.example.com'], plugins: ['sample'] })
    ])
    expect(listed[0]).not.toHaveProperty('value')
    const row = readSecret(store, 'gh-token')
    expect(row?.value.toString('utf8')).not.toContain('ghp_secret')
    expect(fakeCrypto.decrypt(row!.value)).toBe('ghp_secret')
    expect(changes).toBe(1)
  })

  it('refuses to store anything when this computer cannot encrypt', () => {
    const plain = createSecretStore({ store, crypto: noCrypto, onChange: () => (changes += 1) })
    expect(plain.available()).toBe(false)
    expect(() => plain.save({ key: 'k', value: 'v', hosts: [], plugins: ['sample'] })).toThrow(/cannot encrypt/)
    expect(plain.list()).toEqual([])
    expect(changes).toBe(0)
  })

  it.each([
    [{ key: 'bad key', value: 'v', hosts: [], plugins: [] }, /A key is letters/],
    [{ key: 'k', value: 'v', hosts: ['api.example.com'], plugins: [] }, /"api.example.com" is not an origin/],
    [{ key: 'k', value: 'v', hosts: ['https://example.com/path'], plugins: [] }, /is not an origin/],
    [{ key: 'k', value: 'v', hosts: [], plugins: ['Not An Id'] }, /is not a plugin id/],
    [{ key: 'k', value: '', hosts: [], plugins: [] }, /needs a value/],
    [{ key: 'k', value: null, hosts: [], plugins: [] }, /needs a value/],
    [{ key: 'k', value: 'x'.repeat(16 * 1024 + 1), hosts: [], plugins: [] }, /longer than a secret can be/]
  ])('refuses %j', (input, message) => {
    expect(() => secrets.save(input)).toThrow(message)
    expect(secrets.list()).toEqual([])
  })

  it('keeps the stored value when only who may use it changes', () => {
    secrets.save({ key: 'k', value: 'original', hosts: ['https://a.example.com'], plugins: ['sample'] })
    secrets.save({ key: 'k', value: null, hosts: ['https://b.example.com'], plugins: ['sample', 'other'] })
    expect(secrets.list()[0]).toMatchObject({ hosts: ['https://b.example.com'], plugins: ['sample', 'other'] })
    expect(secrets.revealer('other', ['k'], request('https://b.example.com/x'))('k')).toBe('original')
  })

  it('removes, and says so only when there was something to remove', () => {
    secrets.save({ key: 'k', value: 'v', hosts: [], plugins: ['sample'] })
    expect(secrets.remove('k')).toEqual([])
    expect(changes).toBe(2)
    secrets.remove('k')
    expect(changes).toBe(2)
  })
})

describe('status', () => {
  it('is missing, not-allowed or ready for the plugin asking', () => {
    expect(secrets.status('sample', 'k')).toBe('missing')
    secrets.save({ key: 'k', value: 'v', hosts: [], plugins: ['other'] })
    expect(secrets.status('sample', 'k')).toBe('not-allowed')
    expect(secrets.status('other', 'k')).toBe('ready')
  })
})

describe('revealer', () => {
  beforeEach(() => {
    secrets.save({ key: 'token', value: 's3cret', hosts: ['https://api.example.com', 'https://*.example.org'], plugins: ['sample'] })
  })

  it('gives the value to the plugin it was stored for, for a host it was allowed', () => {
    expect(secrets.revealer('sample', ['token'], request('https://api.example.com/v1'))('token')).toBe('s3cret')
    expect(secrets.revealer('sample', ['token'], request('https://deep.sub.example.org/'))('token')).toBe('s3cret')
  })

  it('refuses a key the manifest does not declare, even one that is stored', () => {
    expect(refusal(() => secrets.revealer('sample', [], request('https://api.example.com/'))('token'))).toEqual({
      code: 'secret',
      message: '{{token}} is not one of the secrets the manifest declares'
    })
  })

  it('refuses a key that is not stored', () => {
    expect(refusal(() => secrets.revealer('sample', ['other'], request('https://api.example.com/'))('other')).message).toMatch(
      /is not stored/
    )
  })

  it('refuses another plugin', () => {
    expect(refusal(() => secrets.revealer('other', ['token'], request('https://api.example.com/'))('token')).message).toMatch(
      /not allowed for this plugin/
    )
  })

  it.each(['https://evil.example.com/', 'http://api.example.com/', 'https://api.example.com:8443/', 'https://example.org/'])(
    'refuses %s, which the user did not allow',
    (url) => {
      expect(refusal(() => secrets.revealer('sample', ['token'], request(url))('token')).message).toMatch(/may not be sent to/)
    }
  )

  it('gives a program the value with no host to check', () => {
    expect(secrets.revealer('sample', ['token'], { kind: 'program' })('token')).toBe('s3cret')
  })

  it('says so when a stored value cannot be decrypted on this computer', () => {
    const elsewhere = createSecretStore({ store, crypto: noCrypto, onChange: () => undefined })
    expect(refusal(() => elsewhere.revealer('sample', ['token'], { kind: 'program' })('token')).message).toMatch(
      /could not be decrypted/
    )
  })
})
