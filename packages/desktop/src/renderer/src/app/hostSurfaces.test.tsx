import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ArchiveStats,
  ConfigFile,
  ConfigFileContent,
  ConfigScope,
  ContentScope,
  FileView,
  HistoryPage,
  HistorySession,
  HistorySummary,
  SessionRecord
} from '@helm/core'
import type { PluginInfo } from '../../../shared/ipc'
import { bridge, remoteBridge, type Invocation } from './bridge.testkit'
import { noteDocument } from './document.testkit'
import { useConfig } from './useConfig'
import { useDocument } from './useDocument'
import { fileKey, useFiles } from './useFiles'
import { useHistory } from './useHistory'
import { useHostPlugins, usePlugins } from './usePlugins'
import { usePluginSettings } from './usePluginSettings'

/**
 * History, Config, Files, a note and Settings > Plugins pointed at a host on
 * another computer: every read and write goes through that host's bridge, and
 * this PC's is asked nothing of it. Each host is played by its own fake bridge.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))
vi.mock('./terminals', () => ({ estimateGrid: () => ({ cols: 100, rows: 30 }) }))

const BUILD_BOX = 'h1'
const buildBox = remoteBridge(BUILD_BOX)

/** What this PC's bridge was asked, leaving out what it is always asked whichever host is shown. */
const askedHere = (): Invocation[] =>
  bridge.invocations.filter(
    (call) => call.channel !== 'files:editor' && !(call.channel === 'files:watch' && call.payload.roots.length === 0)
  )

beforeEach(() => {
  bridge.whenUnanswered('pending')
  buildBox.whenUnanswered('pending')
})

afterEach(() => {
  bridge.reset()
  buildBox.reset()
})

describe('History on build-box', () => {
  const summary = { sessions: 3, indexedBytes: 10, historyFile: '/home/you/.claude/history.jsonl' } as HistorySummary
  const session = { sessionId: 'conv-1', resumable: true } as unknown as HistorySession
  const page = { sessions: [session] } as unknown as HistoryPage
  const record = { id: 41, cwd: '/home/you/work/infra' } as SessionRecord

  it('lists build-box’s sessions and resumes there, asking this PC nothing', async () => {
    buildBox.answer('history:summary', () => summary)
    buildBox.answer('archive:stats', () => ({ sessions: 0, messages: 0 }) as unknown as ArchiveStats)
    buildBox.answer('history:sessions', () => page)
    buildBox.answer('history:resume', () => ({ session: record }) as never)
    const { result } = renderHook(() => useHistory(BUILD_BOX))
    await waitFor(() => expect(result.current.summary?.historyFile).toBe('/home/you/.claude/history.jsonl'))

    let resumed: SessionRecord | null = null
    await act(async () => {
      resumed = await result.current.resume(session, null)
    })
    expect(resumed).toBe(record)
    expect(buildBox.invoked('history:resume')).toEqual([{ sessionId: 'conv-1', cols: 100, rows: 30 }])
    expect(askedHere()).toEqual([])
  })

  it('says why build-box’s history cannot be read, and shows none of this PC’s', async () => {
    bridge.answer('history:summary', () => ({ ...summary, historyFile: 'C:\\Users\\you\\.claude\\history.jsonl' }))
    buildBox.answer('history:summary', () => {
      throw new Error('build-box is not connected.')
    })
    const { result } = renderHook(() => useHistory(BUILD_BOX))
    await waitFor(() => expect(result.current.error).toContain('build-box is not connected.'))
    expect(result.current.summary).toBeNull()
    expect(askedHere()).toEqual([])
  })

  it('switched back to this PC, drops what build-box showed before this PC answers', async () => {
    buildBox.answer('history:summary', () => summary)
    const { result, rerender } = renderHook(({ host }) => useHistory(host), { initialProps: { host: BUILD_BOX } })
    await waitFor(() => expect(result.current.summary).toBe(summary))
    rerender({ host: 'local' })
    expect(result.current.summary).toBeNull()
  })
})

