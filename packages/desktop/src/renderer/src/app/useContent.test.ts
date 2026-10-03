import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConfigFileContent,
  ContentDirListing,
  ContentDocument,
  ContentFile,
  ContentScope,
  ContentTree
} from '@helm/core'
import { bridge } from './bridge.testkit'
import { useContent } from './useContent'

/**
 * The window's side of `content:*`, answered by handlers each test sets. What
 * the hook asked for is recorded, so a test can say a directory was read on
 * expand and not before.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))

const HARNESS: ContentScope = { kind: 'harness', path: 'C:\\vault', label: 'vault' }
const PROJECT: ContentScope = { kind: 'project', path: 'C:\\app', label: 'app' }

function file(scope: ContentScope, relPath: string): ContentFile {
  const name = relPath.split('/').at(-1) ?? relPath
  return {
    path: `${scope.path}\\${relPath.replaceAll('/', '\\')}`,
    relPath,
    root: relPath.split('/')[0] ?? '',
    rootKind: 'notes',
    kind: name.endsWith('.md') ? 'markdown' : 'source',
    slug: name.replace(/\.[^.]+$/, ''),
    ext: name.slice(name.lastIndexOf('.') + 1),
    title: name,
    size: 10,
    mtimeMs: 0,
    noteType: null,
    date: null,
    tags: []
  }
}

const treeOf = (scope: ContentScope, files: ContentFile[]): ContentTree => ({
  scope,
  roots: [],
  files,
  errors: [],
  scannedAt: '',
  tookMs: 0
})

const listingOf = (scope: ContentScope, relPath: string): ContentDirListing => ({
  scopePath: scope.path,
  relPath,
  entries: [],
  ignored: 0,
  ignoreSource: 'gitignore',
  error: null,
  tookMs: 0
})

const contentOf = (path: string, content: string): ConfigFileContent => ({
  path,
  exists: true,
  content,
  hash: `hash:${content}`,
  size: content.length,
  mtimeMs: 0,
  binary: false
})

const documentOf = (target: ContentFile, content: string): ContentDocument => ({
  file: target,
  content: contentOf(target.path, content),
  rendered: null,
  source: null,
  error: null
})

afterEach(() => {
  bridge.reset()
})

describe('useContent: curated or tree', () => {
  it('opens a harness as curated roots and a project as a tree, and remembers a choice per scope', async () => {
    bridge.answer('content:scopes', () => [HARNESS, PROJECT])
    bridge.answer('content:tree', ({ scopePath }) =>
      treeOf(scopePath === HARNESS.path ? HARNESS : PROJECT, [])
    )
    bridge.answer('content:dir', ({ relPath }) => listingOf(PROJECT, relPath))
    const { result } = renderHook(() => useContent())

    await waitFor(() => expect(result.current.scope?.path).toBe(HARNESS.path))
    expect([result.current.view, result.current.viewIsDefault]).toEqual(['curated', true])
    expect(bridge.invoked('content:dir')).toEqual([])

    act(() => result.current.setScopePath(PROJECT.path))
    expect([result.current.view, result.current.viewIsDefault]).toEqual(['tree', true])
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    expect(bridge.invoked('content:dir')).toEqual([{ scopePath: PROJECT.path, relPath: '' }])

    act(() => result.current.setView('curated'))
    expect([result.current.view, result.current.viewIsDefault]).toEqual(['curated', false])
    act(() => result.current.setScopePath(HARNESS.path))
    expect([result.current.view, result.current.viewIsDefault]).toEqual(['curated', true])
    act(() => result.current.setScopePath(PROJECT.path))
    expect([result.current.view, result.current.viewIsDefault]).toEqual(['curated', false])
  })

  it('reads a directory when it is expanded, and not before', async () => {
    let answer: (listing: ContentDirListing) => void = () => undefined
    bridge.answer('content:scopes', () => [PROJECT])
    bridge.answer('content:tree', () => treeOf(PROJECT, []))
    bridge.answer('content:dir', ({ relPath }) =>
      relPath === '' ? listingOf(PROJECT, '') : new Promise<ContentDirListing>((resolve) => (answer = resolve))
    )
    const { result } = renderHook(() => useContent())
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    expect(bridge.invoked('content:dir').map((call) => call.relPath)).toEqual([''])

    act(() => result.current.toggleDir('src'))
    expect(bridge.invoked('content:dir').map((call) => call.relPath)).toEqual(['', 'src'])
    expect(result.current.loadingDirs.has('src')).toBe(true)

    await act(async () => answer(listingOf(PROJECT, 'src')))
    expect(result.current.loadingDirs.has('src')).toBe(false)
    expect(result.current.dirs.has('src')).toBe(true)
  })
})

describe('useContent: the scope list', () => {
  it('asks for the scopes again on Refresh, so a new one appears in the switcher', async () => {
    let scopes = [HARNESS]
    const extra: ContentScope = { kind: 'project', path: 'C:\\elsewhere\\tooling', label: 'tooling' }
    bridge.answer('content:scopes', () => scopes)
    bridge.answer('content:tree', () => treeOf(HARNESS, []))
    const { result } = renderHook(() => useContent())
    await waitFor(() => expect(result.current.scopes).toEqual([HARNESS]))

    scopes = [HARNESS, extra]
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.scopes).toEqual([HARNESS, extra]))
  })
})

describe('useContent: opening and saving', () => {
  const first = file(HARNESS, 'notes/first.md')
  const second = file(HARNESS, 'notes/second.md')

  const serve = (): void => {
    bridge.answer('content:scopes', () => [HARNESS])
    bridge.answer('content:tree', () => treeOf(HARNESS, [first, second]))
    bridge.answer('content:snapshots', () => [])
    bridge.answer('config:watch', () => undefined)
    bridge.answer('content:document', ({ path }) =>
      path === first.path ? documentOf(first, '# First\n') : documentOf(second, '# Second\n')
    )
  }

  it('opens the note a wikilink resolves to, by the path main answers with', async () => {
    serve()
    bridge.answer('content:wikilink', ({ target }) => ({
      path: target === 'second' ? second.path : null
    }))
    const { result } = renderHook(() => useContent())
    await waitFor(() => expect(result.current.tree?.files).toHaveLength(2))

    act(() => result.current.select(first))
    await waitFor(() => expect(result.current.document?.file.path).toBe(first.path))

    act(() => result.current.openWikilink('second', null))
    await waitFor(() => expect(result.current.document?.file.path).toBe(second.path))
    expect(bridge.invoked('content:wikilink')).toEqual([{ scopePath: HARNESS.path, target: 'second', from: first.path }])
    expect(result.current.selected?.path).toBe(second.path)

    // A name nothing answers to opens nothing.
    act(() => result.current.openWikilink('nowhere', null))
    await waitFor(() => expect(bridge.invoked('content:wikilink')).toHaveLength(2))
    expect(result.current.selected?.path).toBe(second.path)
  })

  it('opens a note by path, as a resolved [[wikilink]] in a rendered note does', async () => {
    serve()
    const { result } = renderHook(() => useContent())
    await waitFor(() => expect(result.current.tree?.files).toHaveLength(2))

    act(() => result.current.select(first))
    await waitFor(() => expect(result.current.document?.file.path).toBe(first.path))
    act(() => result.current.openPath(second.path, null))
    await waitFor(() => expect(result.current.document?.content.content).toBe('# Second\n'))
  })

  it('saves against the hash it opened, then reads the file again', async () => {
    serve()
    bridge.answer('content:write', () => ({
      ok: true,
      file: contentOf(first.path, '# First, edited\n'),
      snapshotId: 1,
      unchanged: false
    }))
    const { result } = renderHook(() => useContent())
    await waitFor(() => expect(result.current.tree?.files).toHaveLength(2))
    act(() => result.current.select(first))
    await waitFor(() => expect(result.current.document?.file.path).toBe(first.path))
    const reads = bridge.invoked('content:document').length

    act(() => result.current.save('# First, edited\n'))
    await waitFor(() => expect(result.current.saving).toBe(false))
    expect(bridge.invoked('content:write')).toEqual([
      {
        scopePath: HARNESS.path,
        path: first.path,
        content: '# First, edited\n',
        expectedHash: 'hash:# First\n',
        reason: 'edit'
      }
    ])
    await waitFor(() => expect(bridge.invoked('content:document').length).toBeGreaterThan(reads))
  })
})
