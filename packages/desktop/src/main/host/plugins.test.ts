import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginFolder } from '@helm/core'
import type { PluginBackgroundReport } from '../../shared/ipc'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { HostRequestError } from './client'
import type * as P from './protocol'
import { createHostPlugins, NOT_OFFERING, type HostPluginsDeps } from './plugins'

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
  const told: PluginBackgroundReport[][] = []
  const logged: string[] = []
  const synced: boolean[] = []
  const marks: number[] = []
  const toolRuns: Array<{ request: ToolCallRequest; signal: AbortSignal; answer: (answer: ToolAnswer) => void }> = []
  const toolRunMade: Array<() => void> = []
  let toolsChanged = 0
  let copied = options.copied ?? true
  const plugins = createHostPlugins({
    ...quietDeps(link),
    reportsChanged: (reports) => told.push(reports),
    runTool: (request, signal) =>
      new Promise<ToolAnswer>((resolve) => {
        toolRuns.push({ request, signal, answer: resolve })
        toolRunMade.shift()?.()
      }),
    onToolsChanged: () => {
      toolsChanged += 1
    },
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
  return {
    connection,
    hosted,
    link,
    plugins,
    told,
    logged,
    synced,
    marks,
    toolRuns,
    /** Resolves once the next tool call reaches the background page. */
    nextToolRun: () => new Promise<void>((resolve) => toolRunMade.push(resolve)),
    toolsChanged: () => toolsChanged
  }
}

/** Deps that do nothing, for a test that looks at one thing. */
function quietDeps(link: HostPluginsDeps['link']): HostPluginsDeps {
  return {
    link,
    reportsChanged: () => undefined,
    runTool: () => Promise.resolve({ ok: true, text: 'Done.' }),
    onToolsChanged: () => undefined,
    background: { sync: () => undefined },
    ownFolders: () => [],
    ownSettings: () => ({}),
    copied: () => true,
    markCopied: () => undefined,
    log: () => undefined
  }
}

describe('plugins in the local host', () => {
  it('says why when the host cannot be reached, for a page’s files', async () => {
    const sentence = 'Helm could not find the local host program at /nowhere/floti; turn it off.'
    const plugins = createHostPlugins(quietDeps(fakeLink(null, sentence)))
    await expect(plugins.serves('sample')).rejects.toThrow(sentence)
    await expect(plugins.file('sample', 'dist/panel.html')).rejects.toThrow(sentence)
  })

  it('tells the window what the hidden window reports of each background page, and opens the hidden window while one needs it', async () => {
    const w = world({ hosted: [hostPlugin()] })
    await w.link.connect()
    w.connection.snapshot('plugins:changed', [hostPlugin()])
    expect(w.connection.subscriptions.has('plugins:changed')).toBe(true)
    // Main hears only the list: the window and the hidden window hear the rest themselves.
    expect([...w.connection.subscriptions.keys()]).toEqual(['plugins:changed'])
    expect(w.synced.at(-1)).toBe(true)
    expect(w.plugins.reports()).toEqual([])

    w.plugins.backgroundState('sample', 1, 'running', null)
    expect(w.told.at(-1)).toEqual([{ plugin: 'sample', revision: 1, state: 'running', error: null }])
    // A report about a read the host has moved on from changes nothing.
    w.plugins.backgroundState('sample', 0, 'crashed', 'old')
    expect(w.plugins.reports()).toEqual([{ plugin: 'sample', revision: 1, state: 'running', error: null }])

    // A new read starts the page again, and the old report goes.
    w.connection.push('plugins:changed', [hostPlugin({ revision: 2 })])
    expect(w.plugins.reports()).toEqual([])
    expect(w.told.at(-1)).toEqual([])
    w.plugins.backgroundGone('crashed')
    expect(w.told.at(-1)).toEqual([
      { plugin: 'sample', revision: 2, state: 'crashed', error: 'the background host stopped (crashed)' }
    ])
    expect(w.synced.at(-1)).toBe(false)

    // Switched off, nothing needs the window.
    w.connection.push('plugins:changed', [hostPlugin({ revision: 3, enabled: false })])
    expect(w.synced.at(-1)).toBe(false)
  })

  it('keeps a report the hidden window made for a read main’s list has not caught up with', async () => {
    const w = world({ hosted: [hostPlugin()] })
    await w.link.connect()
    w.connection.snapshot('plugins:changed', [hostPlugin()])
    w.plugins.backgroundState('sample', 2, 'running', null)
    w.connection.push('plugins:changed', [hostPlugin({ revision: 2 })])
    expect(w.plugins.reports()).toEqual([{ plugin: 'sample', revision: 2, state: 'running', error: null }])
  })

  describe('a page’s calls', () => {
    const TOOLS: P.PluginAgentInfo = {
      enabled: true,
      server: 'helm-plugin-sample',
      instructions: 'Find before you write.',
      tools: [
        { name: 'find', description: 'Finds things.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, readOnly: true },
        { name: 'write', description: 'Writes a thing.', inputSchema: { type: 'object', properties: {} }, readOnly: false }
      ]
    }

    it('offers the tools the host lists, and offers again only when they move', async () => {
      const w = world({ hosted: [hostPlugin({ agent: TOOLS })] })
      await w.link.connect()
      w.connection.snapshot('plugins:changed', [hostPlugin({ agent: TOOLS })])
      expect(w.plugins.toolServers()).toEqual([
        {
          plugin: 'sample',
          name: 'Sample',
          server: 'helm-plugin-sample',
          instructions: 'Find before you write.',
          tools: [
            { name: 'find', description: 'Finds things.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, readOnly: true },
            { name: 'write', description: 'Writes a thing.', inputSchema: { type: 'object', properties: {} }, readOnly: false }
          ]
        }
      ])
      const offers = w.toolsChanged()
      w.connection.push('plugins:changed', [hostPlugin({ agent: TOOLS })])
      expect(w.toolsChanged()).toBe(offers)
      w.connection.push('plugins:changed', [hostPlugin({ agent: { ...TOOLS, enabled: false } })])
      expect(w.plugins.toolServers()).toEqual([])
      expect(w.toolsChanged()).toBe(offers + 1)
    })

    it('answers a tool call with the background page once it runs, and ends it when the plugin’s tools are switched off', async () => {
      const w = world({ hosted: [hostPlugin({ agent: TOOLS })] })
      await w.link.connect()
      w.connection.snapshot('plugins:changed', [hostPlugin({ agent: TOOLS })])
      const session = { id: 'minted', name: 'alpha', cwd: 'C:\\work' }
      const request = { plugin: 'sample', tool: 'find', args: { q: 'x' }, session }

      // Starting: the call waits for the page.
      const ran = w.nextToolRun()
      const answered = w.plugins.callTool(request, new AbortController().signal)
      w.plugins.backgroundState('sample', 1, 'running', null)
      await ran
      expect(w.toolRuns[0]?.request).toEqual(request)
      w.toolRuns[0]?.answer({ ok: true, text: 'found 1' })
      expect(await answered).toEqual({ ok: true, text: 'found 1' })

      expect(await w.plugins.callTool({ ...request, tool: 'nope' }, new AbortController().signal)).toEqual({
        ok: false,
        message: 'Sample has no tool called "nope". It has: find, write.'
      })

      const second = w.nextToolRun()
      const pending = w.plugins.callTool(request, new AbortController().signal)
      await second
      const run = w.toolRuns[1]!
      w.connection.push('plugins:changed', [hostPlugin({ agent: { ...TOOLS, enabled: false } })])
      expect(run.signal.aborted).toBe(true)
      run.answer({ ok: false, message: 'The call was cancelled.' })
      expect(await pending).toEqual({ ok: false, message: NOT_OFFERING })
      expect(await w.plugins.callTool(request, new AbortController().signal)).toEqual({ ok: false, message: NOT_OFFERING })
    })
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
