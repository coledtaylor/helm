import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@helm/core/types'
import { FakeConnection, fakeReach } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import type {
  EventChannel,
  EventPayload,
  HelmBridge,
  OwnAppInfo,
  RequestChannel,
  RequestPayload,
  RequestResult
} from '../../../../shared/ipc'
import type { HostAdapter } from './router'
import { createWorkspaceAdapter } from './workspace'

const HUB = '/work dir/hub'
const ALPHA = '/work dir/hub/repos/alpha'
const PICKED = '/tools dir/claude.exe'

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

const hostSettings = (patch: Partial<P.HostSettings> = {}): P.HostSettings => ({
  scanRoots: [],
  pinnedProjects: [],
  firstRunCompletedAt: null,
  backendPaths: {},
  terminalShell: null,
  transcriptArchiveMaxBytes: 1024,
  browserMcp: true,
  browserMcpLocalOnly: true,
  sessionMcp: true,
  restoreWithoutAsking: false,
  ...patch
})

const git = (dirty: number): P.GitState => ({ branch: 'main', detached: false, dirty, ahead: 0, behind: 0, error: null })

const scanResult = (dirty: number): P.DiscoveryResult => ({
  roots: [HUB],
  harnesses: [],
  projects: [
    {
      path: ALPHA,
      name: 'alpha',
      kind: 'repo',
      harnessPath: HUB,
      hasClaudeDir: true,
      inventory: { skills: 0, commands: 0, agents: 0, hooks: false, settings: false, claudeMd: true, mcp: false },
      git: git(dirty)
    }
  ],
  errors: [],
  scannedAt: '2026-10-30T10:00:00.000Z',
  durationMs: 12
})

const backend = (patch: Partial<P.BackendStatus> = {}): P.BackendStatus => ({
  installed: true,
  path: PICKED,
  source: 'setting',
  version: '2.1.5 (Claude Code)',
  semver: '2.1.5',
  tested: true,
  testedRange: { min: '2.1.0', max: '2.2.0' },
  configDir: '/fixture home/.claude',
  configDirExists: true,
  signedIn: { state: 'unknown' },
  signInSignal: 'no sign-in artefact was found',
  error: null,
  ...patch
})

const BUILD: OwnAppInfo = {
  version: '9.9.9',
  mode: 'dev',
  dataDir: '/data dir',
  dbFile: '/data dir/helm.db',
  migrations: [],
  versions: { electron: '1', chrome: '2', node: '3' },
  windowsBuild: null,
  home: '/home',
  releasesUrl: 'https://example.invalid/releases'
}

/** Helm's main process as the window's bridge reaches it: its own settings, build and picker. */
function ownBridge(patch: Partial<AppSettings> = {}) {
  let settings: AppSettings = { ...DEFAULT_SETTINGS, ...patch }
  const writes: Array<Partial<AppSettings>> = []
  const picks: Array<string | null> = []
  const listeners = new Set<(settings: AppSettings) => void>()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      switch (channel) {
        case 'ownSettings:read':
          return Promise.resolve(settings)
        case 'ownSettings:write':
          writes.push(payload as Partial<AppSettings>)
          settings = { ...settings, ...(payload as Partial<AppSettings>) }
          return Promise.resolve(settings)
        case 'ownApp:info':
          return Promise.resolve(BUILD)
        case 'path:chooseFile':
          return Promise.resolve({ path: picks.shift() ?? null })
        default:
          return Promise.reject(new Error(`${channel} is not Helm's own`))
      }
    },
    on: (channel: string, listener: (settings: AppSettings) => void) => {
      if (channel === 'ownSettings:changed') listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return {
    bridge: bridge as unknown as Pick<HelmBridge, 'invoke' | 'on'>,
    writes,
    picks,
    /** Main changed Helm's own settings, as the browser pane's history does. */
    change: (next: Partial<AppSettings>) => {
      settings = { ...settings, ...next }
      for (const listener of listeners) listener(settings)
    }
  }
}

