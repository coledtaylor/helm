import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigScope, ConfigTree, FolderTemplatePreview, TemplateChoice, TemplateDetail } from '@helm/core'
import { bridge } from './bridge.testkit'
import { useTemplates } from './useTemplates'

vi.mock('./bridge', () => import('./bridge.testkit'))

const DIR = 'C:\\Users\\me\\.config\\helm\\templates'
const MINIMAL: TemplateChoice = { id: 'minimal', label: 'Minimal', description: null, order: null, builtIn: true }
const USER: ConfigScope = { kind: 'user', path: 'C:\\Users\\me\\.claude', claudeDir: 'C:\\Users\\me\\.claude', label: 'User', exists: true }
const HUB: ConfigScope = { kind: 'harness', path: 'C:\\work\\hub', claudeDir: 'C:\\work\\hub\\.claude', label: 'hub', exists: true }
const SKILL = `${USER.path}\\skills\\think\\SKILL.md`

/**
 * Main's side of the template channels, over an in-memory templates folder:
 * every write changes it and `template:list` reads it back, so a hook that
 * patched its own copy instead of re-reading would show the difference.
 */
function answerTemplates(): Map<string, { label: string; description: string | null }> {
  const disk = new Map<string, { label: string; description: string | null }>([
    ['client', { label: 'Client work', description: 'Notes and tools.' }]
  ])
  const ok = (template: string) => ({ ok: true, template, problems: [] })
  bridge.answer('template:list', () => ({
    templates: [MINIMAL, ...[...disk].map(([id, meta]) => ({ id, ...meta, order: null, builtIn: false }))],
    dir: DIR,
    problems: []
  }))
  bridge.answer('template:detail', ({ template }): TemplateDetail => ({
    id: template,
    dir: `${DIR}\\${template}`,
    label: disk.get(template)?.label ?? template,
    description: disk.get(template)?.description ?? '',
    hasManifest: true,
    files: [],
    fileCount: 0,
    totalBytes: 0,
    modifiedAtMs: 0,
    problems: []
  }))
  bridge.answer('template:create', ({ name }) => {
    disk.set(name, { label: name, description: null })
    return ok(name)
  })
  bridge.answer('template:rename', ({ template, name }) => {
    const meta = disk.get(template)
    if (meta === undefined || disk.has(name)) return { ok: false, template: null, problems: [`${name} is taken.`] }
    disk.delete(template)
    disk.set(name, meta)
    return ok(name)
  })
  bridge.answer('template:metadata', ({ template, label, description }) => {
    disk.set(template, { label, description })
    return ok(template)
  })
  bridge.answer('template:delete', ({ template }) => {
    disk.delete(template)
    return { ok: true, template, problems: [] }
  })
  bridge.answer('template:substitute', () => ok('client'))
  bridge.answer('config:scopes', () => [USER, HUB])
  bridge.answer('config:tree', ({ scopePath }): ConfigTree => ({
    scope: scopePath === USER.path ? USER : HUB,
    files: [],
    errors: [],
    scannedAt: '2026-10-02T00:00:00.000Z'
  }))
  bridge.answer('template:import', () => ({
    ok: true,
    created: ['.claude/skills/think/SKILL.md', '.claude/skills/think/reference.md'],
    replaced: [],
    problems: []
  }))
  return disk
}

const ids = (choices: readonly TemplateChoice[]): string[] => choices.map((choice) => choice.id)

