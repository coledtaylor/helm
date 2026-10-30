import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConfigFile, ConfigFileContent, ConfigScope, ConfigTree, DoctorReport, EffectiveView } from '@helm/core'
import { bridge } from './bridge.testkit'
import { useConfig } from './useConfig'

/**
 * The window's side of `config:*`, answered by handlers each test sets, with
 * every request recorded in order.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))

const USER: ConfigScope = { kind: 'user', path: 'C:\\home\\.claude', claudeDir: 'C:\\home\\.claude', label: 'User', exists: true }
const APP: ConfigScope = { kind: 'project', path: 'C:\\app', claudeDir: 'C:\\app\\.claude', label: 'app', exists: true }

function file(relPath: string, kind: ConfigFile['kind'], name: string): ConfigFile {
  return {
    path: `${APP.path}\\${relPath.replaceAll('/', '\\')}`,
    relPath,
    kind,
    name,
    size: 1,
    mtimeMs: 0,
    description: null,
    binary: false
  }
}

const SKILL = file('.claude/skills/think/SKILL.md', 'skill', 'think')
const PROMPTS = file('.claude/skills/think/prompts.md', 'other', 'prompts.md')
const PONDER = file('.claude/skills/ponder/SKILL.md', 'skill', 'ponder')
const COMMAND = file('.claude/commands/review/deep.md', 'command', 'review:deep')

const treeOf = (files: ConfigFile[]): ConfigTree => ({ scope: APP, files, errors: [], scannedAt: '' })

const viewFor = (cwd: string): EffectiveView => ({ cwd }) as EffectiveView

const contentOf = (path: string): ConfigFileContent => ({
  path,
  exists: true,
  content: 'body',
  hash: 'h',
  size: 4,
  mtimeMs: 0,
  binary: false
})

/** A console on the project scope, with whatever files `files()` says are there. */
async function openOnApp(files: () => ConfigFile[], scopes: ConfigScope[] = [USER, APP]) {
  bridge.answer('config:scopes', () => scopes)
  bridge.answer('config:tree', () => treeOf(files()))
  bridge.answer('config:read', ({ path }) => contentOf(path))
  bridge.answer('config:snapshots', () => [])
  bridge.answer('config:render', () => ({ markdown: null, code: null }))
  bridge.answer('config:effective', ({ cwd }) => viewFor(cwd ?? ''))
  bridge.answer('config:watch', () => undefined)
  const hook = renderHook(() => useConfig())
  await waitFor(() => expect(hook.result.current.scopePath).toBe(USER.path))
  act(() => hook.result.current.setScopePath(APP.path))
  await waitFor(() => expect(hook.result.current.tree?.scope).toBe(APP))
  return hook
}

afterEach(() => {
  bridge.reset()
})

describe('useConfig: create, rename, delete', () => {
  it('opens the file New created, ready to type in, and closes the dialog', async () => {
    let files = [SKILL, PROMPTS]
    const { result } = await openOnApp(() => files)
    bridge.answer('config:create', () => {
      files = [...files, COMMAND]
      return { ok: true, path: COMMAND.path, relPath: COMMAND.relPath, snapshotId: 1, error: null }
    })

    act(() => result.current.openEntryDialog('new'))
    act(() => result.current.createFile('command', 'review:deep'))
    await waitFor(() => expect(result.current.selected?.path).toBe(COMMAND.path))

    expect(bridge.invoked('config:create')).toEqual([{ scopePath: APP.path, kind: 'command', name: 'review:deep' }])
    expect(result.current.entryDialog).toBeNull()
    expect(result.current.createdPath).toBe(COMMAND.path)
  })

  it('keeps the New dialog open, with main’s reason, when the create is refused', async () => {
    const { result } = await openOnApp(() => [SKILL])
    bridge.answer('config:create', () => ({
      ok: false,
      path: null,
      relPath: null,
      snapshotId: null,
      error: 'That name is taken.'
    }))
    act(() => result.current.openEntryDialog('new'))
    act(() => result.current.createFile('skill', 'think'))
    await waitFor(() => expect(result.current.entryError).toBe('That name is taken.'))
    expect(result.current.entryDialog).toBe('new')
  })

  it('closes the rename dialog on success and lands on the renamed file', async () => {
    let files = [SKILL, PROMPTS]
    const { result } = await openOnApp(() => files)
    bridge.answer('config:rename', () => {
      files = [PONDER]
      return {
        ok: true,
        path: PONDER.path,
        relPath: PONDER.relPath,
        moved: [],
        snapshotIds: [],
        frontmatterRenamed: true,
        error: null
      }
    })

    act(() => result.current.select(SKILL))
    act(() => result.current.openEntryDialog('rename'))
    act(() => result.current.renameFile('ponder'))
    await waitFor(() => expect(result.current.selected?.path).toBe(PONDER.path))
    expect(result.current.entryDialog).toBeNull()
    expect(bridge.invoked('config:rename')).toEqual([{ scopePath: APP.path, path: SKILL.path, name: 'ponder' }])
  })

  it('leaves an Undo after a delete, which restores every file it removed, in order', async () => {
    let files = [SKILL, PROMPTS]
    const { result } = await openOnApp(() => files)
    bridge.answer('config:delete', () => {
      files = []
      return {
        ok: true,
        removed: [
          { path: SKILL.path, relPath: SKILL.relPath, snapshotId: 11 },
          { path: PROMPTS.path, relPath: PROMPTS.relPath, snapshotId: 12 }
        ],
        error: null
      }
    })
    bridge.answer('config:restore', ({ path }) => {
      files = [...files, path === SKILL.path ? SKILL : PROMPTS]
      return { ok: true, file: contentOf(path), snapshotId: 20, unchanged: false }
    })

    act(() => result.current.select(SKILL))
    act(() => result.current.openEntryDialog('delete'))
    act(() => result.current.deleteFile())
    await waitFor(() => expect(result.current.deleted?.label).toBe('think'))
    expect(result.current.entryDialog).toBeNull()
    expect(result.current.selected).toBeNull()

    act(() => result.current.undoDelete())
    await waitFor(() => expect(result.current.deleted).toBeNull())
    expect(bridge.invoked('config:restore')).toEqual([
      { id: 11, path: SKILL.path },
      { id: 12, path: PROMPTS.path }
    ])
    await waitFor(() => expect(result.current.selected?.path).toBe(SKILL.path))
  })
})

