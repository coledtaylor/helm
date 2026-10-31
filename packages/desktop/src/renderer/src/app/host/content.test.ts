import { describe, expect, it } from 'vitest'
import type { Project } from '@helm/core/types'
import { FakeConnection, fakeReach, reconnectingReach } from '../../../../../test/fake-connection'
import type * as P from '../../../../shared/host/protocol'
import { configScopesWithScan, hostArtifactUrl, windowArtifactUrl } from '../../../../shared/host/records/content'
import type { EventChannel, EventPayload, RequestChannel, RequestPayload, RequestResult } from '../../../../shared/ipc'
import { createConfigAdapter } from './config'
import { createFilesAdapter } from './files'
import type { HostAdapter } from './router'

const HOME = '/fixture home/.claude'
const ALPHA = '/work dir/alpha'
const HUB = '/work dir/hub'
const OUTSIDE = '/elsewhere/tooling'
const CLAUDE_MD = '/work dir/alpha/CLAUDE.md'
const NOTE = '/work dir/alpha/notes/a.md'

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

const scope = (kind: P.ConfigScopeKind, path: string, label: string): P.ConfigScope => ({
  kind,
  path,
  claudeDir: kind === 'user' ? path : `${path}/.claude`,
  label,
  exists: true
})

const content = (text: string, hash: string): P.ConfigFileContent => ({
  path: CLAUDE_MD,
  exists: true,
  content: text,
  hash,
  size: text.length,
  mtimeMs: 1,
  binary: false
})

const written = (result: Partial<P.WriteConfigResult>): P.WriteConfigResult => ({
  ok: true,
  file: content('new', 'h2'),
  snapshotId: 7,
  unchanged: false,
  conflict: null,
  error: null,
  ...result
})

const folder = (path: string, kind: Project['kind'], name: string, claudeMd = true): Project => ({
  path,
  name,
  kind,
  harnessPath: null,
  hasClaudeDir: false,
  inventory: { skills: 0, commands: 0, agents: 0, hooks: false, settings: false, claudeMd, mcp: false },
  git: null
})

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

function configWorld(connection: FakeConnection | null = new FakeConnection(), scanned: Project[] = []) {
  connection
    ?.answer('config:scopes', () => [scope('user', HOME, 'User'), scope('project', OUTSIDE, 'tooling')])
    .answer('config:read', () => content('old', 'h1'))
    .answer('config:write', () => written({}))
    .answer('config:watch', () => null)
  const link = fakeReach(connection, UNREACHABLE)
  const adapter = createConfigAdapter({ link, scanned: () => Promise.resolve(scanned) })
  return { connection: connection ?? new FakeConnection(), link, adapter }
}

describe('the config console over the window’s own connection', () => {
  it('saves through the host’s writer, which snapshots first, and answers a stale save with its conflict', async () => {
    const { adapter, connection } = configWorld()
    const request = { scopePath: ALPHA, path: CLAUDE_MD, content: 'new', expectedHash: 'h1', reason: 'edit' as const }
    await expect(ask(adapter, 'config:write', request)).resolves.toEqual({
      ok: true,
      file: content('new', 'h2'),
      snapshotId: 7,
      unchanged: false
    })
    expect(connection.payloads('config:write')).toEqual([request])

    const onDisk = { onDiskHash: 'h3', onDiskContent: 'theirs', mtimeMs: 2.5 }
    connection.answer('config:write', () => written({ ok: false, snapshotId: null, conflict: onDisk }))
    const conflicted = await ask(adapter, 'config:write', request)
    expect(conflicted).toMatchObject({ ok: false, snapshotId: null, conflict: onDisk })
    expect(conflicted).not.toHaveProperty('error')
  })

  it('lists the user scope, then the scanned harnesses, then the scanned projects, then the profiles’ folders, each once', async () => {
    const { adapter } = configWorld(new FakeConnection(), [
      folder(ALPHA, 'repo', 'alpha'),
      folder(HUB, 'harness', 'hub', false),
      folder(OUTSIDE.toUpperCase(), 'folder', 'tooling')
    ])
    const scopes = await ask(adapter, 'config:scopes')
    expect(scopes.map((s) => [s.kind, s.label])).toEqual([
      ['user', 'User'],
      ['harness', 'hub'],
      ['project', 'alpha'],
      ['project', 'tooling']
    ])
    expect(scopes[1]).toEqual({ kind: 'harness', path: HUB, claudeDir: `${HUB}/.claude`, label: 'hub', exists: false })
  })

  it('tells apart paths that differ only by separators, a trailing one or case', () => {
    const merged = configScopesWithScan(
      [scope('user', HOME, 'User'), scope('project', 'C:\\work\\alpha\\', 'alpha'), scope('project', OUTSIDE, 'tooling')],
      [folder('c:/work/alpha', 'repo', 'alpha')]
    )
    expect(merged.map((s) => s.label)).toEqual(['User', 'alpha', 'tooling'])
    expect(merged[1]?.claudeDir).toBe('c:/work/alpha/.claude')
  })

  it('says the link’s sentence when the host cannot be reached, never no scopes or no files', async () => {
    const { adapter } = configWorld(null)
    await expect(ask(adapter, 'config:scopes')).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'config:read', { path: CLAUDE_MD })).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'config:snapshots', { scopePath: ALPHA, path: CLAUDE_MD })).rejects.toThrow(UNREACHABLE)
  })

  it('tells a new connection which file the editor has open, and hands the window its outside changes', async () => {
    const first = new FakeConnection().answer('config:watch', () => null)
    const link = reconnectingReach(first)
    const adapter = createConfigAdapter({ link, scanned: () => Promise.resolve([]) })
    const changes: unknown[] = []
    on(adapter, 'config:externalChange', (change) => changes.push(change))
    await ask(adapter, 'config:watch', { path: CLAUDE_MD })
    expect(first.payloads('config:watch')).toEqual([{ path: CLAUDE_MD }])

    const second = new FakeConnection().answer('config:watch', () => null)
    await link.reconnect(second)
    expect(second.payloads('config:watch')).toEqual([{ path: CLAUDE_MD }])
    const change: P.ConfigExternalChange = { path: CLAUDE_MD, hash: 'h9', exists: true, mtimeMs: 1 }
    second.push('config:externalChange', change)
    expect(changes).toEqual([change])

    await ask(adapter, 'config:watch', { path: null })
    const third = new FakeConnection()
    await link.reconnect(third)
    expect(third.payloads('config:watch')).toEqual([])
  })
})

