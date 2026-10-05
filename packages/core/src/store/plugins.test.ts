import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from './db'
import {
  addPluginFolder,
  forgetPluginSettings,
  readPluginFolders,
  readPluginSettings,
  removePluginFolder,
  setPluginEnabled,
  writePluginSetting
} from './plugins'
import { deleteSecret, readSecret, readSecrets, writeSecret } from './secrets'

let store: Store

beforeEach(() => {
  store = openStore({ file: ':memory:' })
})

afterEach(() => {
  store.close()
})

describe('plugin folders', () => {
  it('are listed in the order they were added, enabled', () => {
    addPluginFolder(store, 'C:\\plugins\\b')
    addPluginFolder(store, 'C:\\plugins\\a')
    expect(readPluginFolders(store).map((folder) => [folder.path, folder.enabled])).toEqual([
      ['C:\\plugins\\b', true],
      ['C:\\plugins\\a', true]
    ])
  })

  it('are one folder whatever the case of its path, and keep the spelling first given', () => {
    const first = addPluginFolder(store, 'C:\\Plugins\\Factory')
    const again = addPluginFolder(store, 'c:\\plugins\\factory')
    expect(again).toEqual(first)
    expect(readPluginFolders(store)).toHaveLength(1)
  })

  it('are switched off and removed by any spelling of their path', () => {
    addPluginFolder(store, 'C:\\Plugins\\Factory')
    setPluginEnabled(store, 'c:\\plugins\\factory', false)
    expect(readPluginFolders(store)[0]!.enabled).toBe(false)
    removePluginFolder(store, 'C:\\PLUGINS\\FACTORY')
    expect(readPluginFolders(store)).toEqual([])
  })
})

describe('plugin settings', () => {
  it('keep what the user set per plugin id, and null goes back to the default', () => {
    writePluginSetting(store, 'factory', 'baseUrl', 'https://factory.example')
    writePluginSetting(store, 'factory', 'interval', 30)
    writePluginSetting(store, 'factory', 'live', false)
    writePluginSetting(store, 'other', 'baseUrl', 'https://elsewhere.example')
    writePluginSetting(store, 'factory', 'interval', 60)
    expect(readPluginSettings(store, 'factory')).toEqual({
      baseUrl: 'https://factory.example',
      interval: 60,
      live: false
    })

    writePluginSetting(store, 'factory', 'live', null)
    expect(readPluginSettings(store, 'factory')).toEqual({ baseUrl: 'https://factory.example', interval: 60 })

    forgetPluginSettings(store, 'factory')
    expect(readPluginSettings(store, 'factory')).toEqual({})
    expect(readPluginSettings(store, 'other')).toEqual({ baseUrl: 'https://elsewhere.example' })
  })
})

describe('secrets', () => {
  const cipher = (text: string): Buffer => Buffer.from(`enc:${text}`)

  it('store ciphertext with who may use it, and change the permissions without the value', () => {
    writeSecret(store, {
      key: 'factory.token',
      value: cipher('t1'),
      hosts: ['https://factory.example'],
      plugins: ['factory']
    })
    writeSecret(store, {
      key: 'factory.token',
      value: null,
      hosts: ['https://*.factory.example'],
      plugins: ['factory', 'b']
    })
    const row = readSecret(store, 'factory.token')
    expect(row?.value.toString()).toBe('enc:t1')
    expect(row?.hosts).toEqual(['https://*.factory.example'])
    expect(row?.plugins).toEqual(['factory', 'b'])

    writeSecret(store, { key: 'factory.token', value: cipher('t2'), hosts: [], plugins: [] })
    expect(readSecret(store, 'factory.token')?.value.toString()).toBe('enc:t2')
  })

  it('refuses a new key with no value', () => {
    expect(() => writeSecret(store, { key: 'nothing', value: null, hosts: [], plugins: [] })).toThrow('has no value')
    expect(readSecrets(store)).toEqual([])
  })

  it('are deleted by key, and say whether there was one', () => {
    writeSecret(store, { key: 'a', value: cipher('x'), hosts: [], plugins: [] })
    expect(deleteSecret(store, 'a')).toBe(true)
    expect(deleteSecret(store, 'a')).toBe(false)
    expect(readSecret(store, 'a')).toBeNull()
  })
})
