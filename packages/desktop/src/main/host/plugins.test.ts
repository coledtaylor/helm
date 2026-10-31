import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginFolder } from '@helm/core'
import type { PluginInfo } from '../../shared/ipc'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { HostRequestError } from './client'
import type * as P from './protocol'
import { createHostPlugins } from './plugins'

const DIR = 'C:\\plugins\\my sample'

const hostPlugin = (patch: Partial<P.PluginInfo> = {}): P.PluginInfo => ({
  path: DIR,
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: null,
  enabled: true,
  error: null,
  warnings: [],
  revision: 1,
  icon: null,
  rail: { title: 'Sample', panel: 'main' },
  panels: { main: { title: 'Sample', url: 'helm-plugin://sample/dist/panel.html', actions: [] } },
  tabs: {},
  pageStrip: false,
  background: { url: 'helm-plugin://sample/dist/background.html', state: 'stopped', error: null },
  commands: [],
  settings: [{ type: 'text', key: 'greeting', label: 'Greeting' }],
  settingValues: { greeting: 'hello' },
  network: [],
  secrets: [],
  exec: [],
  service: null,
  runsPrograms: false,
  agent: null,
  startsSessions: false,
  seesSessions: false,
  status: null,
  badge: null,
  ...patch
})

const folder = (path: string, patch: Partial<PluginFolder> = {}): PluginFolder => ({
  path,
  enabled: true,
  toolsEnabled: true,
  addedAt: '2026-10-01T09:00:00.000Z',
  ...patch
})

interface Options {
  /** The host's plugins to begin with. */
  hosted?: P.PluginInfo[]
  /** Helm's own folders and setting values, by plugin id. */
  own?: PluginFolder[]
  ownSettings?: Record<string, Record<string, SettingValue>>
  copied?: boolean
}

/** The host side: a registry of folders answering the plugins:* requests as the host does. */
function world(options: Options = {}) {
  const connection = new FakeConnection()
  const hosted = [...(options.hosted ?? [])]
  const idOf = (path: string): string => path.split('\\').pop()!.replace(/\s+/g, '-')
  connection.answer('plugins:list', () => [...hosted])
  connection.answer('plugins:add', ({ path }) => {
    if (path.includes('broken')) return { path, error: 'There is no helm-plugin.json in that folder.', plugins: [...hosted] }
    hosted.push(hostPlugin({ path, id: idOf(path), name: idOf(path), settingValues: {} }))
    return { path, error: null, plugins: [...hosted] }
  })
  const at = (path: string): P.PluginInfo => hosted.find((plugin) => plugin.path === path)!
  connection.answer('plugins:setEnabled', ({ path, enabled }) => {
    Object.assign(at(path), { enabled })
    return [...hosted]
  })
  connection.answer('plugins:setTools', ({ path, enabled }) => {
    const plugin = at(path)
    plugin.agent = { enabled, server: `helm-plugin-${plugin.id ?? ''}`, instructions: null, tools: [] }
    return [...hosted]
  })
  connection.answer('plugins:setSetting', ({ plugin, key, value }) => {
    const target = hosted.find((each) => each.id === plugin)!
    if (key === 'gone') throw new HostRequestError('plugins:setSetting', 'failed', `${plugin} has no setting "gone".`)
    target.settingValues = { ...target.settingValues, [key]: value }
    return [...hosted]
  })
  const link = fakeLink(connection)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const logged: string[] = []
  const synced: boolean[] = []
  const marks: number[] = []
  let copied = options.copied ?? true
  const plugins = createHostPlugins({
    link,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    background: { sync: (needed) => synced.push(needed) },
    ownFolders: () => options.own ?? [],
    ownSettings: (id) => options.ownSettings?.[id] ?? {},
    copied: () => copied,
    markCopied: () => {
      copied = true
      marks.push(marks.length + 1)
    },
    log: (line) => logged.push(line)
  })
  const lists = (): PluginInfo[][] =>
    emitted.filter((each) => each.channel === 'plugins:changed').map((each) => each.payload as PluginInfo[])
  return { connection, hosted, link, plugins, emitted, lists, logged, synced, marks }
}

