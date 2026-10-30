import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@helm/core'
import { FakeConnection, fakeLink, reconnectingLink } from '../../../test/host-connection'
import type { HostLink } from './link'
import type * as P from './protocol'
import { createHostWorkspace } from './workspace'

const HUB = resolve('/work dir/hub')
const ALPHA = resolve('/work dir/hub/repos/alpha')
const ELSEWHERE = resolve('/work dir/elsewhere')
const PICKED = resolve('/tools dir/claude.exe')

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

const git = (dirty: number, error: string | null = null): P.GitState => ({
  branch: 'main',
  detached: false,
  dirty,
  ahead: 0,
  behind: 0,
  error
})

const project = (path: string, state: P.GitState | null): P.Project => ({
  path,
  name: 'alpha',
  kind: 'repo',
  harnessPath: HUB,
  hasClaudeDir: true,
  inventory: {
    skills: 0,
    commands: 0,
    agents: 0,
    hooks: false,
    settings: false,
    claudeMd: true,
    mcp: false
  },
  git: state
})

const scanResult = (dirty: number): P.DiscoveryResult => ({
  roots: [HUB],
  harnesses: [],
  projects: [project(ALPHA, git(dirty))],
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
  configDir: resolve('/fixture home/.claude'),
  configDirExists: true,
  signedIn: { state: 'unknown' },
  signInSignal: 'no sign-in artefact was found',
  error: null,
  ...patch
})

const LISTING: P.TemplateListing = {
  templates: [],
  dir: resolve('/fixture home/.config/helm/templates'),
  problems: []
}

/** Helm's own settings, which `writeOwn` writes as the store would. */
function ownSettings(patch: Partial<AppSettings> = {}) {
  let settings: AppSettings = { ...DEFAULT_SETTINGS, ...patch }
  const writes: Array<Partial<AppSettings>> = []
  return {
    own: () => settings,
    writeOwn: (next: Partial<AppSettings>) => {
      writes.push(next)
      settings = { ...settings, ...next }
      return settings
    },
    writes
  }
}

function world(
  connection: FakeConnection | null = new FakeConnection(),
  own = ownSettings(),
  link: HostLink & { connect?: () => Promise<void> } = fakeLink(connection, UNREACHABLE)
) {
  let host = hostSettings()
  connection
    ?.answer('settings:read', () => host)
    .answer('settings:write', (patch) => (host = { ...host, ...patch }))
    .answer('discovery:cached', () => [
      {
        ...project(ALPHA, git(1, null)),
        lastSeenAt: '2026-10-29T10:00:00.000Z',
        template: null
      }
    ])
    .answer('discovery:scan', () => scanResult(2))
    .answer('git:refresh', () => ({ [ALPHA]: git(5) }))
    .answer('roots:suggest', () => [HUB])
    .answer('roots:accept', ({ path }) => (host = { ...host, scanRoots: [...host.scanRoots, path] }).scanRoots)
    .answer(
      'roots:remove',
      ({ path }) =>
        (host = {
          ...host,
          scanRoots: host.scanRoots.filter((r) => r !== path)
        }).scanRoots
    )
    .answer('setup:status', () => ({ backends: { 'claude-code': backend() } }))
    .answer('setup:locateBackend', () => backend())
    .answer('setup:complete', () => (host = { ...host, firstRunCompletedAt: '2026-10-30T11:00:00.000Z' }))
    .answer('harness:create', ({ dir }) => ({
      path: resolve(dir, 'hub'),
      created: ['harness.yaml'],
      problems: [],
      roots: [HUB]
    }))
    .answer('template:list', () => LISTING)
    .answer(
      'template:preview',
      ({ template }) => ({ template, files: [], problems: [] }) as unknown as P.TemplatePreview
    )
    .answer(
      'template:create',
      ({ name }) =>
        ({
          ok: true,
          template: name,
          problems: []
        }) as unknown as P.TemplateWriteResult
    )
    .answer('template:delete', () => ({ ok: true, problems: [] }) as unknown as P.TemplateDeleteResult)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const picked: string[] = []
  const workspace = createHostWorkspace({
    link,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    own: own.own,
    writeOwn: own.writeOwn,
    claudePicked: (path) => {
      picked.push(path)
      own.writeOwn({ claudePath: path })
    },
    log: () => undefined
  })
  return {
    connection: connection ?? new FakeConnection(),
    link,
    workspace,
    emitted,
    picked,
    own,
    host: () => host,
    setHost: (next: P.HostSettings) => {
      host = next
    }
  }
}