describe('the Files view over the window’s own connection', () => {
  function filesWorld(connection: FakeConnection | null = new FakeConnection()) {
    connection
      ?.answer('content:write', () => written({}))
      .answer('content:artifact', () => ({ url: 'floti-artifact://tok123/report.html', token: 'tok123' }))
      .answer('content:wikilink', () => ({ path: NOTE }))
      .answer('files:status', () => ({
        root: ALPHA,
        repo: null,
        files: null,
        error: 'git could not be run'
      }))
      .answer('files:watch', () => null)
    return { connection: connection ?? new FakeConnection(), adapter: createFilesAdapter(fakeReach(connection, UNREACHABLE)) }
  }

  it('writes a note through the host’s writer and hands an artifact to the window on its own scheme', async () => {
    const { adapter, connection } = filesWorld()
    const request = { scopePath: ALPHA, path: NOTE, content: 'x', expectedHash: 'h1', reason: 'edit' as const }
    await expect(ask(adapter, 'content:write', request)).resolves.toMatchObject({ ok: true, snapshotId: 7 })
    expect(connection.payloads('content:write')).toEqual([request])
    await expect(ask(adapter, 'content:artifact', { scopePath: ALPHA, path: NOTE })).resolves.toEqual({
      url: 'helm-content://artifact/tok123/report.html',
      token: 'tok123'
    })
    await expect(ask(adapter, 'content:wikilink', { scopePath: ALPHA, target: 'a', from: NOTE })).resolves.toEqual({
      path: NOTE
    })
  })

  it('keeps a folder git could not read as could-not-look, never as no changes', async () => {
    const { adapter } = filesWorld()
    await expect(ask(adapter, 'files:status', { root: ALPHA })).resolves.toEqual({
      root: ALPHA,
      repo: null,
      files: null,
      error: 'git could not be run'
    })
  })

  it('says the link’s sentence when the host cannot be reached, never an empty folder', async () => {
    const { adapter } = filesWorld(null)
    await expect(ask(adapter, 'files:dir', { root: ALPHA, relPath: '' })).rejects.toThrow(UNREACHABLE)
    await expect(ask(adapter, 'content:scopes')).rejects.toThrow(UNREACHABLE)
  })

  it('tells the host the whole set it watches, again on a new connection, and passes on what changed', async () => {
    const first = new FakeConnection().answer('files:watch', () => null)
    const link = reconnectingReach(first)
    const adapter = createFilesAdapter(link)
    const changes: unknown[] = []
    on(adapter, 'files:changed', (change) => changes.push(change))
    await ask(adapter, 'files:watch', { roots: [ALPHA, HUB] })
    expect(first.payloads('files:watch')).toEqual([{ roots: [ALPHA, HUB] }])
    first.push('files:changed', { root: ALPHA, paths: null })

    const second = new FakeConnection().answer('files:watch', () => null)
    await link.reconnect(second)
    expect(second.payloads('files:watch')).toEqual([{ roots: [ALPHA, HUB] }])
    second.push('files:changed', { root: HUB, paths: [] })
    expect(changes).toEqual([
      { root: ALPHA, paths: null },
      { root: HUB, paths: [] }
    ])
  })

  it('maps an artifact’s address between the host’s scheme and the window’s', () => {
    expect(windowArtifactUrl('floti-artifact://t/a.html')).toBe('helm-content://artifact/t/a.html')
    expect(hostArtifactUrl('helm-content://artifact/t/a.html')).toBe('floti-artifact://t/a.html')
    expect(hostArtifactUrl('helm-content://elsewhere/a.html')).toBeNull()
    expect(() => windowArtifactUrl('https://example.invalid/a.html')).toThrow()
  })
})
