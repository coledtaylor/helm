import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentDirListing, FilesStatus, FileView } from '@helm/core'
import { bridge } from './bridge.testkit'
import { joinRoot, relativeTo, useFiles, type FilesOptions } from './useFiles'

/**
 * The window's side of `files:*`. What the hook asked main for is recorded, so
 * a test can say a folder was read on expand and not before, and that a
 * change main reported was read again.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))

const A = 'C:\\a'
const B = 'C:\\b'

const listing = (scopePath: string, relPath: string): ContentDirListing => ({
  scopePath,
  relPath,
  entries: [],
  ignored: 0,
  ignoreSource: 'gitignore',
  error: null,
  tookMs: 0
})

const status = (root: string): FilesStatus => ({ root, repo: root, files: {}, error: null })

const view = (root: string, path: string, content: string): FileView => ({
  root,
  path,
  relPath: relativeTo(root, path),
  exists: true,
  size: content.length,
  mtimeMs: 0,
  binary: false,
  tooLarge: false,
  content,
  eol: 'LF',
  changes: { kind: 'tracked', lines: { changed: [], removedAfter: [], changedCount: 0, removedCount: 0 } },
  error: null
})

const NONE: FilesOptions['shown'] = []

beforeEach(() => {
  bridge.answer('files:editor', () => ({ name: 'Visual Studio Code' }))
  bridge.answer('content:scopes', () => [
    { kind: 'project', path: A, label: 'a' },
    { kind: 'project', path: B, label: 'b' }
  ])
  bridge.answer('files:dir', ({ root, relPath }) => listing(root, relPath))
  bridge.answer('files:status', ({ root }) => status(root))
  bridge.answer('files:watch', () => undefined)
})

afterEach(() => {
  bridge.reset()
})

describe('useFiles: the sidebar', () => {
  it('follows the folder in front, reading its top level and its status and watching it', async () => {
    const { result, rerender } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: true, follow: A, shown: NONE }
    })
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    expect(result.current.root).toBe(A)
    expect(result.current.status?.root).toBe(A)
    expect(bridge.invoked('files:dir')).toEqual([{ root: A, relPath: '' }])
    await waitFor(() => expect(bridge.invoked('files:watch').at(-1)).toEqual({ roots: [A] }))
    expect(result.current.editor).toBe('Visual Studio Code')

    rerender({ active: true, follow: B, shown: NONE })
    expect(result.current.root).toBe(B)
    await waitFor(() => expect(result.current.status?.root).toBe(B))
    await waitFor(() => expect(bridge.invoked('files:watch').at(-1)).toEqual({ roots: [B] }))
  })

  it('drops a listing that arrives for the project it has just left', async () => {
    let late: (value: ContentDirListing) => void = () => undefined
    bridge.answer('files:dir', ({ root, relPath }) =>
      root === A ? new Promise<ContentDirListing>((resolve) => (late = resolve)) : listing(root, relPath)
    )
    const { result, rerender } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: true, follow: A, shown: NONE }
    })
    await waitFor(() => expect(bridge.invoked('files:dir')).toHaveLength(1))
    rerender({ active: true, follow: B, shown: NONE })
    await waitFor(() => expect(result.current.dirs.get('')?.scopePath).toBe(B))
    act(() => late(listing(A, '')))
    expect(result.current.dirs.get('')?.scopePath).toBe(B)
  })

  it('reads a folder when it is opened, not when it is closed, and keeps what is open per project', async () => {
    const { result, rerender } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: true, follow: A, shown: NONE }
    })
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    act(() => result.current.toggleDir('src'))
    await waitFor(() => expect(result.current.dirs.has('src')).toBe(true))
    expect([...result.current.expanded]).toEqual(['src'])
    act(() => result.current.toggleDir('src'))
    expect([...result.current.expanded]).toEqual([])
    expect(bridge.invoked('files:dir').filter((call) => call.relPath === 'src')).toHaveLength(1)

    act(() => result.current.toggleDir('src'))
    rerender({ active: true, follow: B, shown: NONE })
    expect([...result.current.expanded]).toEqual([])
    rerender({ active: true, follow: A, shown: NONE })
    expect([...result.current.expanded]).toEqual(['src'])
  })

  it('reveals a file: every folder down to it opened, and read once, on its project or another', async () => {
    const { result } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: true, follow: A, shown: NONE }
    })
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    act(() => result.current.toggleDir('src'))
    await waitFor(() => expect(result.current.dirs.has('src')).toBe(true))
    bridge.clearRecords()

    // The tree on screen reads what it opens, and not what was already open.
    act(() => result.current.reveal(A, `${A}\\src\\deep\\x.ts`))
    expect([...result.current.expanded]).toEqual(['src', 'src/deep'])
    await waitFor(() => expect(result.current.dirs.has('src/deep')).toBe(true))
    expect(bridge.invoked('files:dir')).toEqual([{ root: A, relPath: 'src/deep' }])

    // Another project: the tree moves to it and is read whole, once.
    bridge.clearRecords()
    act(() => result.current.reveal(B, `${B}\\lib\\y.ts`))
    expect(result.current.root).toBe(B)
    expect([...result.current.expanded]).toEqual(['lib'])
    await waitFor(() => expect(result.current.dirs.has('lib')).toBe(true))
    expect(bridge.invoked('files:dir')).toEqual([
      { root: B, relPath: '' },
      { root: B, relPath: 'lib' }
    ])
  })

  it('reads nothing for a reveal while the sidebar is away, and all of it when it comes back', async () => {
    const { result, rerender } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: false, follow: A, shown: NONE }
    })
    act(() => result.current.reveal(A, `${A}\\top.ts`))
    expect([...result.current.expanded]).toEqual([])
    act(() => result.current.reveal(A, `${A}\\src\\z.ts`))
    expect([...result.current.expanded]).toEqual(['src'])
    expect(bridge.invoked('files:dir')).toEqual([])

    rerender({ active: true, follow: A, shown: NONE })
    await waitFor(() => expect(result.current.dirs.has('src')).toBe(true))
    expect(bridge.invoked('files:dir')).toEqual([
      { root: A, relPath: '' },
      { root: A, relPath: 'src' }
    ])
  })

  it('reads again what a change under the project touched: the status and the folder it was in', async () => {
    const { result } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: true, follow: A, shown: NONE }
    })
    await waitFor(() => expect(result.current.dirs.has('')).toBe(true))
    act(() => result.current.toggleDir('src'))
    await waitFor(() => expect(result.current.dirs.has('src')).toBe(true))
    bridge.clearRecords()

    act(() => bridge.emit('files:changed', { root: A, paths: ['src/a.ts'] }))
    await waitFor(() => expect(bridge.invoked('files:status')).toHaveLength(1))
    expect(bridge.invoked('files:dir')).toEqual([{ root: A, relPath: 'src' }])

    bridge.clearRecords()
    act(() => bridge.emit('files:changed', { root: B, paths: ['x.ts'] }))
    expect(bridge.invoked('files:status')).toEqual([])
  })
})

describe('useFiles: file tabs', () => {
  it('reads a file when its tab is shown, again when it changes or the repository moves, and watches its project', async () => {
    const path = joinRoot(A, 'src/a.ts')
    let content = 'one\n'
    bridge.answer('files:read', ({ root, path: at }) => view(root, at, content))
    const { result } = renderHook((options: FilesOptions) => useFiles(options), {
      initialProps: { active: false, follow: null, shown: [{ root: A, path }] }
    })
    await waitFor(() => expect(result.current.tabs.get(path.toLowerCase())?.view?.content).toBe('one\n'))
    await waitFor(() => expect(bridge.invoked('files:watch').at(-1)).toEqual({ roots: [A] }))

    content = 'two\n'
    act(() => bridge.emit('files:changed', { root: A, paths: ['src/a.ts'] }))
    await waitFor(() => expect(result.current.tabs.get(path.toLowerCase())?.view?.content).toBe('two\n'))

    content = 'three\n'
    act(() => bridge.emit('files:changed', { root: A, paths: ['.git'] }))
    await waitFor(() => expect(result.current.tabs.get(path.toLowerCase())?.view?.content).toBe('three\n'))

    const reads = bridge.invoked('files:read').length
    act(() => bridge.emit('files:changed', { root: A, paths: ['src/other.ts'] }))
    expect(bridge.invoked('files:read')).toHaveLength(reads)
  })

  it('keeps what it had and says why when a read fails', async () => {
    const path = joinRoot(A, 'src/a.ts')
    bridge.answer('files:read', () => {
      throw new Error(`Error invoking remote method 'files:read': Error: ${A} is not a folder Helm knows`)
    })
    const { result } = renderHook(() => useFiles({ active: false, follow: null, shown: [{ root: A, path }] }))
    await waitFor(() => expect(result.current.tabs.get(path.toLowerCase())?.error).toBe(`${A} is not a folder Helm knows`))
  })
})

describe('useFiles: Ctrl+P', () => {
  it('lists a project once per opening and remembers what was opened there', async () => {
    bridge.answer('files:list', ({ root }) => ({ root, files: ['a.ts', 'b.ts'], source: 'git', truncated: false, error: null }))
    const { result } = renderHook(() => useFiles({ active: false, follow: A, shown: NONE }))
    act(() => result.current.loadListing(A))
    await waitFor(() => expect(result.current.listing?.files).toEqual(['a.ts', 'b.ts']))

    act(() => {
      result.current.noteOpened(A, 'a.ts')
      result.current.noteOpened(A, 'b.ts')
      result.current.noteOpened(A, 'A.ts')
    })
    expect(result.current.recentIn(A)).toEqual(['A.ts', 'b.ts'])
    expect(result.current.recentIn(B)).toEqual([])
  })

  it('keeps the list through a change under the project, and lists again at the next opening', async () => {
    const lists = [['a.ts'], ['a.ts', 'new.ts']]
    let asked = 0
    bridge.answer('files:list', ({ root }) => ({
      root,
      files: lists[Math.min(asked++, lists.length - 1)]!,
      source: 'walk',
      truncated: false,
      error: null
    }))
    const { result } = renderHook(() => useFiles({ active: false, follow: A, shown: NONE }))
    act(() => result.current.loadListing(A))
    await waitFor(() => expect(result.current.listing?.files).toEqual(['a.ts']))

    // A busy folder changes every second or two. The list on screen is still
    // the answer it was - a change must not put the dialog back to "Listing"
    // with nothing asking main again.
    act(() => bridge.emit('files:changed', { root: A, paths: ['new.ts'] }))
    act(() => bridge.emit('files:changed', { root: A, paths: null }))
    expect(result.current.listing?.files).toEqual(['a.ts'])

    // The next opening shows the last list at once and replaces it when main answers.
    act(() => result.current.loadListing(A))
    expect(result.current.listing?.files).toEqual(['a.ts'])
    await waitFor(() => expect(result.current.listing?.files).toEqual(['a.ts', 'new.ts']))
    expect(bridge.invoked('files:list')).toHaveLength(2)
  })
})

describe('joinRoot and relativeTo', () => {
  it('turn a project-relative path into the platform’s and back', () => {
    expect(joinRoot('C:\\a\\', 'src/b.ts')).toBe('C:\\a\\src\\b.ts')
    expect(relativeTo('C:\\a', 'C:\\a\\src\\b.ts')).toBe('src/b.ts')
    expect(joinRoot('/home/a', 'src/b.ts')).toBe('/home/a/src/b.ts')
  })
})
