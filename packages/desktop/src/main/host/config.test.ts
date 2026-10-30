import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import type { HostConnection } from './client'
import { createHostConfig, mergeConfigScopes, type ScannedFolder } from './config'
import type { HostLink } from './link'
import type * as P from './protocol'

const HOME = resolve('/fixture home/.claude')
const ALPHA = resolve('/work dir/alpha')
const HUB = resolve('/work dir/hub')
const OUTSIDE = resolve('/elsewhere/tooling')
const CLAUDE_MD = resolve(ALPHA, 'CLAUDE.md')

const scope = (kind: P.ConfigScopeKind, path: string, label: string): P.ConfigScope => ({
  kind,
  path,
  claudeDir: kind === 'user' ? path : resolve(path, '.claude'),
  label,
  exists: true
})

const USER = scope('user', HOME, 'User')

const content = (text: string, hash: string): P.ConfigFileContent => ({
  path: CLAUDE_MD,
  exists: true,
  content: text,
  hash,
  size: text.length,
  mtimeMs: 1_790_848_800_000.5,
  binary: false
})

const TREE: P.ConfigTree = {
  scope: scope('project', ALPHA, 'alpha'),
  files: [
    {
      path: CLAUDE_MD,
      relPath: 'CLAUDE.md',
      kind: 'claude-md',
      name: 'CLAUDE.md',
      size: 9,
      mtimeMs: 1,
      description: null,
      binary: false
    }
  ],
  errors: [],
  scannedAt: '2026-10-30T10:00:00.000Z'
}

const written = (result: Partial<P.WriteConfigResult>): P.WriteConfigResult => ({
  ok: true,
  file: content('new', 'h2'),
  snapshotId: 7,
  unchanged: false,
  conflict: null,
  error: null,
  ...result
})

const VERSION: P.ConfigSnapshotMeta = {
  id: 7,
  scopePath: ALPHA,
  filePath: 'CLAUDE.md',
  contentHash: 'h1',
  bytes: 3,
  reason: 'edit',
  createdAt: '2026-10-30T10:00:00.000Z'
}

const MCP: P.McpResult = { ok: true, output: 'Added', exitCode: 0, after: '{}', snapshotId: 8 }

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

/** The host side: one project with a CLAUDE.md, and one saved profile whose root is outside every scanned folder. */
function world(connection: FakeConnection | null = new FakeConnection(), scanned: ScannedFolder[] = []) {
  connection
    ?.answer('config:scopes', () => [USER, scope('project', OUTSIDE, 'tooling')])
    .answer('config:tree', () => TREE)
    .answer('config:read', () => content('old', 'h1'))
    .answer('config:render', ({ source }) => ({ markdown: null, code: { html: `<pre>${source}</pre>`, language: 'md', highlighted: true } }))
    .answer('config:write', () => written({}))
    .answer('config:snapshots', () => [VERSION])
    .answer('config:snapshot', ({ id }) => (id === 7 ? { content: 'old' } : null))
    .answer('config:restore', () => written({ snapshotId: 9, file: content('old', 'h1') }))
    .answer('config:watch', () => null)
    .answer('config:create', () => ({ ok: true, path: CLAUDE_MD, relPath: 'CLAUDE.md', snapshotId: 3, error: null }))
    .answer('config:rename', () => ({
      ok: true,
      path: CLAUDE_MD,
      relPath: 'CLAUDE.md',
      moved: [],
      snapshotIds: [4],
      frontmatterRenamed: false,
      error: null
    }))
    .answer('config:delete', () => ({ ok: true, removed: [{ path: CLAUDE_MD, relPath: 'CLAUDE.md', snapshotId: 5 }], error: null }))
    .answer('config:effective', ({ cwd }) => ({ cwd: cwd ?? '' }) as P.EffectiveView)
    .answer('config:mcpPreview', () => ({ file: '.mcp.json', before: '', after: '{}', diff: [], replaces: null, error: null }))
    .answer('config:mcpAdd', () => MCP)
    .answer('config:mcpRemove', () => MCP)
    .answer('config:mcpApprove', () => written({ snapshotId: 10 }))
    .answer('config:mcpList', () => MCP)
    .answer('config:doctor', () => ({ output: 'Version: 9', rows: [], exitCode: 0, ranAt: '', durationMs: 4, error: null }))
  const link = fakeLink(connection, UNREACHABLE)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const logged: string[] = []
  const config = createHostConfig({
    link,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    scanned: () => scanned,
    log: (line) => logged.push(line)
  })
  return { connection: connection ?? new FakeConnection(), link, config, emitted, logged }
}

