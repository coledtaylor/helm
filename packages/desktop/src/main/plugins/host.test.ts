import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { addPluginFolder, openStore, readPluginFolders, readSecrets, setPluginEnabled, type Store } from '@helm/core'
import type { HelmTheme } from '@coledtaylor/helm-plugin-sdk'
import type { PluginCallOutcome, PluginInfo, PluginToolCall } from '../../shared/ipc'
import type { PluginHost, PluginHostOptions, PluginSessionLaunch } from './host'
import type { BackgroundHost } from './background'
import type { SendHop } from './net'
import type { ServiceLauncher } from './service'

vi.mock('electron', async () => ({
  ...(await import('../../../test/electron')).electronFake(),
  app: {
    ...((await import('../../../test/electron')).electronFake()['app'] as object),
    getAppMetrics: () => [
      { pid: 4100, memory: { workingSetSize: 50_000 }, cpu: { percentCPUUsage: 1.5 } },
      { pid: 4200, memory: { workingSetSize: 20_000 }, cpu: { percentCPUUsage: 0.5 } }
    ]
  }
}))

const { createPluginHost } = await import('./host')

/**
 * The plugin host: the registered folders and what each is, and every bridge
 * call held to its plugin's manifest. Electron's parts are played by fakes -
 * the window and the background host record what they were sent, the network
 * and the service launcher answer what the test chooses - so every assertion
 * is about what the host decided.
 */

interface Sent {
  to: 'window' | 'background'
  channel: string
  payload: unknown
}

let root: string
let store: Store
let sent: Sent[]
let hops: Array<{ url: string; headers: Array<[string, string]> }>
let killed: number
let launched: number
let background: BackgroundHost & { needed: boolean[] }
let host: PluginHost

const THEME: HelmTheme = { kind: 'dark', tokens: {} as HelmTheme['tokens'], radius: 3, density: 'comfortable' }

function contents(id: number, to: Sent['to'], frames: Array<{ origin: string; osProcessId: number }> = []): WebContents {
  return {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ to, channel, payload }),
    mainFrame: { framesInSubtree: frames }
  } as unknown as WebContents
}

const windowContents = (): WebContents =>
  contents(1, 'window', [
    { origin: 'http://localhost:5173', osProcessId: 1 },
    { origin: 'helm-plugin://sample', osProcessId: 4100 }
  ])

const fakeWindow = { isDestroyed: () => false, webContents: windowContents() } as unknown as BrowserWindow

/** A plugin folder with its manifest and every page it names built. */
function plugin(folder: string, manifest: Record<string, unknown>): string {
  const dir = join(root, folder)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'helm-plugin.json'), JSON.stringify(manifest))
  for (const page of ['main.html', 'item.html', 'bg.html']) writeFileSync(join(dir, 'dist', page), '<!doctype html>')
  writeFileSync(join(dir, 'service.mjs'), '')
  return dir
}

const SAMPLE = {
  apiVersion: 1,
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  rail: { title: 'Sample', panel: 'main' },
  panels: { main: { title: 'Main', entry: 'dist/main.html', actions: [{ id: 'add', title: 'Add', icon: 'plus' }] } },
  tabs: { item: { title: 'Item', entry: 'dist/item.html' } },
  background: 'dist/bg.html',
  commands: [
    { id: 'refresh', title: 'Refresh' },
    { id: 'new', title: 'New', tab: 'item' }
  ],
  settings: [
    { key: 'server', type: 'text', label: 'Server', default: 'https://api.example.com' },
    { key: 'limit', type: 'number', label: 'Limit', default: 5, min: 1, max: 10 },
    { key: 'unread', type: 'toggle', label: 'Unread' },
    { key: 'order', type: 'select', label: 'Order', options: [{ value: 'new', label: 'New' }, { value: 'old', label: 'Old' }], default: 'new' },
    { key: 'token', type: 'secret', label: 'Token', secret: 'token' }
  ],
  network: ['https://api.example.com', 'https://*.example.org'],
  secrets: ['token', 'shared'],
  exec: { echo: { command: process.execPath, args: ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))'] } },
  service: { node: 'service.mjs', start: 'enable' },
  sessions: true
}

let sampleDir: string
let otherDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm plugin host-'))
  sampleDir = plugin('sample plugin', SAMPLE)
  otherDir = plugin('other plugin', {
    apiVersion: 1,
    id: 'other',
    name: 'Other',
    panels: { main: { title: 'Main', entry: 'dist/main.html' } },
    secrets: ['shared']
  })
  plugin('same id', { apiVersion: 1, id: 'sample', name: 'Impostor' })
  mkdirSync(join(root, 'empty folder'))
  writeFileSync(join(root, 'a file.txt'), '')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  store = openStore({ file: ':memory:' })
  sent = []
  hops = []
  killed = 0
  launched = 0
  const needed: boolean[] = []
  background = {
    needed,
    sync: (need) => needed.push(need),
    contents: () => contents(2, 'background', [{ origin: 'helm-plugin://sample', osProcessId: 4200 }]),
    shutdown: () => needed.push(false)
  }
})

