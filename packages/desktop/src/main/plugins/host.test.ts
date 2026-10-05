import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { addPluginFolder, openStore, readPluginFolders, readSecrets, setPluginEnabled, type Store } from '@helm/core'
import type { HelmTheme } from '@helm/plugin-sdk'
import type { PluginCallOutcome, PluginInfo } from '../../shared/ipc'
import type { PluginHost } from './host'
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
  service: { node: 'service.mjs', start: 'enable' }
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

function start(folders: string[] = [sampleDir]): PluginHost {
  for (const folder of folders) addPluginFolder(store, folder)
  host = createPluginHost({
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