describe('useConfig: health', () => {
  it('runs claude doctor when asked and holds its report', async () => {
    const report: DoctorReport = { output: 'Version: 2.1.999', rows: [{ label: 'Version', value: '2.1.999' }], exitCode: 0, ranAt: '', durationMs: 5, error: null }
    let answer: (value: DoctorReport) => void = () => undefined
    const { result } = await openOnApp(() => [SKILL])
    bridge.answer('config:doctor', () => new Promise<DoctorReport>((resolve) => (answer = resolve)))
    expect(bridge.invoked('config:doctor')).toEqual([])

    act(() => result.current.runDoctor())
    expect(result.current.doctorRunning).toBe(true)
    expect(bridge.invoked('config:doctor')).toHaveLength(1)

    await act(async () => answer(report))
    expect(result.current.doctorRunning).toBe(false)
    expect(result.current.doctor).toEqual(report)
  })
})

describe('useConfig: could not look', () => {
  const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'
  const refuse = (): never => {
    throw new Error(`Error invoking remote method 'config:scopes': Error: ${UNREACHABLE}`)
  }

  it('says why the scopes could not be read, never an empty switcher', async () => {
    bridge.answer('config:scopes', refuse)
    bridge.answer('config:watch', () => undefined)
    const { result } = renderHook(() => useConfig())
    await waitFor(() => expect(result.current.listError).toBe(`Error: ${UNREACHABLE}`))
    expect(result.current.scopes).toEqual([])
    expect(result.current.treeLoading).toBe(false)
  })

  it('says why a scope’s files could not be read, rather than reading forever', async () => {
    const { result } = await openOnApp(() => [SKILL])
    expect(result.current.listError).toBeNull()
    bridge.answer('config:tree', () => {
      throw new Error(UNREACHABLE)
    })
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.listError).toBe(UNREACHABLE))
    expect(result.current.treeLoading).toBe(false)

    // Once the host answers again, so does the list.
    bridge.answer('config:tree', () => treeOf([SKILL]))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.tree?.files).toEqual([SKILL]))
    expect(result.current.listError).toBeNull()
  })

  it('says why a file’s versions could not be listed, never that it has none', async () => {
    const { result } = await openOnApp(() => [SKILL])
    bridge.answer('config:snapshots', () => {
      throw new Error(UNREACHABLE)
    })
    act(() => result.current.select(SKILL))
    await waitFor(() => expect(result.current.editorError).toBe(UNREACHABLE))
    expect(result.current.loaded?.path).toBe(SKILL.path)
  })
})

describe('useConfig: a credential file', () => {
  const CREDENTIALS = file('.credentials.json', 'other', '.credentials.json')

  it('selects .credentials.json without asking for its bytes, a watch or its versions', async () => {
    const { result } = await openOnApp(() => [SKILL, CREDENTIALS])
    act(() => result.current.select(SKILL))
    await waitFor(() => expect(result.current.loaded?.path).toBe(SKILL.path))
    const reads = bridge.invoked('config:read').length
    const listings = bridge.invoked('config:snapshots').length

    act(() => result.current.select(CREDENTIALS))
    await waitFor(() => expect(bridge.invoked('config:watch').at(-1)).toEqual({ path: null }))
    expect(result.current.selected).toBe(CREDENTIALS)
    expect(result.current.loaded).toBeNull()
    expect(bridge.invoked('config:read')).toHaveLength(reads)
    expect(bridge.invoked('config:snapshots')).toHaveLength(listings)
    expect(bridge.invoked('config:watch')).not.toContainEqual({ path: CREDENTIALS.path })
    expect(bridge.invoked('config:read')).not.toContainEqual({ path: CREDENTIALS.path })
  })
})

describe('useConfig: the scope list and live state', () => {
  it('asks for the scopes again on Refresh, so a new one appears in the switcher', async () => {
    let scopes = [USER, APP]
    const extra: ConfigScope = { ...APP, path: 'C:\\elsewhere\\tooling', claudeDir: 'C:\\elsewhere\\tooling\\.claude', label: 'tooling' }
    const { result } = await openOnApp(() => [SKILL])
    bridge.answer('config:scopes', () => scopes)

    scopes = [USER, APP, extra]
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.scopes).toEqual([USER, APP, extra]))
  })

  it('withholds live state while the resolution held is for another directory', async () => {
    let answer: (view: EffectiveView) => void = () => undefined
    const other: ConfigScope = { ...APP, path: 'C:\\other', claudeDir: 'C:\\other\\.claude', label: 'other' }
    const { result } = await openOnApp(() => [SKILL], [USER, APP, other])
    await waitFor(() => expect(result.current.live?.cwd).toBe(APP.path))

    bridge.answer('config:effective', () => new Promise<EffectiveView>((resolve) => (answer = resolve)))
    act(() => result.current.setScopePath(other.path))
    expect(result.current.live).toBeNull()
    // The effective tab still shows the last answer while it waits; the rows do not.
    expect(result.current.effective?.cwd).toBe(APP.path)

    await act(async () => answer(viewFor(other.path)))
    expect(result.current.live?.cwd).toBe(other.path)
  })
})