describe('plugins in the local host', () => {
  it('answers a list asked for before the first connect has finished with the host’s plugins, never an empty one', async () => {
    const w = world({ hosted: [hostPlugin()] })
    expect(w.link.current()).toBeNull()
    const listed = await w.plugins.list()
    expect(listed.map((plugin) => [plugin.id, plugin.settingValues])).toEqual([['sample', { greeting: 'hello' }]])
    expect(w.connection.subscriptions.has('plugins:changed')).toBe(true)
    expect(w.connection.subscriptions.has('secrets:changed')).toBe(true)
  })

  it('says why when the host cannot be reached, for the list, Settings’ reads and a page’s files alike', async () => {
    const sentence = 'Helm could not find the local host program at /nowhere/floti; turn it off.'
    const plugins = createHostPlugins({
      link: fakeLink(null, sentence),
      emit: () => undefined,
      background: { sync: () => undefined },
      ownFolders: () => [],
      ownSettings: () => ({}),
      copied: () => true,
      markCopied: () => undefined,
      log: () => undefined
    })
    await expect(plugins.list()).rejects.toThrow(sentence)
    await expect(plugins.secrets.list()).rejects.toThrow(sentence)
    await expect(plugins.serves('sample')).rejects.toThrow(sentence)
    await expect(plugins.file('sample', 'dist/panel.html')).rejects.toThrow(sentence)
  })

  it('hands each list the host sends to Helm’s pages, with the background page starting until the background host says it runs', async () => {
    const w = world({ hosted: [hostPlugin()] })
    await w.link.connect()
    w.connection.snapshot('plugins:changed', [hostPlugin()])

    expect(w.lists().at(-1)?.[0]?.background).toEqual({
      url: 'helm-plugin://sample/dist/background.html',
      state: 'starting',
      error: null
    })
    expect(w.synced.at(-1)).toBe(true)

    w.plugins.backgroundState('sample', 1, 'running', null)
    expect(w.lists().at(-1)?.[0]?.background?.state).toBe('running')
    // A report about a read the host has moved on from changes nothing.
    w.plugins.backgroundState('sample', 0, 'crashed', 'old')
    expect(w.lists().at(-1)?.[0]?.background?.state).toBe('running')

    // A new read starts the page again.
    w.connection.push('plugins:changed', [hostPlugin({ revision: 2 })])
    expect(w.lists().at(-1)?.[0]?.background?.state).toBe('starting')
    w.plugins.backgroundGone('crashed')
    expect(w.lists().at(-1)?.[0]?.background).toMatchObject({ state: 'crashed', error: 'the background host stopped (crashed)' })
    expect(w.synced.at(-1)).toBe(false)

    // Switched off, nothing needs the window.
    w.connection.push('plugins:changed', [hostPlugin({ revision: 3, enabled: false })])
    expect(w.synced.at(-1)).toBe(false)
  })

  it('stores a setting in the host and shows the host’s value back', async () => {
    const w = world({ hosted: [hostPlugin()] })
    const listed = await w.plugins.setSetting('sample', 'greeting', 'hi there')
    expect(w.connection.payloads('plugins:setSetting')).toEqual([{ plugin: 'sample', key: 'greeting', value: 'hi there' }])
    expect(listed[0]?.settingValues).toEqual({ greeting: 'hi there' })
    expect(w.lists().at(-1)?.[0]?.settingValues).toEqual({ greeting: 'hi there' })
  })

  it('sends Settings’ actions and secrets to the host, and names the host’s own log lines as Helm’s', async () => {
    const w = world({ hosted: [hostPlugin()] })
    w.connection.answer('plugins:log', () => [
      { at: '2026-10-30T09:00:00.000Z', stream: 'host', text: 'service started' },
      { at: '2026-10-30T09:00:01.000Z', stream: 'out', text: 'listening' }
    ])
    w.connection.answer('secrets:save', (input) => ({
      available: true,
      secrets: [{ key: input.key, hosts: input.hosts, plugins: input.plugins, updatedAt: '2026-10-30T09:00:00.000Z' }]
    }))
    expect((await w.plugins.log(DIR)).map((line) => line.stream)).toEqual(['helm', 'out'])
    expect((await w.plugins.secrets.save({ key: 'TOKEN', value: 'x', hosts: [], plugins: ['sample'] })).secrets).toHaveLength(1)
    await w.plugins.setEnabled(DIR, false)
    expect(w.connection.payloads('plugins:setEnabled')).toEqual([{ path: DIR, enabled: false }])
  })

  it('passes on the host’s refusal of an action, such as one that takes an admin device', async () => {
    const w = world({ hosted: [hostPlugin()] })
    w.connection.answer('plugins:remove', () => {
      throw new HostRequestError('plugins:remove', 'failed', 'Removing a plugin takes an admin device.')
    })
    await expect(w.plugins.remove(DIR, [])).rejects.toThrow('Removing a plugin takes an admin device.')
  })

  describe('page files', () => {
    const body = (text: string): Uint8Array => new TextEncoder().encode(text)

    it('serves a page’s files from the cache for the host’s current read, and asks again once the revision moves', async () => {
      const w = world({ hosted: [hostPlugin()] })
      let revision = 1
      w.connection.answer('plugins:file', ({ path }) => ({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        version: '1.0.0',
        revision,
        totalBytes: 9,
        body: body(`r${String(revision)} ${path.slice(0, 6)}`)
      }))
      await w.link.connect()
      w.connection.snapshot('plugins:changed', [hostPlugin()])

      const first = await w.plugins.file('sample', 'dist/panel.html')
      const again = await w.plugins.file('sample', 'dist/panel.html')
      expect(new TextDecoder().decode(again.body)).toBe(new TextDecoder().decode(first.body))
      expect(w.connection.payloads('plugins:file')).toEqual([{ plugin: 'sample', path: 'dist/panel.html', offset: 0 }])

      // The folder was edited: the host read it again.
      revision = 2
      w.connection.push('plugins:changed', [hostPlugin({ revision: 2 })])
      const fresh = await w.plugins.file('sample', 'dist/panel.html')
      expect(new TextDecoder().decode(fresh.body)).toBe('r2 dist/p')
      expect(w.connection.payloads('plugins:file')).toHaveLength(2)
      await w.plugins.file('sample', 'dist/panel.html')
      expect(w.connection.payloads('plugins:file')).toHaveLength(2)
    })

    it('reads a large file a piece at a time, and keeps no refusal', async () => {
      const w = world({ hosted: [hostPlugin()] })
      const whole = 'abcdefghij'
      w.connection.answer('plugins:file', ({ path, offset }) =>
        path === 'big.js'
          ? { status: 200, contentType: 'text/javascript', version: '1.0.0', revision: 1, totalBytes: 10, body: body(whole.slice(offset, offset + 4)) }
          : { status: 404, contentType: 'text/plain', version: '1.0.0', revision: 1, totalBytes: 9, body: body('Not found') }
      )
      await w.link.connect()
      w.connection.snapshot('plugins:changed', [hostPlugin()])

      const big = await w.plugins.file('sample', 'big.js')
      expect(new TextDecoder().decode(big.body)).toBe(whole)
      expect(w.connection.payloads('plugins:file').map((each) => (each as { offset: number }).offset)).toEqual([0, 4, 8])

      expect((await w.plugins.file('sample', 'gone.js')).status).toBe(404)
      expect((await w.plugins.file('sample', 'gone.js')).status).toBe(404)
      expect(w.connection.payloads('plugins:file').filter((each) => (each as { path: string }).path === 'gone.js')).toHaveLength(2)
    })

    it('serves the runtime only for a plugin the host has on', async () => {
      const w = world({ hosted: [hostPlugin(), hostPlugin({ path: 'C:\\plugins\\off', id: 'off', enabled: false })] })
      expect(await w.plugins.serves('sample')).toBe(true)
      expect(await w.plugins.serves('off')).toBe(false)
      expect(await w.plugins.serves('nobody')).toBe(false)
    })
  })

  describe('Helm’s own plugins, copied in on the first connect', () => {
    it('copies each folder with its switches and setting values, skipping one the host has and never a secret', async () => {
      const w = world({
        copied: false,
        hosted: [hostPlugin({ path: 'C:\\plugins\\had', id: 'had' })],
        own: [
          folder('C:\\plugins\\had', { enabled: false }),
          folder('C:\\plugins\\notes'),
          folder('C:\\plugins\\quiet', { enabled: false }),
          folder('C:\\plugins\\no tools', { toolsEnabled: false }),
          folder('C:\\plugins\\broken')
        ],
        ownSettings: { notes: { greeting: 'hey', count: 3 }, quiet: { gone: true } }
      })
      await w.link.connect()

      expect(w.connection.payloads('plugins:add')).toEqual([
        { path: 'C:\\plugins\\notes' },
        { path: 'C:\\plugins\\quiet' },
        { path: 'C:\\plugins\\no tools' },
        { path: 'C:\\plugins\\broken' }
      ])
      expect(w.connection.payloads('plugins:setSetting')).toEqual([
        { plugin: 'notes', key: 'greeting', value: 'hey' },
        { plugin: 'notes', key: 'count', value: 3 },
        { plugin: 'quiet', key: 'gone', value: true }
      ])
      expect(w.connection.payloads('plugins:setTools')).toEqual([{ path: 'C:\\plugins\\no tools', enabled: false }])
      expect(w.connection.payloads('plugins:setEnabled')).toEqual([{ path: 'C:\\plugins\\quiet', enabled: false }])
      expect(w.connection.payloads('secrets:save')).toEqual([])
      expect(w.hosted.map((plugin) => [plugin.path, plugin.enabled, plugin.agent?.enabled ?? null, plugin.settingValues])).toEqual([
        ['C:\\plugins\\had', true, null, { greeting: 'hello' }],
        ['C:\\plugins\\notes', true, null, { greeting: 'hey', count: 3 }],
        ['C:\\plugins\\quiet', false, null, {}],
        ['C:\\plugins\\no tools', true, false, {}]
      ])
      expect(w.logged).toEqual([
        'host: the setting “gone” of C:\\plugins\\quiet was not copied into the local host (quiet has no setting "gone".)',
        'host: the plugin folder C:\\plugins\\broken was not copied into the local host (There is no helm-plugin.json in that folder.)'
      ])
      expect(w.marks).toEqual([1])
    })

    it('copies nothing on a later start, so a plugin removed in the host stays removed', async () => {
      const w = world({ copied: true, own: [folder('C:\\plugins\\notes')] })
      await w.link.connect()
      expect(w.connection.payloads('plugins:add')).toEqual([])
      expect(w.marks).toEqual([])
    })

    it('is not recorded as done when the host stops answering partway, so the next start finishes it', async () => {
      const w = world({ copied: false, own: [folder('C:\\plugins\\notes')] })
      w.connection.answer('plugins:add', () => {
        throw new HostRequestError('plugins:add', 'unavailable', 'The connection to the local host was closed.')
      })
      await w.link.connect()
      expect(w.marks).toEqual([])
      expect(w.logged).toEqual([
        "host: Helm's plugins were not copied into the local host (The connection to the local host was closed.)"
      ])
    })
  })
})