/** A link whose connection can be replaced, the way a host that restarted is reached again. */
function reconnectingLink(first: FakeConnection) {
  const listeners: Array<(connection: HostConnection) => void | Promise<void>> = []
  let current = first
  let attempt: Promise<HostConnection> | null = null
  const connect = async (): Promise<HostConnection> => {
    for (const listener of listeners) await listener(current.asConnection())
    return current.asConnection()
  }
  const link: HostLink & { reconnect(next: FakeConnection): Promise<void> } = {
    connection: () => (attempt ??= connect()),
    current: () => current.asConnection(),
    settled: () => Promise.resolve(),
    onConnected: (listener) => {
      listeners.push(listener)
    },
    writeSettings: () => undefined,
    stop: () => Promise.resolve(),
    async reconnect(next) {
      current = next
      attempt = connect()
      await attempt
    }
  }
  return link
}

describe('the config console through the local host', () => {
  it('reaches the host on each channel with the generated payload, and answers in the window’s words', async () => {
    const w = world()
    const c = w.config

    expect(await c.tree(ALPHA)).toEqual(TREE)
    expect(await c.read(CLAUDE_MD)).toEqual(content('old', 'h1'))
    expect((await c.render(CLAUDE_MD, '# a')).code?.html).toBe('<pre># a</pre>')
    expect(await c.snapshots(ALPHA, CLAUDE_MD)).toEqual([VERSION])
    expect(await c.snapshot(7)).toEqual({ content: 'old' })
    expect(await c.snapshot(70)).toBeNull()
    expect((await c.create({ scopePath: ALPHA, kind: 'skill', name: 'think' })).snapshotId).toBe(3)
    expect((await c.rename({ scopePath: ALPHA, path: CLAUDE_MD, name: 'x' })).snapshotIds).toEqual([4])
    expect((await c.remove({ scopePath: ALPHA, path: CLAUDE_MD })).removed[0]?.snapshotId).toBe(5)
    expect((await c.effective({ cwd: ALPHA })).cwd).toBe(ALPHA)
    expect((await c.mcpPreview({ scope: 'project', name: 'n', json: '{}', cwd: ALPHA })).after).toBe('{}')
    expect(await c.mcpAdd({ scope: 'project', name: 'n', json: '{}', cwd: ALPHA })).toEqual(MCP)
    expect(await c.mcpRemove({ scope: 'project', name: 'n', cwd: ALPHA })).toEqual(MCP)
    expect((await c.mcpApprove({ cwd: ALPHA, name: 'n', approved: true })).snapshotId).toBe(10)
    expect(await c.mcpList(ALPHA)).toEqual(MCP)
    expect((await c.doctor()).output).toBe('Version: 9')
    await c.watch(CLAUDE_MD)

    const p = (channel: string): unknown[] => w.connection.payloads(channel)
    expect(p('config:tree')).toEqual([{ scopePath: ALPHA }])
    expect(p('config:read')).toEqual([{ path: CLAUDE_MD }])
    expect(p('config:render')).toEqual([{ path: CLAUDE_MD, source: '# a' }])
    expect(p('config:snapshots')).toEqual([{ scopePath: ALPHA, path: CLAUDE_MD }])
    expect(p('config:snapshot')).toEqual([{ id: 7 }, { id: 70 }])
    expect(p('config:create')).toEqual([{ scopePath: ALPHA, kind: 'skill', name: 'think' }])
    expect(p('config:rename')).toEqual([{ scopePath: ALPHA, path: CLAUDE_MD, name: 'x' }])
    expect(p('config:delete')).toEqual([{ scopePath: ALPHA, path: CLAUDE_MD }])
    // Every field the window left out is said, as the protocol has it.
    expect(p('config:effective')).toEqual([{ profileId: null, cwd: ALPHA, overlays: [] }])
    expect(p('config:mcpPreview')).toEqual([{ scope: 'project', name: 'n', json: '{}', cwd: ALPHA }])
    expect(p('config:mcpRemove')).toEqual([{ scope: 'project', name: 'n', cwd: ALPHA }])
    expect(p('config:mcpApprove')).toEqual([{ cwd: ALPHA, name: 'n', approved: true }])
    expect(p('config:mcpList')).toEqual([{ cwd: ALPHA }])
    expect(p('config:doctor')).toEqual([null])
    expect(p('config:watch')).toEqual([{ path: CLAUDE_MD }])
  })

  it('saves and restores through the host’s writer, with no conflict or error where the host said none', async () => {
    const w = world()
    const request = { scopePath: ALPHA, path: CLAUDE_MD, content: 'new', expectedHash: 'h1', reason: 'edit' as const }
    const saved = await w.config.write(request)
    expect(w.connection.payloads('config:write')).toEqual([request])
    expect(saved).toEqual({ ok: true, file: content('new', 'h2'), snapshotId: 7, unchanged: false })

    const restored = await w.config.restore(7, CLAUDE_MD)
    expect(w.connection.payloads('config:restore')).toEqual([{ id: 7, path: CLAUDE_MD }])
    expect(restored).toMatchObject({ ok: true, snapshotId: 9 })
    expect(restored).not.toHaveProperty('conflict')
    expect(restored).not.toHaveProperty('error')
  })

  it('answers a stale save with the host’s conflict, and a save it could not snapshot with the host’s sentence', async () => {
    const w = world()
    const request = { scopePath: ALPHA, path: CLAUDE_MD, content: 'mine', expectedHash: 'h1', reason: 'edit' as const }
    const onDisk = { onDiskHash: 'h3', onDiskContent: 'theirs', mtimeMs: 2.5 }
    w.connection.answer('config:write', () => written({ ok: false, snapshotId: null, conflict: onDisk, file: content('theirs', 'h3') }))
    const conflicted = await w.config.write(request)
    expect(conflicted).toMatchObject({ ok: false, snapshotId: null, conflict: onDisk })
    expect(conflicted).not.toHaveProperty('error')

    const sentence = 'Floti could not keep a version of CLAUDE.md, so it was not written: the database is read-only.'
    w.connection.answer('config:write', () => written({ ok: false, snapshotId: null, error: sentence, file: content('old', 'h1') }))
    const refused = await w.config.write(request)
    expect(refused).toMatchObject({ ok: false, snapshotId: null, error: sentence })
    expect(refused).not.toHaveProperty('conflict')
  })

  it('lists the user scope, then the scanned harnesses, then the scanned projects, then the profiles’ folders, each once', async () => {
    const scanned: ScannedFolder[] = [
      { path: ALPHA, kind: 'repo', name: 'alpha' },
      { path: HUB, kind: 'harness', name: 'hub' },
      // The profile's root is also a scanned project: listed once, where the scan puts it.
      { path: OUTSIDE.toUpperCase(), kind: 'folder', name: 'tooling' }
    ]
    const w = world(new FakeConnection(), scanned)
    const scopes = await w.config.scopes()
    expect(scopes.map((s) => [s.kind, s.label])).toEqual([
      ['user', 'User'],
      ['harness', 'hub'],
      ['project', 'alpha'],
      ['project', 'tooling']
    ])
    expect(scopes[1]).toMatchObject({ path: HUB, claudeDir: resolve(HUB, '.claude') })
    expect(w.connection.payloads('config:scopes')).toEqual([null])
  })

  it('merges a profile’s folders after the scan, deduped by resolved path ignoring case', () => {
    const merged = mergeConfigScopes(
      [USER, scope('project', `${ALPHA}${sep}`, 'alpha'), scope('project', OUTSIDE, 'tooling')],
      [{ path: ALPHA.toLowerCase(), kind: 'repo', name: 'alpha' }]
    )
    expect(merged.map((s) => s.label)).toEqual(['User', 'alpha', 'tooling'])
  })

  it('gives a window that asks before the first connect the host’s scopes and files, not an empty list first', async () => {
    const w = world(new FakeConnection(), [{ path: ALPHA, kind: 'repo', name: 'alpha' }])
    expect(w.link.current()).toBeNull()
    const [scopes, tree] = await Promise.all([w.config.scopes(), w.config.tree(ALPHA)])
    expect(scopes.map((s) => s.label)).toEqual(['User', 'alpha', 'tooling'])
    expect(tree.files.map((f) => f.relPath)).toEqual(['CLAUDE.md'])
    // The outside-change event was subscribed before either was answered.
    expect([...w.connection.subscriptions.keys()]).toEqual(['config:externalChange'])
  })

  it('says the link’s sentence when the host cannot be reached, never no scopes, no files or no versions', async () => {
    const w = world(null)
    await expect(w.config.scopes()).rejects.toThrow(UNREACHABLE)
    await expect(w.config.tree(ALPHA)).rejects.toThrow(UNREACHABLE)
    await expect(w.config.read(CLAUDE_MD)).rejects.toThrow(UNREACHABLE)
    await expect(w.config.snapshots(ALPHA, CLAUDE_MD)).rejects.toThrow(UNREACHABLE)
    await expect(
      w.config.write({ scopePath: ALPHA, path: CLAUDE_MD, content: 'x', expectedHash: 'h1', reason: 'edit' })
    ).rejects.toThrow(UNREACHABLE)
    await expect(w.config.doctor()).rejects.toThrow(UNREACHABLE)
  })

  it('hands the window each outside change the host sends, and stops when shut down', async () => {
    const w = world()
    await w.link.connect()
    const change: P.ConfigExternalChange = { path: CLAUDE_MD, hash: 'h9', exists: true, mtimeMs: 3.5 }
    w.connection.push('config:externalChange', change)
    expect(w.emitted).toEqual([{ channel: 'config:externalChange', payload: change }])

    w.config.shutdown()
    expect([...w.connection.subscriptions.keys()]).toEqual([])
  })

  it('tells a new connection which file the editor has open, and relays its changes', async () => {
    const first = new FakeConnection().answer('config:watch', () => null)
    const link = reconnectingLink(first)
    const emitted: Array<{ channel: string; payload: unknown }> = []
    const config = createHostConfig({
      link,
      emit: (channel, payload) => emitted.push({ channel, payload }),
      scanned: () => [],
      log: () => undefined
    })
    await config.watch(CLAUDE_MD)
    expect(first.payloads('config:watch')).toEqual([{ path: CLAUDE_MD }])

    const second = new FakeConnection().answer('config:watch', () => null)
    await link.reconnect(second)
    expect(second.payloads('config:watch')).toEqual([{ path: CLAUDE_MD }])
    const change: P.ConfigExternalChange = { path: CLAUDE_MD, hash: 'h9', exists: true, mtimeMs: 1 }
    second.push('config:externalChange', change)
    expect(emitted).toEqual([{ channel: 'config:externalChange', payload: change }])

    // A watch released is not made again on the next connection.
    await config.watch(null)
    const third = new FakeConnection()
    await link.reconnect(third)
    expect(third.payloads('config:watch')).toEqual([])
  })
})