describe('Config on build-box', () => {
  const USER: ConfigScope = {
    kind: 'user',
    path: '/home/you/.claude',
    claudeDir: '/home/you/.claude',
    label: 'User',
    exists: true
  }
  const SETTINGS: ConfigFile = {
    path: '/home/you/.claude/settings.json',
    relPath: 'settings.json',
    kind: 'settings',
    name: 'settings.json',
    size: 2,
    mtimeMs: 0,
    description: null,
    binary: false
  }
  const content: ConfigFileContent = {
    path: SETTINGS.path,
    exists: true,
    content: '{}',
    hash: 'b1',
    size: 2,
    mtimeMs: 0,
    binary: false
  }

  it('reads and writes build-box’s files only: the write is snapshotted there, not here', async () => {
    buildBox.answer('config:scopes', () => [USER])
    buildBox.answer('config:tree', () => ({ scope: USER, files: [SETTINGS], errors: [], scannedAt: '' }))
    buildBox.answer('config:read', () => content)
    buildBox.answer('config:snapshots', () => [])
    buildBox.answer('config:render', () => ({ markdown: null, code: null }))
    buildBox.answer('config:watch', () => undefined)
    buildBox.answer('config:write', () => ({ ok: true }) as never)
    const { result } = renderHook(() => useConfig(BUILD_BOX))
    await waitFor(() => expect(result.current.scopePath).toBe(USER.path))
    await waitFor(() => expect(result.current.tree?.files).toEqual([SETTINGS]))
    act(() => result.current.select(SETTINGS))
    await waitFor(() => expect(buildBox.invoked('config:read').length).toBeGreaterThan(0))
    await waitFor(() => expect(result.current.loaded?.hash).toBe('b1'))

    act(() => result.current.save('{"model":"opus"}'))
    expect(buildBox.invoked('config:write')).toEqual([
      { scopePath: USER.path, path: SETTINGS.path, content: '{"model":"opus"}', expectedHash: 'b1', reason: 'edit' }
    ])
    expect(askedHere()).toEqual([])
  })
})

describe('Files and a note on build-box', () => {
  const INFRA: ContentScope = { kind: 'project', path: '/home/you/work/infra', label: 'infra' }
  const NOTE = '/home/you/work/infra/notes/plan.md'
  const view = { path: NOTE, relPath: 'notes/plan.md', exists: true } as unknown as FileView

  it('lists build-box’s folders and reads its file tabs there', async () => {
    buildBox.answer('content:scopes', () => [INFRA])
    buildBox.answer('files:read', () => view)
    buildBox.answer('files:watch', () => undefined)
    const { result } = renderHook(() =>
      useFiles({
        host: BUILD_BOX,
        active: true,
        follow: null,
        shown: [{ root: INFRA.path, path: NOTE, host: BUILD_BOX }]
      })
    )
    await waitFor(() => expect(result.current.roots).toEqual([INFRA]))
    await waitFor(() => expect(result.current.root).toBe(INFRA.path))
    await waitFor(() => expect(result.current.tabs.get(fileKey(NOTE, BUILD_BOX))?.view).toBe(view))
    expect(buildBox.invoked('files:read')).toEqual([{ root: INFRA.path, path: NOTE }])
    expect(buildBox.invoked('files:watch').at(-1)).toEqual({ roots: [INFRA.path] })
    // This PC is only told it watches nothing, and asked what its editor is.
    expect(askedHere()).toEqual([])
    expect(result.current.host).toBe(BUILD_BOX)
  })

  it('saves a note on build-box only', async () => {
    const onDisk = noteDocument(NOTE, 'notes/plan.md', '# Plan\n', 'n1')
    buildBox.answer('content:document', () => onDisk)
    buildBox.answer('content:snapshots', () => [])
    buildBox.answer('content:write', () => ({ ok: true, unchanged: false, snapshotId: 1, file: onDisk.content }))
    const { result } = renderHook(() =>
      useDocument({ host: BUILD_BOX, scopePath: INFRA.path, path: NOTE, kind: 'markdown', editing: false, parked: null })
    )
    await waitFor(() => expect(result.current.document?.content.hash).toBe('n1'))
    act(() => result.current.save('# Plan\nship it\n'))
    expect(buildBox.invoked('content:write')[0]).toMatchObject({
      scopePath: INFRA.path,
      path: NOTE,
      expectedHash: 'n1',
      reason: 'edit'
    })
    expect(askedHere()).toEqual([])
  })
})