afterEach(() => {
  host?.shutdown()
  store.close()
})

const send: SendHop = (hop, signal) => {
  hops.push({ url: hop.url.href, headers: hop.headers })
  if (hop.url.pathname === '/slow') {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  }
  return Promise.resolve({ kind: 'response', status: 200, statusText: 'OK', headers: [], body: new TextEncoder().encode('ok') })
}

/** A service that starts and never listens: enough to see it started and stopped. */
const launcher: ServiceLauncher = () => {
  launched += 1
  return { pid: () => 4300, onOutput: () => undefined, onExit: () => undefined, kill: () => (killed += 1) }
}

function start(folders: string[] = [sampleDir], extra: Partial<PluginHostOptions> = {}): PluginHost {
  for (const folder of folders) addPluginFolder(store, folder)
  host = createPluginHost({
    ...extra,
    store,
    window: () => fakeWindow,
    theme: () => THEME,
    bridge: 'bridge',
    stylesheet: 'css',
    crypto: { available: () => true, encrypt: (text) => Buffer.from(text), decrypt: (data) => data.toString() },
    send,
    launcher,
    background,
    watch: false
  })
  host.start()
  return host
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const info = (path = sampleDir): PluginInfo => host.list().find((entry) => entry.path === path)!
const events = (channel: string, to?: Sent['to']): unknown[] =>
  sent.filter((one) => one.channel === channel && (to === undefined || one.to === to)).map((one) => one.payload)

let callIds = 0
function call(method: string, args: unknown[] = [], patch: { plugin?: string; surface?: 'panel' | 'tab' | 'background'; sender?: number; callId?: string } = {}): Promise<PluginCallOutcome> {
  return host.call(
    { plugin: patch.plugin ?? 'sample', surface: patch.surface ?? 'panel', method, args, callId: patch.callId ?? `c${String(++callIds)}` },
    patch.sender ?? 1
  )
}

describe('reading folders', () => {
  it('lists every registered folder, what loaded and what did not', async () => {
    addPluginFolder(store, join(root, 'empty folder'))
    start()
    const list = host.list()
    expect(list.map((entry) => [entry.name, entry.error])).toEqual([
      ['empty folder', 'there is no helm-plugin.json in this folder'],
      ['Sample', null]
    ])
    expect(info()).toMatchObject({
      id: 'sample',
      version: '1.0.0',
      enabled: true,
      rail: { title: 'Sample', panel: 'main' },
      panels: { main: { title: 'Main', url: 'helm-plugin://sample/dist/main.html', actions: [{ id: 'add', title: 'Add', icon: 'plus' }] } },
      tabs: { item: { title: 'Item', url: 'helm-plugin://sample/dist/item.html' } },
      background: { url: 'helm-plugin://sample/dist/bg.html', state: 'starting', error: null },
      network: ['https://api.example.com', 'https://*.example.org'],
      secrets: [
        { key: 'token', state: 'missing' },
        { key: 'shared', state: 'missing' }
      ],
      exec: [{ name: 'echo', command: process.execPath, args: expect.any(Array) }],
      service: { kind: 'node', command: 'service.mjs', start: 'enable', state: 'starting' },
      runsPrograms: true,
      settingValues: { server: 'https://api.example.com', limit: 5, unread: null, order: 'new' }
    })
    // `start: "enable"`: launched once a port is found, with nothing waiting on it.
    await vi.waitFor(() => expect(launched).toBe(1))
  })

  it('opens the background host a turn after start, not before the window', async () => {
    start()
    expect(background.needed).toEqual([])
    await tick()
    expect(background.needed.length).toBeGreaterThan(0)
    expect(background.needed.every((need) => need)).toBe(true)
  })

  it('gives a second plugin with an id already loaded an error naming the first', () => {
    start([sampleDir, join(root, 'same id')])
    expect(info(join(root, 'same id')).error).toBe(`a plugin with the id "sample" is already loaded from ${sampleDir}`)
    expect(info().error).toBeNull()
  })

  it.each([
    ['relative\\path', 'Choose a folder.'],
    ['__file__', 'is not a folder.'],
    ['__empty__', 'There is no helm-plugin.json in']
  ])('refuses to add %s', (given, error) => {
    start([])
    const path = given === '__file__' ? join(root, 'a file.txt') : given === '__empty__' ? join(root, 'empty folder') : given
    const result = host.add(path)
    expect(result.error).toContain(error)
    expect(result.plugins).toEqual([])
    expect(readPluginFolders(store)).toEqual([])
  })

  it('adds a folder once, whatever the case of its path', async () => {
    start([])
    expect(host.add(sampleDir)).toMatchObject({ path: sampleDir, error: null, plugins: [expect.objectContaining({ id: 'sample' })] })
    expect(host.add(sampleDir.toUpperCase()).error).toBeNull()
    expect(host.list()).toHaveLength(1)
    await tick()
    expect(events('plugins:changed', 'window')).toHaveLength(1)
  })
})

describe('switching off, reloading and removing', () => {
  it('switching off stops what it runs, forgets what it said, and moves it to a new revision', async () => {
    start()
    await vi.waitFor(() => expect(launched).toBe(1))
    await call('status.set', [{ text: 'hi' }])
    await call('badge.set', [3])
    const before = info().revision
    host.setEnabled(sampleDir, false)
    expect(killed).toBe(1)
    expect(info()).toMatchObject({ enabled: false, status: null, badge: null, background: { state: 'stopped' } })
    expect(info().revision).toBeGreaterThan(before)
    await tick()
    // Nothing needs a background page now: the host window closes.
    expect(background.needed.at(-1)).toBe(false)
    expect(readPluginFolders(store)[0]?.enabled).toBe(false)
    expect(await call('settings.get')).toMatchObject({ ok: false, code: 'unavailable' })
    host.setEnabled(sampleDir, true)
    expect(info().enabled).toBe(true)
    await vi.waitFor(() => expect(launched).toBe(2))
  })

  it('reloading reads the folder again under a new revision', () => {
    start()
    const before = info().revision
    host.reload(sampleDir)
    expect(info().revision).toBeGreaterThan(before)
    expect(host.log(sampleDir).map((line) => line.text)).toContain('reloaded from Settings')
  })

  it('removing deletes only the secrets no other plugin may use', () => {
    start([sampleDir, otherDir])
    host.secrets.save({ key: 'token', value: 'own', hosts: [], plugins: ['sample'] })
    host.secrets.save({ key: 'shared', value: 'both', hosts: [], plugins: ['sample', 'other'] })
    expect(host.ownSecrets(sampleDir)).toEqual(['token'])
    const list = host.remove(sampleDir, ['token', 'shared'])
    expect(list.map((entry) => entry.id)).toEqual(['other'])
    expect(readSecrets(store).map((row) => row.key)).toEqual(['shared'])
    expect(readPluginFolders(store).map((folder) => folder.path)).toEqual([otherDir])
    expect(events('secrets:changed', 'window')).not.toHaveLength(0)
  })

  it('does not start a folder that was switched off', () => {
    addPluginFolder(store, sampleDir)
    setPluginEnabled(store, sampleDir, false)
    start([])
    expect(info()).toMatchObject({ enabled: false, error: null })
    expect(launched).toBe(0)
  })
})

describe('bridge calls', () => {
  it('refuses what is not part of the bridge, a surface that is not one, and a plugin that is not on', async () => {
    start()
    expect(await call('toString')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('fs.read')).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('settings.get', [], { surface: 'window' as never })).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('settings.get', [], { plugin: 'other' })).toMatchObject({ ok: false, code: 'unavailable' })
  })

  it('opens a declared tab in the window, with its parameters and title', async () => {
    start()
    expect(await call('tabs.open', ['item', { id: '7', n: 2 }, { title: 'Seven' }])).toEqual({ ok: true, value: undefined })
    expect(events('plugins:ui', 'window')).toEqual([{ kind: 'openTab', plugin: 'sample', tab: 'item', params: { id: '7', n: 2 }, title: 'Seven' }])
  })

  it.each([
    [['nope'], 'not-declared'],
    [['item', { nested: { deep: 1 } }], 'invalid'],
    [['item', {}, { title: '' }], 'invalid'],
    [['item', {}, 'title'], 'invalid']
  ])('refuses tabs.open %j', async (args, code) => {
    start()
    expect(await call('tabs.open', args)).toMatchObject({ ok: false, code })
    expect(events('plugins:ui')).toEqual([])
  })

  it('holds a status and a badge to their shapes, and says both changes in one push', async () => {
    start()
    await tick()
    sent.length = 0
    expect(await call('status.set', [{ text: '' }])).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('status.set', [{ text: 'x', tone: 'loud' }])).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('badge.set', [-1])).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('badge.set', [1.5])).toMatchObject({ ok: false, code: 'invalid' })
    await Promise.all([call('status.set', [{ text: ' 3 new ', tone: 'accent', tooltip: 'Three' }]), call('badge.set', [3])])
    await tick()
    expect(events('plugins:changed', 'window')).toHaveLength(1)
    expect(events('plugins:changed', 'background')).toHaveLength(1)
    expect(info()).toMatchObject({ status: { text: '3 new', tone: 'accent', tooltip: 'Three' }, badge: 3 })
    await call('badge.set', [0])
    expect(info().badge).toBeNull()
  })

  it('reads settings with their defaults, and delivers a change to every page of the plugin', async () => {
    start()
    expect(await call('settings.get')).toEqual({ ok: true, value: { server: 'https://api.example.com', limit: 5, unread: null, order: 'new' } })
    host.setSetting('sample', 'limit', 8)
    const value = { server: 'https://api.example.com', limit: 8, unread: null, order: 'new' }
    expect(events('plugins:deliver', 'window')).toEqual([{ plugin: 'sample', event: 'settings', data: value, to: 'all' }])
    expect(events('plugins:deliver', 'background')).toHaveLength(1)
    expect(await call('settings.get')).toEqual({ ok: true, value })
    host.setSetting('sample', 'limit', null)
    expect(await call('settings.get')).toMatchObject({ value: { limit: 5 } })
  })

  it.each([
    ['limit', 11, 'Limit is at most 10'],
    ['limit', 'five', 'Limit is a number'],
    ['order', 'sideways', 'Order is one of its options'],
    ['unread', 'yes', 'Unread is on or off'],
    ['token', 'abc', "token is not one of Sample's settings"],
    ['missing', 1, "missing is not one of Sample's settings"]
  ])('refuses setting %s to %j', (key, value, message) => {
    start()
    expect(() => host.setSetting('sample', key, value as never)).toThrow(message)
    expect(events('plugins:deliver')).toEqual([])
  })

  it('asks the window for a missing secret and answers when the dialog closes', async () => {
    start()
    const pending = call('secrets.request', ['token'])
    await tick()
    const [asked] = events('plugins:ui', 'window') as Array<{ kind: string; requestId: string; key: string; hosts: string[] }>
    expect(asked).toMatchObject({ kind: 'secret', plugin: 'sample', key: 'token', hosts: ['https://api.example.com', 'https://*.example.org'] })
    host.secrets.save({ key: 'token', value: 'v', hosts: ['https://api.example.com'], plugins: ['sample'] })
    host.answer(asked!.requestId)
    expect(await pending).toEqual({ ok: true, value: 'ready' })
    expect(await call('secrets.state', ['token'])).toEqual({ ok: true, value: 'ready' })
    // Ready already: no dialog.
    sent.length = 0
    expect(await call('secrets.request', ['token'])).toEqual({ ok: true, value: 'ready' })
    expect(events('plugins:ui')).toEqual([])
  })

  it('answers a request the user dismissed as missing, and refuses a key it does not declare', async () => {
    start()
    const pending = call('secrets.request', ['token'])
    await tick()
    const [asked] = events('plugins:ui') as Array<{ requestId: string }>
    host.answer(asked!.requestId)
    expect(await pending).toEqual({ ok: true, value: 'missing' })
    expect(await call('secrets.request', ['other'])).toMatchObject({ ok: false, code: 'not-declared' })
    expect(await call('secrets.state', ['other'])).toMatchObject({ ok: false, code: 'not-declared' })
  })

  it('tells every page of a plugin when one of its secrets changes', () => {
    start()
    host.secrets.save({ key: 'token', value: 'v', hosts: [], plugins: ['sample'] })
    expect(events('plugins:deliver', 'window')).toContainEqual({
      plugin: 'sample',
      event: 'secrets',
      data: { token: 'ready', shared: 'missing' },
      to: 'all'
    })
  })

  it('sends a fetch through the network allowlist', async () => {
    start()
    expect(await call('fetch', [{ url: 'https://api.example.com/x', method: 'GET', headers: [], body: null, redirect: 'follow' }])).toMatchObject({
      ok: true,
      value: { status: 200 }
    })
    expect(await call('fetch', [{ url: 'https://elsewhere.com/', method: 'GET', headers: [], body: null, redirect: 'follow' }])).toMatchObject({
      ok: false,
      code: 'not-declared'
    })
    expect(hops.map((hop) => hop.url)).toEqual(['https://api.example.com/x'])
  })

  it('cancels a call in flight for the page that made it, and only that page', async () => {
    start()
    const pending = call('fetch', [{ url: 'https://api.example.com/slow', method: 'GET', headers: [], body: null, redirect: 'follow' }], {
      callId: 'slow-1',
      sender: 1
    })
    await vi.waitFor(() => expect(hops).toHaveLength(1))
    host.cancel('slow-1', 2)
    host.cancel('slow-1', 1)
    expect(await pending).toMatchObject({ ok: false, code: 'aborted' })
  })

  it('ends the calls a plugin has in flight when it is switched off or reloaded, whatever its pages do', async () => {
    start()
    const slow = (callId: string): Promise<unknown> =>
      call('fetch', [{ url: 'https://api.example.com/slow', method: 'GET', headers: [], body: null, redirect: 'follow' }], {
        callId,
        sender: 1
      })
    const off = slow('slow-off')
    await vi.waitFor(() => expect(hops).toHaveLength(1))
    host.setEnabled(sampleDir, false)
    expect(await off).toMatchObject({ ok: false, code: 'aborted' })

    host.setEnabled(sampleDir, true)
    const reloaded = slow('slow-reload')
    await vi.waitFor(() => expect(hops).toHaveLength(2))
    host.reload(sampleDir)
    expect(await reloaded).toMatchObject({ ok: false, code: 'aborted' })
  })

  it('runs a declared program and refuses one it does not declare', async () => {
    start()
    expect(await call('exec', ['echo', ['a b', 'c']])).toEqual({
      ok: true,
      value: { exitCode: 0, stdout: 'a b|c', stderr: '', timedOut: false }
    })
    expect(await call('exec', ['cmd', ['/c', 'dir']])).toMatchObject({ ok: false, code: 'not-declared' })
    expect(await call('exec', ['../echo'])).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('the background page', () => {
  it('takes a command with no tab', () => {
    start()
    host.command('sample', 'refresh')
    host.command('sample', 'undeclared')
    expect(events('plugins:deliver', 'background')).toEqual([{ plugin: 'sample', event: 'command', data: { id: 'refresh' }, to: 'background' }])
    expect(events('plugins:deliver', 'window')).toEqual([])
  })

  it('reports its state against the revision it was made for, and a crash clears what it painted', async () => {
    start()
    await call('status.set', [{ text: '2 unread' }])
    await call('badge.set', [2])
    const { revision } = info()
    host.backgroundState('sample', revision - 1, 'crashed', 'old page')
    expect(info().background?.state).toBe('starting')
    host.backgroundState('sample', revision, 'running', null)
    expect(info().background).toMatchObject({ state: 'running', error: null })
    host.backgroundState('sample', revision, 'crashed', 'The page ended unexpectedly.')
    expect(info()).toMatchObject({
      background: { state: 'crashed', error: 'The page ended unexpectedly.' },
      status: null,
      badge: null
    })
    expect(host.log(sampleDir).map((line) => line.text)).toContain('background page stopped: The page ended unexpectedly.')
  })
})

describe('the pages that frame plugins', () => {
  it('are the window and the background host, and nothing else', () => {
    start()
    expect(host.framesPlugins(1)).toBe(true)
    expect(host.framesPlugins(2)).toBe(true)
    expect(host.framesPlugins(3)).toBe(false)
  })

  it("are where a plugin's memory and CPU are found, with its service", () => {
    start()
    expect(host.metrics()).toEqual([{ path: sampleDir, plugin: 'sample', memoryKb: 70_000, cpuPercent: 2, processes: 2 }])
  })

  it('are told about a theme change', () => {
    start()
    host.pushTheme(THEME)
    expect(sent.filter((one) => one.channel === 'plugins:theme').map((one) => one.to)).toEqual(['window', 'background'])
  })
})

describe('tools for sessions', () => {
  const SESSION = { id: 'a1b2c3', name: 'alpha', cwd: 'C:/work/alpha' }
  let trackerDir: string

  beforeAll(() => {
    trackerDir = plugin('tracker plugin', {
      apiVersion: 1,
      id: 'tracker',
      name: 'Tracker',
      background: 'dist/bg.html',
      agent: {
        instructions: 'Cards are on the board.',
        tools: {
          list_cards: { description: 'Lists the cards.' },
          add_card: { description: 'Adds a card.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
        }
      }
    })
  })

  /** The background host's word that the tracker's page connected. */
  const running = (): void => host.backgroundState('tracker', info(trackerDir).revision, 'running', null)
  const toolCalls = (): PluginToolCall[] => events('plugins:tool', 'background') as PluginToolCall[]
  const callTool = (tool = 'list_cards', signal = new AbortController().signal): ReturnType<PluginHost['callTool']> =>
    host.callTool({ plugin: 'tracker', tool, args: { all: true }, session: SESSION }, signal)

  it("offers a plugin's tools while it is on and they are not switched off, and says so in what the window draws", () => {
    start([sampleDir, trackerDir])
    expect(host.toolServers()).toEqual([
      {
        plugin: 'tracker',
        name: 'Tracker',
        server: 'helm-plugin-tracker',
        instructions: 'Cards are on the board.',
        tools: [
          { name: 'list_cards', description: 'Lists the cards.', inputSchema: { type: 'object', properties: {} } },
          { name: 'add_card', description: 'Adds a card.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
        ]
      }
    ])
    expect(info(trackerDir).agent).toEqual({
      enabled: true,
      server: 'helm-plugin-tracker',
      instructions: 'Cards are on the board.',
      tools: [
        { name: 'list_cards', description: 'Lists the cards.' },
        { name: 'add_card', description: 'Adds a card.' }
      ]
    })
    expect(info().agent).toBeNull()

    expect(info(host.setTools(trackerDir, false).find((entry) => entry.path === trackerDir)?.path).agent?.enabled).toBe(false)
    expect(host.toolServers()).toEqual([])
    expect(readPluginFolders(store).find((folder) => folder.path === trackerDir)?.toolsEnabled).toBe(false)
    host.setTools(trackerDir, true)
    expect(host.toolServers()).toHaveLength(1)
    host.setEnabled(trackerDir, false)
    expect(host.toolServers()).toEqual([])
  })

  it('tells the endpoint when the plugins offering tools change, and not when anything else does', async () => {
    const onToolsChanged = vi.fn()
    start([sampleDir, trackerDir], { onToolsChanged })
    running()
    await tick()
    // The first word is what they are at all.
    expect(onToolsChanged).toHaveBeenCalledTimes(1)
    host.setSetting('sample', 'limit', 7)
    await call('badge.set', [3])
    await tick()
    expect(onToolsChanged).toHaveBeenCalledTimes(1)
    host.setTools(trackerDir, false)
    await tick()
    expect(onToolsChanged).toHaveBeenCalledTimes(2)
    host.setTools(trackerDir, true)
    await tick()
    expect(onToolsChanged).toHaveBeenCalledTimes(3)
  })

  it('hands a call to the background host and answers with what came back from there, and only from there', async () => {
    start([trackerDir])
    running()
    const answer = callTool('add_card')
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1))
    const sentCall = toolCalls()[0]!
    expect(sentCall).toEqual({ id: expect.any(String) as string, plugin: 'tracker', name: 'add_card', args: { all: true }, session: SESSION })

    let settled = false
    void answer.then(() => (settled = true))
    host.toolResult({ id: sentCall.id, ok: true, text: 'from the window' }, 1)
    await tick()
    expect(settled).toBe(false)
    host.toolResult({ id: sentCall.id, ok: true, text: 'added' }, 2)
    await expect(answer).resolves.toEqual({ ok: true, text: 'added' })
    expect(host.log(trackerDir).map((line) => line.text)).toContain('add_card called by session "alpha"')
  })

  it('refuses a tool the manifest does not declare, and a plugin not offering tools, before anything reaches a page', async () => {
    start([trackerDir])
    running()
    expect(await callTool('remove_card')).toEqual({
      ok: false,
      message: 'Tracker has no tool called "remove_card". It has: list_cards, add_card.'
    })
    host.setTools(trackerDir, false)
    expect(await callTool()).toMatchObject({ ok: false, message: expect.stringContaining('not offering tools any more') as string })
    expect(await host.callTool({ plugin: 'nobody', tool: 'x', args: {}, session: SESSION }, new AbortController().signal)).toMatchObject({
      ok: false
    })
    expect(toolCalls()).toEqual([])
  })

  it('waits for a background page that is starting, and says when it has stopped', async () => {
    start([trackerDir])
    expect(info(trackerDir).background?.state).toBe('starting')
    const answer = callTool()
    await tick()
    expect(toolCalls()).toEqual([])
    running()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1))
    host.toolResult({ id: toolCalls()[0]!.id, ok: true, text: 'two cards' }, 2)
    await expect(answer).resolves.toEqual({ ok: true, text: 'two cards' })

    host.backgroundState('tracker', info(trackerDir).revision, 'crashed', 'it threw on start')
    expect(await callTool()).toEqual({
      ok: false,
      message:
        "The plugin's background page stopped (it threw on start). Reloading the plugin in Helm's Settings > Plugins starts it again."
    })
    expect(toolCalls()).toHaveLength(1)
  })

  it('ends a call in flight when the tools are switched off, or the plugin is reloaded, and tells the page to stop', async () => {
    start([trackerDir])
    running()
    const first = callTool()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1))
    host.setTools(trackerDir, false)
    await expect(first).resolves.toEqual({ ok: false, message: "The user turned this plugin's tools off in Helm." })
    expect(events('plugins:toolCancel', 'background')).toEqual([{ id: toolCalls()[0]!.id }])

    host.setTools(trackerDir, true)
    const second = callTool()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(2))
    host.reload(trackerDir)
    await expect(second).resolves.toMatchObject({ ok: false, message: expect.stringContaining('stopped before it answered') as string })
  })

  it('cancels at the page when the session stops waiting, and ends every call at shutdown', async () => {
    start([trackerDir])
    running()
    const controller = new AbortController()
    const cancelled = callTool('list_cards', controller.signal)
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1))
    controller.abort()
    await expect(cancelled).resolves.toEqual({ ok: false, message: 'The call was cancelled.' })
    expect(events('plugins:toolCancel', 'background')).toEqual([{ id: toolCalls()[0]!.id }])

    const waiting = callTool()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(2))
    host.shutdown()
    await expect(waiting).resolves.toEqual({ ok: false, message: 'Helm is shutting down.' })
    expect(await callTool()).toEqual({ ok: false, message: 'Helm is shutting down.' })
  })
})

