import { describe, expect, it } from 'vitest'
import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginFolder, SessionRecord } from '@helm/core'
import type { PluginCallRequest, PluginInfo } from '../../shared/ipc'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { HostRequestError } from './client'
import type * as P from './protocol'
import { createHostPlugins, NOT_OFFERING, type HostPluginsDeps } from './plugins'
import { sessionFromHost } from './records'

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
  const toWindow: Array<{ channel: string; payload: unknown }> = []
  const toBackground: Array<{ channel: string; payload: unknown }> = []
  const logged: string[] = []
  const synced: boolean[] = []
  const marks: number[] = []
  const adopted: SessionRecord[] = []
  const toolRuns: Array<{ request: ToolCallRequest; signal: AbortSignal; answer: (answer: ToolAnswer) => void }> = []
  const toolRunMade: Array<() => void> = []
  let toolsChanged = 0
  let copied = options.copied ?? true
  const plugins = createHostPlugins({
    ...quietDeps(link),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    emitWindow: (channel, payload) => toWindow.push({ channel, payload }),
    emitBackground: (channel, payload) => toBackground.push({ channel, payload }),
    isWindow: (sender) => sender === WINDOW,
    adoptSession: (row) => {
      const record = sessionFromHost(row)
      adopted.push(record)
      return record
    },
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
  const lists = (): PluginInfo[][] =>
    emitted.filter((each) => each.channel === 'plugins:changed').map((each) => each.payload as PluginInfo[])
  return {
    connection,
    hosted,
    link,
    plugins,
    emitted,
    toWindow,
    toBackground,
    lists,
    logged,
    synced,
    marks,
    adopted,
    toolRuns,
    /** Resolves once the next tool call reaches the background page. */
    nextToolRun: () => new Promise<void>((resolve) => toolRunMade.push(resolve)),
    toolsChanged: () => toolsChanged
  }
}

/** The window's web contents id, and the background host's. */
const WINDOW = 1
const BACKGROUND = 2

/** Deps that do nothing, for a test that looks at one thing. */
function quietDeps(link: HostPluginsDeps['link']): HostPluginsDeps {
  return {
    link,
    emit: () => undefined,
    emitWindow: () => undefined,
    emitBackground: () => undefined,
    isWindow: () => true,
    adoptSession: (row) => sessionFromHost(row),
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

const pageCall = (method: string, args: unknown[] = [], patch: Partial<PluginCallRequest> = {}): PluginCallRequest => ({
  plugin: 'sample',
  surface: 'panel',
  method,
  args,
  callId: '1.1.7',
  ...patch
})

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
    const plugins = createHostPlugins(quietDeps(fakeLink(null, sentence)))
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

    it('sends fetch, exec, settings, secrets, sessions, status and a channel post to the host, named by the page that made it', async () => {
      const w = world({ hosted: [hostPlugin()] })
      w.connection.answer('plugins:call', ({ method }) => ({ ok: true, value: method === 'settings.get' ? { greeting: 'hi' } : null }))
      const methods = ['fetch', 'exec', 'settings.get', 'secrets.state', 'secrets.request', 'sessions.list', 'sessions.start', 'status.set', 'badge.set', 'channel.post']
      for (const method of methods) await w.plugins.call(pageCall(method, ['x']), WINDOW)
      expect(await w.plugins.call(pageCall('settings.get'), BACKGROUND)).toEqual({ ok: true, value: { greeting: 'hi' } })

      const sent = w.connection.payloads('plugins:call') as P.PluginCallRequest[]
      expect(sent.map((each) => each.method)).toEqual([...methods, 'settings.get'])
      expect(sent[0]).toEqual({ plugin: 'sample', surface: 'panel', method: 'fetch', args: ['x'], callId: '1/1.1.7' })
      // Two Helm pages relaying calls under the same id are told apart.
      expect(sent.at(-1)?.callId).toBe('2/1.1.7')
    })

    it('passes on what the host answered, a refusal included', async () => {
      const w = world({ hosted: [hostPlugin()] })
      w.connection.answer('plugins:call', () => ({ ok: false, code: 'not-declared', message: '"rm" is not one of the programs the manifest\'s exec lists' }))
      expect(await w.plugins.call(pageCall('exec', ['rm', []]), WINDOW)).toEqual({
        ok: false,
        code: 'not-declared',
        message: '"rm" is not one of the programs the manifest\'s exec lists'
      })
    })

    it('opens one of the plugin’s tabs, and a link from a click, here without asking the host, with today’s checks', async () => {
      const w = world({ hosted: [hostPlugin({ tabs: { item: { title: 'Item', url: 'helm-plugin://sample/dist/item.html' } } })] })
      await w.link.connect()
      w.connection.snapshot('plugins:changed', [...w.hosted])
      const before = w.connection.sent.length

      expect(await w.plugins.call(pageCall('tabs.open', ['item', { id: 7 }, { title: 'Seven', preview: true }]), WINDOW)).toEqual({
        ok: true,
        value: undefined
      })
      expect(await w.plugins.call(pageCall('tabs.open', ['nope']), WINDOW)).toMatchObject({ ok: false, code: 'not-declared' })
      expect(await w.plugins.call(pageCall('open', ['https://example.com/a']), WINDOW)).toEqual({ ok: true, value: undefined })
      expect(await w.plugins.call(pageCall('open', ['http://example.com/']), WINDOW)).toMatchObject({ ok: false, code: 'invalid' })
      expect(await w.plugins.call(pageCall('open', ['https://example.com/b'], { surface: 'background' }), BACKGROUND)).toMatchObject({
        ok: false,
        code: 'not-allowed'
      })
      // One link a second, as today: a double click is one page.
      expect(await w.plugins.call(pageCall('open', ['https://example.com/c']), WINDOW)).toMatchObject({ ok: false, code: 'busy' })

      expect(w.toWindow).toEqual([
        { channel: 'plugins:ui', payload: { kind: 'openTab', plugin: 'sample', tab: 'item', params: { id: 7 }, title: 'Seven', preview: true } },
        { channel: 'plugins:ui', payload: { kind: 'link', plugin: 'sample', url: 'https://example.com/a' } }
      ])
      expect(w.connection.sent.slice(before)).toEqual([])
    })

    it('fails a call in the page with the sentence when the local host cannot be reached, and says nothing in Helm’s chrome', async () => {
      const sentence = 'Helm could not reach the local host: it stopped answering.'
      const emitted: string[] = []
      const plugins = createHostPlugins({
        ...quietDeps(fakeLink(null, sentence)),
        emit: (channel) => emitted.push(channel),
        emitWindow: (channel) => emitted.push(channel),
        emitBackground: (channel) => emitted.push(channel)
      })
      for (const method of ['fetch', 'exec', 'settings.get', 'secrets.request', 'sessions.start', 'status.set']) {
        expect(await plugins.call(pageCall(method), WINDOW)).toEqual({ ok: false, code: 'unavailable', message: sentence })
      }
      // A tab or a link needs the host's list to know the plugin; it cannot be had either.
      expect(await plugins.call(pageCall('tabs.open', ['item']), WINDOW)).toEqual({ ok: false, code: 'unavailable', message: sentence })
      expect(emitted).toEqual([])
    })

    it('forwards a cancel, a command, a closed secret dialog and the user’s answer to a session', async () => {
      const w = world({ hosted: [hostPlugin()] })
      const row: P.SessionRecord = {
        id: 31,
        name: 'triage',
        label: null,
        cwd: 'C:\\work\\my app',
        branch: null,
        projectPath: null,
        profileId: null,
        argv: ['claude', '-n', 'triage', 'Look at the failing build'],
        conversationId: null,
        backend: 'claude-code',
        status: 'running',
        startedAt: '2026-10-30T09:00:00.000Z',
        endedAt: null,
        durationMs: null,
        exitCode: null
      }
      w.connection.answer('plugins:session', ({ start }) => (start ? row : null))
      await w.link.connect()

      w.plugins.cancel('1.1.7', WINDOW)
      await w.plugins.command('sample', 'refresh')
      w.plugins.answer('secret-1')
      const started = await w.plugins.session({ requestId: 'ask-1', start: true, cols: 120, rows: 30 }, WINDOW)
      expect(await w.plugins.session({ requestId: 'ask-2', start: false, cols: 120, rows: 30 }, WINDOW)).toBeNull()
      await expect(w.plugins.session({ requestId: 'ask-3', start: true, cols: 1, rows: 1 }, BACKGROUND)).rejects.toThrow(
        'Only the window that asked can answer for a session.'
      )
      await new Promise<void>((resolve) => setImmediate(resolve))

      expect(w.connection.payloads('plugins:cancel')).toEqual([{ callId: '1/1.1.7' }])
      expect(w.connection.payloads('plugins:command')).toEqual([{ plugin: 'sample', id: 'refresh' }])
      expect(w.connection.payloads('plugins:answer')).toEqual([{ requestId: 'secret-1' }])
      expect(w.connection.payloads('plugins:session')).toEqual([
        { requestId: 'ask-1', start: true, cols: 120, rows: 30 },
        { requestId: 'ask-2', start: false, cols: 120, rows: 30 }
      ])
      // The session the host started is adopted, so the window opens its tab.
      expect(w.adopted.map((record) => record.id)).toEqual([31])
      expect(started?.id).toBe(31)
    })

    it('hands the window what the host asks of it, and each delivery to the pages it is for', async () => {
      const w = world({ hosted: [hostPlugin()] })
      await w.link.connect()
      w.connection.push('plugins:ui', { kind: 'secret', requestId: 'r1', plugin: 'sample', key: 'token', hosts: ['https://api.example.com'] })
      w.connection.push('plugins:deliver', { event: 'settings', plugin: 'sample', data: { greeting: 'hey' }, to: 'all' })
      w.connection.push('plugins:deliver', { event: 'command', plugin: 'sample', data: { id: 'refresh' }, to: 'background' })
      w.connection.push('plugins:deliver', {
        event: 'channel',
        plugin: 'sample',
        data: { name: 'sample-items', message: { changed: 3 }, token: 'tab-1' },
        to: 'all'
      })

      expect(w.toWindow).toEqual([
        { channel: 'plugins:ui', payload: { kind: 'secret', requestId: 'r1', plugin: 'sample', key: 'token', hosts: ['https://api.example.com'] } }
      ])
      expect(w.emitted.filter((each) => each.channel === 'plugins:deliver').map((each) => each.payload)).toEqual([
        { plugin: 'sample', event: 'settings', data: { greeting: 'hey' }, to: 'all' },
        { plugin: 'sample', event: 'channel', data: { name: 'sample-items', message: { changed: 3 }, token: 'tab-1' }, to: 'all' }
      ])
      expect(w.toBackground).toEqual([
        { channel: 'plugins:deliver', payload: { plugin: 'sample', event: 'command', data: { id: 'refresh' }, to: 'background' } }
      ])
    })

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
