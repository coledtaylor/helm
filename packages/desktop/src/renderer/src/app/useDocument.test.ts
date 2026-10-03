import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentDocument } from '@helm/core'
import { bridge } from './bridge.testkit'
import { noteDocument, rendered } from './document.testkit'
import { useDocument, type DocumentOptions } from './useDocument'

/**
 * One note or artifact in a file tab, against a main process played by the
 * bridge testkit: what it read, what it wrote, and how a change on disk lands
 * depending on whether anything is typed over it.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))

const ROOT = 'C:\\p'
const PATH = 'C:\\p\\notes\\a.md'

let onDisk: ContentDocument

beforeEach(() => {
  onDisk = noteDocument(PATH, 'notes/a.md', '# A\n', 'h1')
  bridge.answer('content:document', () => onDisk)
  bridge.answer('content:snapshots', () => [])
})

afterEach(() => bridge.reset())

const options = (over: Partial<DocumentOptions> = {}): DocumentOptions => ({
  scopePath: ROOT,
  path: PATH,
  kind: 'markdown',
  editing: false,
  parked: null,
  ...over
})

describe('useDocument', () => {
  it('reads the note in its scope, and writes it back against the hash it read', async () => {
    bridge.answer('content:write', () => ({ ok: true, unchanged: false, snapshotId: 1, file: onDisk.content }))
    const { result } = renderHook(() => useDocument(options()))
    await waitFor(() => expect(result.current.document?.content.hash).toBe('h1'))
    expect(bridge.invoked('content:document')).toEqual([{ scopePath: ROOT, path: PATH }])

    onDisk = noteDocument(PATH, 'notes/a.md', '# A\nmore\n', 'h2')
    act(() => result.current.save('# A\nmore\n'))
    expect(bridge.invoked('content:write')[0]).toMatchObject({ scopePath: ROOT, path: PATH, expectedHash: 'h1', reason: 'edit' })
    // The save is followed by a fresh read, so the next save is against the new hash.
    await waitFor(() => expect(result.current.document?.content.hash).toBe('h2'))
    expect(result.current.saving).toBe(false)
  })

  it('holds a write the file moved under as a conflict, and says what is on disk', async () => {
    bridge.answer('content:write', () => ({
      ok: false,
      unchanged: false,
      snapshotId: null,
      file: onDisk.content,
      conflict: { onDiskHash: 'h9', onDiskContent: 'theirs', mtimeMs: 0 }
    }))
    const { result } = renderHook(() => useDocument(options()))
    await waitFor(() => expect(result.current.document).not.toBeNull())
    act(() => result.current.save('mine'))
    await waitFor(() => expect(result.current.external).toEqual({ hash: 'h9', content: 'theirs', exists: true }))
  })

  it('follows a change on disk nobody is typing over, and holds one somebody is', async () => {
    const { result } = renderHook(() => useDocument(options()))
    await waitFor(() => expect(result.current.document?.content.hash).toBe('h1'))

    onDisk = noteDocument(PATH, 'notes/a.md', '# A, edited by the session\n', 'h2')
    act(() => bridge.emit('files:changed', { root: ROOT, paths: ['notes/a.md'] }))
    await waitFor(() => expect(result.current.document?.content.hash).toBe('h2'))
    expect(result.current.external).toBeNull()

    // A change to another file is not this one's.
    bridge.clearRecords()
    act(() => bridge.emit('files:changed', { root: ROOT, paths: ['notes/b.md'] }))
    expect(bridge.invoked('content:document')).toEqual([])

    act(() => result.current.setDirty(true))
    onDisk = noteDocument(PATH, 'notes/a.md', '# A, again\n', 'h3')
    act(() => bridge.emit('files:changed', { root: ROOT, paths: null }))
    await waitFor(() => expect(result.current.external?.hash).toBe('h3'))
    // What is on screen is still the version the draft was typed against.
    expect(result.current.document?.content.hash).toBe('h2')

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.document?.content.hash).toBe('h3'))
    expect(result.current.external).toBeNull()
  })

  it('says a draft left behind was typed against a version the file has moved on from', async () => {
    const { result } = renderHook(() => useDocument(options({ parked: { content: 'draft', baseHash: 'h0' } })))
    await waitFor(() => expect(result.current.external).toEqual({ hash: 'h1', content: '# A\n', exists: true }))
  })

  it('renders the draft for the split preview once typing pauses, and only while editing', async () => {
    bridge.answer('content:render', ({ source }) => rendered(`<p>${source}</p>`))
    const { result, rerender } = renderHook((props: DocumentOptions) => useDocument(props), {
      initialProps: options()
    })
    await waitFor(() => expect(result.current.document).not.toBeNull())
    act(() => result.current.setDraft('typed'))
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(bridge.invoked('content:render')).toEqual([])
    expect(result.current.preview).toBeNull()

    rerender(options({ editing: true }))
    await waitFor(() => expect(result.current.preview?.html).toBe('<p>typed</p>'))
    expect(result.current.previewPending).toBe(false)
    act(() => result.current.setDraft('typed more'))
    expect(result.current.previewPending).toBe(true)
  })

  it('mints an artifact a URL, and keeps only what that artifact logged', async () => {
    bridge.answer('content:artifact', () => ({
      url: 'helm-content://artifact/tok1/lesson.html',
      token: 'tok1'
    }))
    const { result } = renderHook(() => useDocument(options({ path: 'C:\\p\\lesson.html', kind: 'html' })))
    await waitFor(() => expect(result.current.artifactUrl).toBe('helm-content://artifact/tok1/lesson.html'))

    act(() => {
      bridge.emit('content:artifactConsole', { level: 'error', message: 'mine', source: 'helm-content://artifact/tok1/lesson.html', line: 1 })
      bridge.emit('content:artifactConsole', { level: 'error', message: 'theirs', source: 'helm-content://artifact/tok2/other.html', line: 1 })
    })
    expect(result.current.artifactConsole.map((entry) => entry.message)).toEqual(['mine'])
  })

  it('resolves a wikilink from inside an artifact through main, and answers null where nothing does', async () => {
    bridge.answer('content:wikilink', ({ target }) => ({ path: target === 'b' ? 'C:\\p\\notes\\b.md' : null }))
    const { result } = renderHook(() => useDocument(options()))
    await expect(result.current.resolveWikilink('b')).resolves.toBe('C:\\p\\notes\\b.md')
    await expect(result.current.resolveWikilink('nowhere')).resolves.toBeNull()
    expect(bridge.invoked('content:wikilink')[0]).toEqual({ scopePath: ROOT, target: 'b', from: PATH })
  })
})