describe('Settings > Plugins on build-box', () => {
  const PLUGIN = '/home/you/plugins/trackr'
  const info = { path: PLUGIN, id: 'trackr', enabled: true, error: null, name: 'Trackr' } as PluginInfo

  it('lists build-box’s plugins, and every action it takes goes to build-box', async () => {
    buildBox.answer('plugins:list', () => [info])
    buildBox.answer('secrets:list', () => ({ available: true, secrets: [] }))
    buildBox.answer('plugins:add', () => ({ ok: true }) as never)
    buildBox.answer('plugins:setEnabled', () => undefined as never)
    buildBox.answer('plugins:reload', () => undefined as never)
    buildBox.answer('plugins:remove', () => undefined as never)
    buildBox.answer('plugins:setSetting', () => ({ ok: true }) as never)
    buildBox.answer('secrets:save', () => ({ available: true, secrets: [] }))
    const listed = renderHook(() => usePlugins(BUILD_BOX))
    await waitFor(() => expect(listed.result.current.list).toEqual([info]))
    expect(listed.result.current.live.get('trackr')).toBe(info)

    const { result } = renderHook(() => usePluginSettings(null, BUILD_BOX))
    await waitFor(() => expect(result.current.secrets).toEqual({ available: true, secrets: [] }))
    await act(async () => {
      result.current.add('/home/you/plugins/new')
      result.current.setEnabled(PLUGIN, false)
      result.current.reload(PLUGIN)
      result.current.remove(PLUGIN, [])
      await result.current.setSetting('trackr', 'team', 'core')
      await result.current.saveSecret({ key: 'token', value: 'v', hosts: ['https://api.example.com'], plugins: ['trackr'] })
    })
    expect(buildBox.invoked('plugins:add')).toEqual([{ path: '/home/you/plugins/new' }])
    expect(buildBox.invoked('plugins:setEnabled')).toHaveLength(1)
    expect(buildBox.invoked('plugins:reload')).toHaveLength(1)
    expect(buildBox.invoked('plugins:remove')).toHaveLength(1)
    expect(buildBox.invoked('plugins:setSetting')).toHaveLength(1)
    expect(buildBox.invoked('secrets:save')).toHaveLength(1)
    expect(askedHere()).toEqual([])
  })

  it('on this PC, adds a folder through this PC’s picker, asking build-box nothing', async () => {
    bridge.answer('secrets:list', () => ({ available: true, secrets: [] }))
    bridge.answer('plugins:add', () => ({ ok: true }) as never)
    const { result } = renderHook(() => usePluginSettings(null))
    await act(async () => {
      result.current.add()
    })
    expect(bridge.invoked('plugins:add')).toEqual([{}])
    expect(buildBox.invocations).toEqual([])
  })

  it('reads each connected host’s plugins for the rail through its own bridge', async () => {
    bridge.answer('plugins:list', () => [])
    buildBox.answer('plugins:list', () => [info])
    const { result, rerender } = renderHook(({ hosts }) => useHostPlugins(hosts), {
      initialProps: { hosts: [BUILD_BOX] as readonly string[] }
    })
    await waitFor(() => expect(result.current.get(BUILD_BOX)?.live.get('trackr')).toBe(info))
    expect(bridge.invoked('plugins:list')).toEqual([])
    rerender({ hosts: [] })
    expect(result.current.has(BUILD_BOX)).toBe(false)
  })
})
