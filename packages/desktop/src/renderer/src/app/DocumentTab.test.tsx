import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentDocument } from '@helm/core'
import { bridge } from './bridge.testkit'
import { noteDocument } from './document.testkit'
import { DocumentModeSwitch, DocumentTab, documentKind, type DocumentMode, type DocumentTabProps } from './DocumentTab'
import { drafts } from './drafts'

/**
 * A note's file tab: which of Preview, Source and Edit is on screen, and the
 * draft that outlives the tab going out of sight.
 */
vi.mock('./bridge', () => import('./bridge.testkit'))

const ROOT = 'C:\\p'
const PATH = 'C:\\p\\notes\\a.md'
const KEY = PATH.toLowerCase()

let onDisk: ContentDocument

// jsdom does no layout: the editor watches its size and the reading view
// scrolls to its top, and here both are no-ops - as `installLayoutStandIns`
// makes them for the ui package's own editor tests.
beforeAll(() => {
  Element.prototype.scrollTo ??= function scrollTo() {}
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

beforeEach(() => {
  onDisk = noteDocument(PATH, 'notes/a.md', '# A\n', 'h1', '<h1>A</h1>')
  bridge.answer('content:document', () => onDisk)
  bridge.answer('content:snapshots', () => [])
  bridge.answer('content:render', () => onDisk.rendered!)
})

afterEach(() => {
  bridge.reset()
  drafts.set(KEY, null)
})

function tab(mode: DocumentMode, over: Partial<DocumentTabProps> = {}): DocumentTabProps {
  return {
    scopePath: ROOT,
    path: PATH,
    kind: 'markdown',
    mode,
    source: <p>the plain file view</p>,
    highlight: null,
    draftKey: KEY,
    onDirtyChange: vi.fn(),
    onHighlight: vi.fn(() => Promise.resolve({ lines: [], language: 'markdown', highlighted: false, tooLarge: false, tookMs: 0 })),
    onOpenPath: vi.fn(),
    onOpenExternal: vi.fn(),
    ...over
  }
}

const editor = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Edit notes/a.md' }) as HTMLTextAreaElement

describe('documentKind', () => {
  it('renders markdown and HTML, and leaves everything else to the file view', () => {
    expect(documentKind('C:\\p\\README.md')).toBe('markdown')
    expect(documentKind('C:\\p\\notes\\x.MARKDOWN')).toBe('markdown')
    expect(documentKind('C:\\p\\report.htm')).toBe('html')
    expect(documentKind('C:\\p\\app.ts')).toBeNull()
    expect(documentKind('C:\\p\\md')).toBeNull()
  })
})

describe('DocumentTab', () => {
  it('previews the note, and shows the file view for Source', async () => {
    const { rerender } = render(<DocumentTab {...tab('preview')} />)
    expect(await screen.findByRole('heading', { level: 1, name: 'A' })).toBeTruthy()
    rerender(<DocumentTab {...tab('source')} />)
    expect(screen.getByText('the plain file view')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 1, name: 'A' })).toBeNull()
  })

  it('keeps a draft through the tab going out of sight, says it is unsaved, and forgets it once saved', async () => {
    const onDirtyChange = vi.fn()
    const first = render(<DocumentTab {...tab('edit', { onDirtyChange })} />)
    await waitFor(() => expect(editor().value).toBe('# A\n'))
    fireEvent.change(editor(), { target: { value: '# A\ndrafted\n' } })
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true))
    expect(drafts.get(KEY)).toEqual({ content: '# A\ndrafted\n', baseHash: 'h1' })

    // Another tab comes to the front: this one unmounts, and comes back with the draft.
    first.unmount()
    render(<DocumentTab {...tab('edit', { onDirtyChange })} />)
    await waitFor(() => expect(editor().value).toBe('# A\ndrafted\n'))
    expect(screen.getByText('Unsaved changes')).toBeTruthy()

    bridge.answer('content:write', ({ content }) => {
      onDisk = noteDocument(PATH, 'notes/a.md', content, 'h2')
      return { ok: true, unchanged: false, snapshotId: 1, file: onDisk.content }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
    expect(drafts.get(KEY)).toBeNull()
  })

  it('forgets the draft when the edit is typed back to what is on disk', async () => {
    render(<DocumentTab {...tab('edit')} />)
    await waitFor(() => expect(editor().value).toBe('# A\n'))
    fireEvent.change(editor(), { target: { value: '# A!\n' } })
    await waitFor(() => expect(drafts.get(KEY)).not.toBeNull())
    fireEvent.change(editor(), { target: { value: '# A\n' } })
    await waitFor(() => expect(drafts.get(KEY)).toBeNull())
  })

  it('opens a wikilink from inside an artifact once main says where it points', async () => {
    const onOpenPath = vi.fn()
    bridge.answer('content:artifact', () => ({ url: 'helm-content://artifact/t/lesson.html', token: 't' }))
    bridge.answer('content:wikilink', () => ({ path: 'C:\\p\\notes\\b.md' }))
    onDisk = { ...noteDocument('C:\\p\\lesson.html', 'lesson.html', '<p>x</p>', 'h1'), rendered: null }
    onDisk.file.kind = 'html'
    render(<DocumentTab {...tab('preview', { path: 'C:\\p\\lesson.html', kind: 'html', onOpenPath })} />)
    const frame = (await screen.findByTitle(/^lesson/)) as HTMLIFrameElement
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { helm: 'wikilink', target: 'b', heading: null }, source: frame.contentWindow })
      )
    })
    await waitFor(() => expect(onOpenPath).toHaveBeenCalledWith('C:\\p\\notes\\b.md'))
  })
})

describe('DocumentModeSwitch', () => {
  it('offers Edit for a note and not for an artifact, and says which is on', () => {
    const onChange = vi.fn()
    const { rerender } = render(<DocumentModeSwitch kind="markdown" mode="preview" onChange={onChange} />)
    const radios = (): string[] => screen.getAllByRole('radio').map((radio) => radio.textContent ?? '')
    expect(radios()).toEqual(['Preview', 'Source', 'Edit'])
    expect(screen.getByRole('radio', { name: 'Preview' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }))
    expect(onChange).toHaveBeenCalledWith('edit')

    rerender(<DocumentModeSwitch kind="html" mode="source" onChange={onChange} />)
    expect(radios()).toEqual(['Preview', 'Source'])
    expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true')
  })
})