describe('useTemplates', () => {
  beforeEach(() => {
    bridge.reset()
  })

  /** The hook, with the manager open on `client` once its list has been read. */
  const managing = async () => {
    answerTemplates()
    const hook = renderHook(() => useTemplates())
    act(() => hook.result.current.openManager())
    await waitFor(() => expect(ids(hook.result.current.templates)).toEqual(['minimal', 'client']))
    act(() => hook.result.current.select('client'))
    await waitFor(() => expect(hook.result.current.detail?.id).toBe('client'))
    return hook
  }

  it('creates a template, selects it, and lists it from a fresh read', async () => {
    const { result } = await managing()
    act(() => result.current.create('acme'))

    await waitFor(() => expect(ids(result.current.templates)).toEqual(['minimal', 'client', 'acme']))
    expect(bridge.invoked('template:create')).toEqual([{ name: 'acme' }])
    expect(result.current.selected).toBe('acme')
    expect(result.current.notice).toBe('acme was created.')
  })

  it('saves a changed folder name as a rename and then the metadata, under the new name', async () => {
    const { result } = await managing()
    act(() => result.current.saveMetadata({ name: 'client-work', label: 'Client: work', description: 'Renamed.' }))

    await waitFor(() => expect(result.current.notice).toBe('Saved.'))
    expect(bridge.invocations.map((call) => call.channel).filter((channel) => /rename|metadata/.test(channel))).toEqual([
      'template:rename',
      'template:metadata'
    ])
    expect(bridge.invoked('template:rename')).toEqual([{ template: 'client', name: 'client-work' }])
    expect(bridge.invoked('template:metadata')).toEqual([
      { template: 'client-work', label: 'Client: work', description: 'Renamed.' }
    ])
    expect(result.current.selected).toBe('client-work')
    await waitFor(() =>
      expect(result.current.templates.find((choice) => choice.id === 'client-work')?.label).toBe('Client: work')
    )
  })

  it('writes no metadata when the rename is refused, and says why', async () => {
    const { result } = await managing()
    act(() => result.current.create('taken'))
    await waitFor(() => expect(result.current.selected).toBe('taken'))
    act(() => result.current.select('client'))

    act(() => result.current.saveMetadata({ name: 'taken', label: 'Client work', description: '' }))
    await waitFor(() => expect(result.current.problems).toEqual(['taken is taken.']))
    expect(bridge.invoked('template:metadata')).toEqual([])
    expect(result.current.selected).toBe('client')
  })

  it('deletes a template and drops it from a fresh read of the list', async () => {
    const { result } = await managing()
    act(() => result.current.remove('client'))

    await waitFor(() => expect(ids(result.current.templates)).toEqual(['minimal']))
    expect(bridge.invoked('template:delete')).toEqual([{ template: 'client' }])
    expect(result.current.selected).toBeNull()
  })

  it('offers the config console’s scopes, and copies the ticked files of one into the selected template', async () => {
    const { result } = await managing()
    await waitFor(() => expect(result.current.scopes).toEqual([USER, HUB]))

    act(() => result.current.setImportScope(USER.path))
    await waitFor(() => expect(result.current.importTree?.scope).toEqual(USER))
    act(() => result.current.importFiles([SKILL]))

    await waitFor(() => expect(result.current.notice).toBe('copied 2 in.'))
    expect(bridge.invoked('template:import')).toEqual([{ template: 'client', scopePath: USER.path, paths: [SKILL] }])
  })

  it('makes a file of the selected template substitutable', async () => {
    const { result } = await managing()
    act(() => result.current.makeSubstitutable('tools/run.mjs'))

    await waitFor(() =>
      expect(result.current.notice).toBe('tools/run.mjs is now tools/run.mjs.tpl, and its variables are filled in.')
    )
    expect(bridge.invoked('template:substitute')).toEqual([{ template: 'client', path: 'tools/run.mjs' }])
  })

  describe('importing a folder as a template', () => {
    const PREVIEW: FolderTemplatePreview = {
      dir: 'C:\\src\\kit',
      kind: 'folder',
      entries: [],
      fileCount: 3,
      totalBytes: 300,
      note: '',
      problems: []
    }

    it('asks for the folder, previews it, and writes the entries chosen', async () => {
      const { result } = await managing()
      bridge.answer('path:chooseDirectory', () => ({ path: PREVIEW.dir }))
      bridge.answer('template:folderPreview', () => PREVIEW)
      bridge.answer('template:fromFolder', ({ name }) => ({
        ok: true,
        template: name,
        problems: [],
        created: [],
        fileCount: 3,
        totalBytes: 300
      }))

      act(() => result.current.openImportFolder())
      await waitFor(() => expect(result.current.saveDialog).toEqual({ kind: 'folder', dir: PREVIEW.dir }))
      await waitFor(() => expect(result.current.savePreview).toEqual(PREVIEW))
      expect(bridge.invoked('template:folderPreview')).toEqual([{ dir: PREVIEW.dir, kind: 'folder' }])

      act(() => result.current.save({ name: 'kit', label: 'Kit', description: 'A kit.', include: ['.claude', 'notes'] }))
      await waitFor(() => expect(result.current.saveDialog).toBeNull())
      expect(bridge.invoked('template:fromFolder')).toEqual([
        { dir: PREVIEW.dir, kind: 'folder', name: 'kit', label: 'Kit', description: 'A kit.', include: ['.claude', 'notes'] }
      ])
      expect(result.current.selected).toBe('kit')
      expect(result.current.notice).toBe('kit was written - 3 files.')
    })

    it('opens no dialog when the folder picker is cancelled', async () => {
      const { result } = await managing()
      bridge.answer('path:chooseDirectory', () => ({ path: null }))

      act(() => result.current.openImportFolder())
      await waitFor(() => expect(bridge.invoked('path:chooseDirectory')).toHaveLength(1))
      await waitFor(() => expect(result.current.saveDialog).toBeNull())
      expect(bridge.invoked('template:folderPreview')).toEqual([])
    })
  })
})