describe('starting a session', () => {
  type SessionAsked = { kind: 'session'; requestId: string; plugin: string; cwd: string; name: string; prompt: string }
  const asked = (): SessionAsked[] => (events('plugins:ui', 'window') as SessionAsked[]).filter((ui) => ui.kind === 'session')
  const record = { id: 9, name: 'HELM-2' } as never
  const grid = { cols: 120, rows: 40 }
  let launches: PluginSessionLaunch[]

  function startSessions(launch: (request: PluginSessionLaunch) => Promise<never> = () => Promise.resolve(record)): void {
    launches = []
    start([sampleDir, otherDir], {
      startSession: (request) => {
        launches.push(request)
        return launch(request)
      }
    })
  }

  it('puts what the page asked for to the user, and launches that, not anything the window says', async () => {
    startSessions()
    expect(info().startsSessions).toBe(true)
    const pending = call('sessions.start', [{ cwd: root, prompt: '  work on HELM-2 ', name: 'HELM-2' }])
    await tick()
    const [ask] = asked()
    expect(ask).toMatchObject({ plugin: 'sample', cwd: root, name: 'HELM-2', prompt: 'work on HELM-2' })

    await expect(host.session({ requestId: ask!.requestId, start: true, ...grid }, 1)).resolves.toBe(record)
    expect(launches).toEqual([{ cwd: root, name: 'HELM-2', prompt: 'work on HELM-2', ...grid }])
    expect(await pending).toEqual({ ok: true, value: 'started' })
    expect(host.log(sampleDir).at(-1)?.text).toBe(`started a session in ${root}, which the user agreed to`)
    // Answered once: the request is spent.
    await expect(host.session({ requestId: ask!.requestId, start: true, ...grid }, 1)).rejects.toThrow('That request has gone')
    expect(launches).toHaveLength(1)
  })

  it("names the session after its folder when the page names none", async () => {
    startSessions()
    void call('sessions.start', [{ cwd: sampleDir, prompt: 'go' }])
    await tick()
    expect(asked()[0]).toMatchObject({ cwd: sampleDir, name: 'sample plugin' })
  })

  it('resolves cancelled when the user says no, and launches nothing', async () => {
    startSessions()
    const pending = call('sessions.start', [{ cwd: root, prompt: 'go' }])
    await tick()
    await expect(host.session({ requestId: asked()[0]!.requestId, start: false, cols: 0, rows: 0 }, 1)).resolves.toBeNull()
    expect(await pending).toEqual({ ok: true, value: 'cancelled' })
    expect(launches).toEqual([])
  })

  it('takes the answer only from the window that drew the dialog', async () => {
    startSessions()
    void call('sessions.start', [{ cwd: root, prompt: 'go' }])
    await tick()
    await expect(host.session({ requestId: asked()[0]!.requestId, start: true, ...grid }, 2)).rejects.toThrow(
      'Only the window that asked'
    )
    expect(launches).toEqual([])
  })

  it('says why a launch failed, to the page and to the window', async () => {
    startSessions(() => Promise.reject(new Error('Claude Code CLI not found.')))
    const pending = call('sessions.start', [{ cwd: root, prompt: 'go' }])
    await tick()
    await expect(host.session({ requestId: asked()[0]!.requestId, start: true, ...grid }, 1)).rejects.toThrow(
      'Claude Code CLI not found.'
    )
    expect(await pending).toEqual({ ok: false, code: 'unavailable', message: 'Claude Code CLI not found.' })
  })

  it('takes the dialog away when the page goes, or the plugin is turned off, before the user answers', async () => {
    startSessions()
    const pending = call('sessions.start', [{ cwd: root, prompt: 'go' }], { callId: 'leaving' })
    await tick()
    const { requestId } = asked()[0]!
    host.cancel('leaving', 1)
    expect(await pending).toEqual({ ok: true, value: 'cancelled' })
    expect(events('plugins:ui', 'window')).toContainEqual({ kind: 'sessionWithdrawn', requestId })
    await expect(host.session({ requestId, start: true, ...grid }, 1)).rejects.toThrow('That request has gone')

    const second = call('sessions.start', [{ cwd: root, prompt: 'go' }])
    await tick()
    host.setEnabled(sampleDir, false)
    expect(await second).toEqual({ ok: true, value: 'cancelled' })
    expect(launches).toEqual([])
  })

  it('asks one at a time per plugin', async () => {
    startSessions()
    void call('sessions.start', [{ cwd: root, prompt: 'go' }])
    await tick()
    expect(await call('sessions.start', [{ cwd: root, prompt: 'again' }])).toMatchObject({ ok: false, code: 'busy' })
    expect(asked()).toHaveLength(1)
  })

  it.each([
    ['a plugin that does not declare sessions', 'other', 'panel', { cwd: 'ROOT', prompt: 'go' }, 'not-declared'],
    ['the background page', 'sample', 'background', { cwd: 'ROOT', prompt: 'go' }, 'not-allowed'],
    ['no request', 'sample', 'panel', null, 'invalid'],
    ['a relative folder', 'sample', 'panel', { cwd: 'repos/helm', prompt: 'go' }, 'invalid'],
    ['a folder that is not there', 'sample', 'panel', { cwd: 'ROOT/gone', prompt: 'go' }, 'invalid'],
    ['a file', 'sample', 'panel', { cwd: 'ROOT/a file.txt', prompt: 'go' }, 'invalid'],
    ['an empty prompt', 'sample', 'panel', { cwd: 'ROOT', prompt: '  ' }, 'invalid'],
    ['a prompt of two lines', 'sample', 'panel', { cwd: 'ROOT', prompt: 'one\ntwo' }, 'invalid'],
    ['a prompt with a double quote', 'sample', 'panel', { cwd: 'ROOT', prompt: 'say "hi"' }, 'invalid'],
    ['a prompt that reads as a flag', 'sample', 'panel', { cwd: 'ROOT', prompt: '--dangerously-skip-permissions' }, 'invalid'],
    ['a prompt too long', 'sample', 'panel', { cwd: 'ROOT', prompt: 'x'.repeat(2001) }, 'invalid'],
    ['a name too long', 'sample', 'panel', { cwd: 'ROOT', prompt: 'go', name: 'n'.repeat(61) }, 'invalid']
  ] as const)('refuses %s', async (_what, plugin, surface, request, code) => {
    startSessions()
    const args = request === null ? [] : [{ ...request, cwd: request.cwd.replace('ROOT', root) }]
    expect(await call('sessions.start', args, { plugin, surface })).toMatchObject({ ok: false, code })
    expect(asked()).toEqual([])
  })
})