describe('the workspace through the local host', () => {
  it('reaches the host on each channel with the generated payload', async () => {
    const w = world()
    const ws = w.workspace
    await ws.cached()
    await ws.scan(true)
    await ws.suggestRoots()
    await ws.acceptRoots([HUB, ELSEWHERE])
    await ws.removeRoot(ELSEWHERE)
    await ws.setupStatus()
    await ws.locateClaude(PICKED)
    await ws.completeSetup()
    await ws.createHarness({
      mode: 'new',
      dir: ELSEWHERE,
      template: 'minimal'
    })
    await ws.createHarness({
      mode: 'convert',
      dir: HUB,
      name: 'Hub',
      template: 'ignored'
    })
    await ws.refreshGit()
    await ws.templates.list()
    await ws.templates.preview({ template: 'minimal' })
    await ws.templates.create({ name: 'mine' })
    await ws.templates.remove('mine')

    const p = (channel: string): unknown[] => w.connection.payloads(channel)
    expect(p('discovery:cached')).toEqual([null])
    expect(p('discovery:scan')).toEqual([{ includeGit: true }])
    expect(p('roots:suggest')).toEqual([null])
    expect(p('roots:accept')).toEqual([{ path: HUB }, { path: ELSEWHERE }])
    expect(p('roots:remove')).toEqual([{ path: ELSEWHERE }])
    expect(p('setup:status')).toEqual([null])
    expect(p('setup:locateBackend')).toEqual([{ backend: 'claude-code', path: PICKED }])
    expect(p('setup:complete')).toEqual([null])
    // Every field the window left out is said; a template is for a new harness only.
    expect(p('harness:create')).toEqual([
      { mode: 'new', dir: ELSEWHERE, name: null, template: 'minimal' },
      { mode: 'convert', dir: HUB, name: 'Hub', template: null }
    ])
    expect(p('git:refresh')).toEqual([null])
    expect(p('template:list')).toEqual([null])
    expect(p('template:preview')).toEqual([{ template: 'minimal', mode: null }])
    expect(p('template:create')).toEqual([{ name: 'mine', label: null, description: null }])
    expect(p('template:delete')).toEqual([{ template: 'mine' }])
  })

  it('answers the host’s scan and cache in the window’s words, and keeps the scan for what main asks', async () => {
    const w = world()
    expect(w.workspace.lastScan()).toBeNull()
    const cached = await w.workspace.cached()
    // A repository git answered has no `error` at all.
    expect(cached[0]?.git).toEqual({
      branch: 'main',
      detached: false,
      dirty: 1,
      ahead: 0,
      behind: 0
    })
    expect(w.workspace.knownProject(ALPHA.toUpperCase())).toBe(ALPHA)

    const result = await w.workspace.scan(true)
    expect(result.projects[0]?.git).not.toHaveProperty('error')
    expect(w.workspace.lastScan()?.projects.map((p) => p.path)).toEqual([ALPHA])
    expect(w.workspace.knownProject(ALPHA)).toBe(ALPHA)
    expect(w.workspace.knownProject(ELSEWHERE)).toBeNull()
  })

  it('gives a window that asks before the first connect the host’s answers, not an empty list first', async () => {
    const w = world()
    expect(w.link.current()).toBeNull()
    const [cached, suggestions, status, listing] = await Promise.all([
      w.workspace.cached(),
      w.workspace.suggestRoots(),
      w.workspace.setupStatus(),
      w.workspace.templates.list()
    ])
    expect(cached.map((row) => row.path)).toEqual([ALPHA])
    expect(suggestions).toEqual([HUB])
    expect(status.version).toBe('2.1.5 (Claude Code)')
    expect(listing).toEqual(LISTING)
    // The host's settings were read, and its events subscribed, before any of them was asked.
    expect(w.connection.sent[0]?.channel).toBe('settings:read')
    expect([...w.connection.subscriptions.keys()].sort()).toEqual([
      'discovery:updated',
      'git:updated',
      'scan:status',
      'settings:changed'
    ])
  })

  it('says the link’s sentence when the host cannot be reached, never no projects, suggestions or templates', async () => {
    const own = ownSettings({
      scanRoots: [HUB],
      firstRunCompletedAt: '2026-01-01T00:00:00.000Z'
    })
    const w = world(null, own)
    await expect(w.workspace.cached()).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.scan(true)).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.suggestRoots()).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.setupStatus()).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.templates.list()).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.templates.detail('mine')).rejects.toThrow(UNREACHABLE)
    await expect(w.workspace.acceptRoots([ELSEWHERE])).rejects.toThrow(UNREACHABLE)
    // The window still paints, from Helm's own settings.
    expect(await w.workspace.settings()).toEqual(own.own())
  })

  it('copies Helm’s scan roots, pins and finished setup to a host that was never set up, once, before answering', async () => {
    const own = ownSettings({
      scanRoots: [HUB],
      pinnedProjects: [ALPHA],
      firstRunCompletedAt: '2026-01-01T00:00:00.000Z'
    })
    const first = new FakeConnection()
    const link = reconnectingLink(first)
    const w = world(first, own, link)
    const settings = await w.workspace.settings()
    expect(first.payloads('settings:write')).toEqual([
      {
        scanRoots: [HUB],
        pinnedProjects: [ALPHA],
        firstRunCompletedAt: '2026-01-01T00:00:00.000Z'
      }
    ])
    expect(settings).toMatchObject({
      scanRoots: [HUB],
      pinnedProjects: [ALPHA],
      firstRunCompletedAt: '2026-01-01T00:00:00.000Z'
    })

    // A host that has its own roots is never written over, on this connect or a later one.
    const second = new FakeConnection()
      .answer('settings:read', () => hostSettings({ scanRoots: [ELSEWHERE] }))
      .answer('settings:write', () => hostSettings())
    await link.reconnect(second)
    expect(second.payloads('settings:write')).toEqual([])
    expect((await w.workspace.settings()).scanRoots).toEqual([ELSEWHERE])
  })

  it('copies nothing when Helm itself was never set up', async () => {
    const w = world()
    await w.workspace.settings()
    expect(w.connection.payloads('settings:write')).toEqual([])
  })

  it('writes the workspace keys to the host and every other key to Helm, and lays the host’s over Helm’s', async () => {
    const w = world()
    const after = await w.workspace.writeSettings({
      theme: 'light',
      density: 'compact',
      pinnedProjects: [ALPHA]
    })
    expect(w.connection.payloads('settings:write')).toEqual([{ pinnedProjects: [ALPHA] }])
    expect(w.own.writes).toEqual([{ theme: 'light', density: 'compact' }])
    expect(after).toMatchObject({
      theme: 'light',
      density: 'compact',
      pinnedProjects: [ALPHA]
    })
    // Helm's database never holds the host's keys.
    expect(w.own.own().pinnedProjects).toEqual([])

    // A window-only change asks nothing of the host.
    await w.workspace.writeSettings({ theme: 'dark' })
    expect(w.connection.payloads('settings:write')).toHaveLength(1)
    expect(w.workspace.overlay(w.own.own())).toMatchObject({
      theme: 'dark',
      pinnedProjects: [ALPHA]
    })
  })

  it('relays the host’s four events in the window’s words, and subscribes again after a reconnect', async () => {
    const first = new FakeConnection()
    const link = reconnectingLink(first)
    const w = world(first, ownSettings(), link)
    await w.workspace.settings()

    first.push('scan:status', { running: true, error: null })
    first.push('discovery:updated', scanResult(3))
    first.push('git:updated', { [ALPHA]: git(4, 'git timed out') })
    first.push('scan:status', { running: false, error: 'The scan failed.' })
    first.push('settings:changed', hostSettings({ scanRoots: [HUB] }))
    expect(w.emitted.map((e) => e.channel)).toEqual([
      'scan:status',
      'discovery:updated',
      'git:updated',
      'scan:status',
      'settings:changed'
    ])
    expect(w.emitted[0]?.payload).toEqual({ running: true })
    expect(w.emitted[2]?.payload).toEqual({
      [ALPHA]: { ...git(4), error: 'git timed out' }
    })
    expect(w.emitted[3]?.payload).toEqual({
      running: false,
      error: 'The scan failed.'
    })
    expect(w.emitted[4]?.payload).toMatchObject({
      ...DEFAULT_SETTINGS,
      scanRoots: [HUB]
    })
    // The scan kept for main follows the git reading.
    expect(w.workspace.lastScan()?.projects[0]?.git?.dirty).toBe(4)

    const second = new FakeConnection().answer('settings:read', () => hostSettings())
    await link.reconnect(second)
    expect([...first.subscriptions.keys()]).toEqual([])
    second.push('discovery:updated', scanResult(6))
    expect(w.emitted.at(-1)?.channel).toBe('discovery:updated')
    expect(w.workspace.lastScan()?.projects[0]?.git?.dirty).toBe(6)

    w.workspace.shutdown()
    expect([...second.subscriptions.keys()]).toEqual([])
  })

  it('answers setup with the host’s reading of Claude Code, and Unknown where the host has no Claude Code', async () => {
    const w = world()
    expect(await w.workspace.setupStatus()).toEqual({
      path: PICKED,
      source: 'setting',
      version: '2.1.5 (Claude Code)',
      semver: '2.1.5',
      tested: true,
      testedRange: { min: '2.1.0', max: '2.2.0' },
      configDir: resolve('/fixture home/.claude'),
      configDirExists: true,
      auth: 'unknown',
      authSignal: 'no sign-in artefact was found',
      error: null
    })
    w.connection.answer('setup:status', () => ({
      backends: {
        'claude-code': backend({ signedIn: { state: 'known', value: true } })
      }
    }))
    expect((await w.workspace.setupStatus()).auth).toBe('authenticated')
    w.connection.answer('setup:status', () => ({
      backends: {
        'claude-code': backend({ signedIn: { state: 'known', value: false } })
      }
    }))
    expect((await w.workspace.setupStatus()).auth).toBe('unauthenticated')

    w.connection.answer('setup:status', () => ({ backends: {} }))
    const unknown = await w.workspace.setupStatus()
    expect(unknown).toMatchObject({
      path: null,
      version: null,
      auth: 'unknown'
    })
    expect(unknown.error).toMatch(/no Claude Code backend/)
  })

  it('keeps a picked executable in Helm’s Settings only once the host checked and kept it', async () => {
    const w = world()
    w.connection.answer('setup:locateBackend', () =>
      backend({
        path: null,
        installed: false,
        error: 'It did not answer a version.'
      })
    )
    expect((await w.workspace.locateClaude(PICKED)).error).toBe('It did not answer a version.')
    expect(w.picked).toEqual([])

    w.connection.answer('setup:locateBackend', () => backend())
    expect((await w.workspace.locateClaude(PICKED)).path).toBe(PICKED)
    expect(w.picked).toEqual([PICKED])
    expect(w.emitted.at(-1)).toMatchObject({
      channel: 'settings:changed',
      payload: { claudePath: PICKED }
    })
  })

  it('finishes setup on the host, so the next start does not show it', async () => {
    const w = world()
    const after = await w.workspace.completeSetup()
    expect(after.firstRunCompletedAt).toBe('2026-10-30T11:00:00.000Z')
    expect(w.own.own().firstRunCompletedAt).toBeNull()
  })
})