function world(connection: FakeConnection | null = new FakeConnection(), own = ownBridge()) {
  let host = hostSettings()
  connection
    ?.answer('settings:read', () => host)
    .answer('settings:write', (patch) => (host = { ...host, ...patch }))
    .answer('discovery:cached', () => [{ ...scanResult(1).projects[0]!, lastSeenAt: '2026-10-29T10:00:00.000Z', template: null }])
    .answer('discovery:scan', () => scanResult(2))
    .answer('git:refresh', () => ({ [ALPHA]: git(5) }))
    .answer('roots:accept', ({ path }) => (host = { ...host, scanRoots: [...host.scanRoots, path] }).scanRoots)
    .answer('setup:status', () => ({ backends: { 'claude-code': backend() } }))
    .answer('setup:locateBackend', () => backend())
    .answer('setup:complete', () => (host = { ...host, firstRunCompletedAt: '2026-10-30T11:00:00.000Z' }))
  const link = fakeReach(connection, UNREACHABLE)
  let focus: () => void = () => undefined
  const adapter = createWorkspaceAdapter({
    link,
    own: own.bridge,
    onFocus: (listener) => {
      focus = listener
    }
  })
  const emitted: Array<{ channel: string; payload: unknown }> = []
  return {
    connection: connection ?? new FakeConnection(),
    link,
    adapter,
    own,
    emitted,
    listen: () => {
      for (const channel of ['settings:changed', 'discovery:updated', 'scan:status', 'git:updated'] as const) {
        on(adapter, channel, (payload) => emitted.push({ channel, payload }))
      }
    },
    focus: () => focus(),
    host: () => host
  }
}

function ask<K extends RequestChannel>(adapter: HostAdapter, channel: K, payload?: RequestPayload<K>): Promise<RequestResult<K>> {
  const route = adapter.requests?.[channel]
  if (route === undefined) throw new Error(`no route for ${channel}`)
  return route(payload as RequestPayload<K>)
}

function on<K extends EventChannel>(adapter: HostAdapter, channel: K, listener: (payload: EventPayload<K>) => void): () => void {
  const route = adapter.events?.[channel]
  if (route === undefined) throw new Error(`no route for ${channel}`)
  return route(listener)
}