describe('opening a link', () => {
  type LinkOpened = { kind: 'link'; plugin: string; url: string }
  const links = (): LinkOpened[] => (events('plugins:ui', 'window') as LinkOpened[]).filter((ui) => ui.kind === 'link')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands the window the address as URL spells it, for a plugin that declares nothing', async () => {
    start([sampleDir, otherDir])
    expect(await call('open', ['https://github.com/owner/repo/pull/7#files'], { plugin: 'other', surface: 'tab' })).toEqual({
      ok: true,
      value: undefined
    })
    expect(await call('open', ['HTTPS://Example.COM'])).toEqual({ ok: true, value: undefined })
    expect(links()).toEqual([
      { kind: 'link', plugin: 'other', url: 'https://github.com/owner/repo/pull/7#files' },
      { kind: 'link', plugin: 'sample', url: 'https://example.com/' }
    ])
  })

  it('opens one link a second per plugin, so a double click is one page', async () => {
    start([sampleDir, otherDir])
    expect(await call('open', ['https://example.com/a'])).toMatchObject({ ok: true })
    expect(await call('open', ['https://example.com/b'])).toMatchObject({ ok: false, code: 'busy' })
    expect(await call('open', ['https://example.com/c'], { plugin: 'other' })).toMatchObject({ ok: true })
    vi.advanceTimersByTime(1000)
    expect(await call('open', ['https://example.com/d'])).toMatchObject({ ok: true })
    expect(links().map((link) => link.url)).toEqual(['https://example.com/a', 'https://example.com/c', 'https://example.com/d'])
  })

  it('does not count a refused link against the next', async () => {
    start()
    expect(await call('open', ['http://example.com/'])).toMatchObject({ ok: false, code: 'invalid' })
    expect(await call('open', ['https://example.com/'])).toMatchObject({ ok: true })
  })

  it.each([
    ['the background page', 'background', 'https://example.com/', 'not-allowed'],
    ['no address', 'panel', undefined, 'invalid'],
    ['something that is not an address', 'panel', 'example.com', 'invalid'],
    ['http', 'panel', 'http://example.com/', 'invalid'],
    ['a loopback http address', 'panel', 'http://localhost:3000/', 'invalid'],
    ['file', 'panel', 'file:///C:/Windows/win.ini', 'invalid'],
    ['javascript', 'panel', 'javascript:alert(1)', 'invalid'],
    ['a plugin page', 'panel', 'helm-plugin://sample/index.html', 'invalid'],
    ['a user name and password', 'panel', 'https://user:secret@example.com/', 'invalid'],
    ['an address too long', 'panel', `https://example.com/${'x'.repeat(2048)}`, 'invalid']
  ] as const)('refuses %s', async (_what, surface, url, code) => {
    start()
    expect(await call('open', url === undefined ? [] : [url], { surface })).toMatchObject({ ok: false, code })
    expect(links()).toEqual([])
  })
})

describe('shutdown', () => {
  it('answers a waiting secret request, stops the service and closes the background host', async () => {
    start()
    await vi.waitFor(() => expect(launched).toBe(1))
    const pending = call('secrets.request', ['token'])
    await tick()
    host.shutdown()
    expect(await pending).toEqual({ ok: true, value: 'missing' })
    expect(killed).toBe(1)
    expect(background.needed.at(-1)).toBe(false)
    expect(await call('settings.get')).toMatchObject({ ok: false, code: 'unavailable' })
  })
})
