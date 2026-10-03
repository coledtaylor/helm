import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { hashContent, openStore, readConfigFileContent, readConfigSnapshot } from '@helm/core'
import { createWorld, disposeWorld, seedSettings, type World } from '../../test/world'
import type { ConfigService } from './config'
import type { Services } from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The config console's main-process half against a project in a world of its
 * own: every write snapshots first, a write that cannot snapshot does not
 * happen, and the two MCP writes - one Helm makes, one it hands to the CLI -
 * leave a version behind them.
 */
describe('config service', () => {
  let world: World
  let services: Services
  let config: ConfigService
  let project: string

  beforeAll(async () => {
    world = createWorld()
    seedSettings(world)
    // The data directory and Claude's home are read when the modules load,
    // so the world is in place before they are imported.
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']
    project = world.projects.alpha

    const { createServices, runScan } = await import('./services')
    const { createConfigService } = await import('./config')
    const { setClaudeOverride } = await import('./claude-cli')
    setClaudeOverride(world.claude)
    services = createServices()
    await runScan(services, { includeGit: false })
    config = createConfigService({ services, onExternalChange: () => undefined })
  })

  afterAll(() => {
    config.stop()
    services.store.close()
    disposeWorld(world)
  })

  /** Every version of one file, oldest first, with its bytes. */
  const versions = (file: string): Array<{ reason: string; content: string }> =>
    config
      .snapshots(project, file)
      .map((meta) => readConfigSnapshot(services.store, meta.id))
      .filter((row) => row !== null)
      .reverse()
      .map((row) => ({ reason: row.reason, content: row.content }))

  it('snapshots the bytes a write replaces, and restore brings them back exactly', () => {
    const file = join(project, 'CLAUDE.md')
    const original = '# Alpha\r\n\r\nKeep the CRLF and the trailing space. \r\n'
    writeFileSync(file, original)

    const result = config.write({
      scopePath: project,
      path: file,
      content: '# Alpha\n\nRewritten.\n',
      expectedHash: hashContent(original),
      reason: 'edit'
    })
    expect(result.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('# Alpha\n\nRewritten.\n')
    expect(versions(file)).toEqual([{ reason: 'edit', content: original }])

    const restored = config.restore(result.snapshotId!, file)
    expect(restored.ok).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  it('writes nothing when the snapshot cannot be taken', async () => {
    const file = join(project, '.claude', 'settings.json')
    mkdirSync(join(project, '.claude'), { recursive: true })
    const original = '{ "model": "opus" }\n'
    writeFileSync(file, original)

    // A console whose snapshot table is gone: the database is closed.
    const { createConfigService } = await import('./config')
    const closed = openStore({ file: join(world.root, 'closed.db') })
    closed.close()
    const broken = createConfigService({
      services: { ...services, store: closed },
      onExternalChange: () => undefined
    })

    expect(() =>
      broken.write({
        scopePath: project,
        path: file,
        content: '{ "model": "haiku" }\n',
        expectedHash: hashContent(original),
        reason: 'edit'
      })
    ).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(original)
  })

  // The world's `claude` is a `.cmd` shim under a path with a space, which is
  // what an npm install in such a folder leaves. Through `cmd.exe /c` the JSON's
  // quotes used to cut that path in half before the CLI ever ran.
  it('snapshots .mcp.json, then lets the CLI write the server into it', async () => {
    expect(world.claude).toMatch(/ .*\.cmd$/)
    const file = join(project, '.mcp.json')
    const before = `${JSON.stringify({ mcpServers: { old: { command: 'old-server' } } }, null, 2)}\n`
    writeFileSync(file, before)
    const server = { command: 'node', args: ['C:\\Program Files\\srv\\server.mjs', '--name', 'a "quoted" word'] }

    const result = await config.mcpAdd({ scope: 'project', name: 'echo', json: JSON.stringify(server), cwd: project })

    expect(result, result.output).toMatchObject({ ok: true })
    expect(result.snapshotId).not.toBeNull()
    expect(readConfigSnapshot(services.store, result.snapshotId!)).toMatchObject({ reason: 'mcp', content: before })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { old: { command: 'old-server' }, echo: server }
    })
    expect(result.after).toBe(readFileSync(file, 'utf8'))
  })

  it('approves a server in settings.local.json through a snapshotted write', () => {
    const file = join(project, '.claude', 'settings.local.json')
    const before = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2)}\n`
    writeFileSync(file, before)

    const result = config.mcpApprove({ cwd: project, name: 'echo', approved: true })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      enabledMcpjsonServers: ['echo']
    })
    expect(readConfigSnapshot(services.store, result.snapshotId!)).toMatchObject({
      reason: 'approve',
      content: before
    })
    expect(readConfigFileContent(file).hash).toBe(result.file.hash)
  })

  it('creates settings.local.json for an approval when there is none, recording that it was absent', () => {
    const other = world.projects.beta
    const file = join(other, '.claude', 'settings.local.json')
    expect(existsSync(file)).toBe(false)

    const result = config.mcpApprove({ cwd: other, name: 'echo', approved: true })

    expect(result.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ enabledMcpjsonServers: ['echo'] })
    expect(readConfigSnapshot(services.store, result.snapshotId!)).toMatchObject({ reason: 'create', content: '' })
  })
})