/** Lets every answer already given be heard: the fake host answers on the next turns of the microtask queue. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

describe('the window’s workspace over its own connection', () => {
  it('keeps the host’s settings in the host and Helm’s own with Helm, and shows both laid together', async () => {
    const { adapter, own, connection, host } = world(new FakeConnection(), ownBridge({ theme: 'light' }))
    const next = await ask(adapter, 'settings:write', {
      scanRoots: [HUB],
      firstRunCompletedAt: '2026-10-30T09:00:00.000Z',
      theme: 'dark',
      terminalFontSize: 15,
      browserSearch: 'off'
    })
    expect(connection.payloads('settings:write')).toEqual([
      { scanRoots: [HUB], firstRunCompletedAt: '2026-10-30T09:00:00.000Z' }
    ])
    expect(own.writes).toEqual([{ theme: 'dark', terminalFontSize: 15, browserSearch: 'off' }])
    expect(host().scanRoots).toEqual([HUB])
    expect(next).toMatchObject({ scanRoots: [HUB], theme: 'dark', terminalFontSize: 15, browserSearch: 'off' })
    await expect(ask(adapter, 'settings:read')).resolves.toMatchObject({ scanRoots: [HUB], theme: 'dark' })
  })

  it('a write of only Helm’s own settings asks the host nothing', async () => {
    const { adapter, own, connection } = world()
    await ask(adapter, 'settings:write', { windowBounds: { width: 900, height: 700, x: 1, y: 2 } })
    expect(own.writes).toEqual([{ windowBounds: { width: 900, height: 700, x: 1, y: 2 } }])
    expect(connection.payloads('settings:write')).toEqual([])
  })

  it('tells the window when either half changes, with the other laid over', async () => {
    const { adapter, own, connection, emitted, listen, link } = world()
    listen()
    await link.connect()
    await ask(adapter, 'settings:read')
    connection.push('settings:changed', hostSettings({ pinnedProjects: [ALPHA] }))
    own.change({ theme: 'dark' })
    await settle()
    const told = emitted.filter((e) => e.channel === 'settings:changed').map((e) => e.payload as AppSettings)
    expect(told.at(-1)).toMatchObject({ pinnedProjects: [ALPHA], theme: 'dark' })
  })

  it('a read asked before the first connect gets the host’s answer, not an empty one first', async () => {
    const { adapter } = world()
    const [cached, settings] = await Promise.all([ask(adapter, 'discovery:cached'), ask(adapter, 'settings:read')])
    expect(cached.map((p) => p.path)).toEqual([ALPHA])
    expect(cached[0]?.git).toEqual({ branch: 'main', detached: false, dirty: 1, ahead: 0, behind: 0 })
    expect(settings.scanRoots).toEqual([])
  })

  it('says why when the host cannot be reached, never no projects, and the first scan says it where scans show', async () => {
    const { adapter, emitted, listen } = world(null, ownBridge({ theme: 'dark' }))
    await expect(ask(adapter, 'discovery:cached')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'roots:suggest')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'template:list')).rejects.toThrow(UNREACHABLE)
    // The window still paints with Helm's own settings.
    await expect(ask(adapter, 'settings:read')).resolves.toMatchObject({ theme: 'dark' })
    listen()
    await settle()
    expect(emitted).toContainEqual({ channel: 'scan:status', payload: { running: false, error: UNREACHABLE } })
  })

  it('starts the first scan once, and hands the host’s discovery, scan state and git to the window', async () => {
    const { connection, emitted, listen, link } = world()
    listen()
    listen()
    await link.connect()
    await settle()
    expect(connection.payloads('discovery:scan')).toEqual([{ includeGit: true }])
    connection.push('discovery:updated', scanResult(3))
    connection.push('scan:status', { running: false, error: null })
    connection.push('git:updated', { [ALPHA]: git(4) })
    expect(emitted).toContainEqual({ channel: 'scan:status', payload: { running: false } })
    expect(emitted).toContainEqual({
      channel: 'git:updated',
      payload: { [ALPHA]: { branch: 'main', detached: false, dirty: 4, ahead: 0, behind: 0 } }
    })
    const discovered = emitted.filter((e) => e.channel === 'discovery:updated')
    expect(discovered).toHaveLength(2)
  })

  it('reads git again when the window comes to the front, once it has the host’s scan', async () => {
    const { connection, listen, link, focus } = world()
    focus()
    expect(connection.payloads('git:refresh')).toEqual([])
    listen()
    await link.connect()
    connection.push('discovery:updated', scanResult(3))
    focus()
    await settle()
    expect(connection.payloads('git:refresh')).toEqual([null])
  })

  it('locates claude with the window’s picker, and Helm keeps it only once the host checked and kept it', async () => {
    const { adapter, own, connection } = world()
    own.picks.push(null)
    await ask(adapter, 'setup:locateClaude')
    expect(connection.payloads('setup:locateBackend')).toEqual([])

    own.picks.push(PICKED)
    const status = await ask(adapter, 'setup:locateClaude')
    expect(connection.payloads('setup:locateBackend')).toEqual([{ backend: 'claude-code', path: PICKED }])
    expect(status.path).toBe(PICKED)
    expect(own.writes).toEqual([{ claudePath: PICKED }])

    connection.answer('setup:locateBackend', () => backend({ installed: false, error: 'not a program' }))
    own.picks.push('/tools dir/notes.txt')
    await ask(adapter, 'setup:locateClaude')
    expect(own.writes).toEqual([{ claudePath: PICKED }])
  })

  it('finishes setup and accepts a scan root in the host', async () => {
    const { adapter, host } = world()
    await expect(ask(adapter, 'setup:complete')).resolves.toMatchObject({ firstRunCompletedAt: '2026-10-30T11:00:00.000Z' })
    await expect(ask(adapter, 'roots:accept', { path: HUB })).resolves.toEqual([HUB])
    expect(host().scanRoots).toEqual([HUB])
  })

  it('answers app:info with Helm’s own build and the host’s claude version', async () => {
    await expect(ask(world().adapter, 'app:info')).resolves.toEqual({ ...BUILD, claudeVersion: '2.1.5 (Claude Code)' })
    await expect(ask(world(null).adapter, 'app:info')).resolves.toEqual({ ...BUILD, claudeVersion: null })
  })
})
