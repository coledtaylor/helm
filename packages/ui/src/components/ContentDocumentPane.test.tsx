import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWikiIndex,
  contentScope,
  readConfigFileContent,
  readContentTree,
  renderMarkdown,
  type ContentDocument,
  type ContentFile,
  type ContentTree
} from '@helm/core'
import { installExecCommand, installLayoutStandIns, type ExecCommandStandIn } from './CodeEditor.testkit'
import { ContentDocumentPane, type ContentDocumentPaneProps } from './ContentDocumentPane'

installLayoutStandIns()

/**
 * One open document, in each of the surfaces it can be: a rendered note, a
 * note being edited beside its preview, a source file, and an HTML artifact.
 * Every document is what core reads and renders from a scope on disk.
 */

let root: string
let tree: ContentTree
let editing: ExecCommandStandIn

const NOTE = [
  '---',
  'type: journal',
  'date: 2026-08-10',
  'tags: [helm, notes]',
  '---',
  '',
  '# Alpha note',
  '',
  'Read [[second]], then [[unwritten]], then [the docs](https://example.com/page).',
  ''
].join('\n')
const SOURCE = ['{', '  "outer": {', '    "inner": "a value long enough to wrap when wrapping is on"', '  }', '}', ''].join('\n')

function write(rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm content doc-'))
  write('notes/alpha.md', NOTE)
  write('notes/second.md', '# Second\n')
  write('notes/data.json', SOURCE)
  write('notes/lesson.html', '<p>Read [[second]].</p>\n')
  tree = readContentTree(contentScope(root, 'harness', 'vault'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  editing = installExecCommand()
})

afterEach(() => editing.restore())

const fileAt = (rel: string): ContentFile => {
  const file = tree.files.find((candidate) => candidate.relPath === rel)
  if (!file) throw new Error(`the fixture has no ${rel}`)
  return file
}

/** What `content:document` answers for a file: its bytes, rendered or highlighted. */
async function documentOf(rel: string): Promise<ContentDocument> {
  const file = fileAt(rel)
  const content = readConfigFileContent(file.path)
  if (file.kind === 'markdown') {
    const rendered = await renderMarkdown(content.content, { index: buildWikiIndex(tree.files), path: file.path })
    return { file, content, rendered, error: null }
  }
  return { file, content, rendered: null, error: null }
}

function paneProps(document: ContentDocument, overrides: Partial<ContentDocumentPaneProps> = {}): ContentDocumentPaneProps {
  return {
    file: document.file,
    document,
    preview: null,
    previewPending: false,
    mode: 'read',
    artifactUrl: null,
    artifactConsole: [],
    snapshots: [],
    saving: false,
    error: null,
    external: null,
    highlight: null,
    onHighlight: null,
    onSave: vi.fn(),
    onReload: vi.fn(),
    onRestore: vi.fn(),
    onDirtyChange: vi.fn(),
    onDraftChange: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenWikilink: vi.fn(),
    onOpenExternal: vi.fn(),
    ...overrides
  }
}

describe('ContentDocumentPane: a note', () => {
  it('shows the frontmatter as chips and never as body text', async () => {
    render(<ContentDocumentPane {...paneProps(await documentOf('notes/alpha.md'))} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Alpha note' })).toBeTruthy()
    for (const chip of ['journal', '2026-08-10', '#helm', '#notes']) expect(screen.getByText(chip)).toBeTruthy()
    expect(document.body.textContent).not.toContain('type: journal')
    expect(document.body.textContent).not.toContain('tags: [helm')
  })

  it('marks the words a search opened it on, and keeps them through a re-render', async () => {
    const props = paneProps(await documentOf('notes/alpha.md'), { highlight: 'alpha' })
    const { container, rerender } = render(<ContentDocumentPane {...props} />)
    const marks = (): number => container.querySelectorAll('mark.md-hit').length
    expect(marks()).toBeGreaterThan(0)
    // Anything above it re-rendering - a busy folder's watch, the clock in the
    // status bar - must not repaint the body and take the marks with it.
    rerender(<ContentDocumentPane {...props} snapshots={[]} />)
    expect(marks()).toBeGreaterThan(0)
  })

  it('opens the note a live wikilink names, and does nothing for a broken one', async () => {
    const props = paneProps(await documentOf('notes/alpha.md'))
    render(<ContentDocumentPane {...props} />)

    await userEvent.click(screen.getByRole('link', { name: 'second' }))
    expect(props.onOpenPath).toHaveBeenCalledWith(fileAt('notes/second.md').path, null)

    await userEvent.click(screen.getByRole('link', { name: 'unwritten' }))
    expect(props.onOpenPath).toHaveBeenCalledTimes(1)
    // The broken one is counted where the reader can see it.
    expect(screen.getByText('1 unwritten')).toBeTruthy()
  })

  it('hands an https link to the system instead of navigating the window', async () => {
    const props = paneProps(await documentOf('notes/alpha.md'))
    render(<ContentDocumentPane {...props} />)

    const proceeded = fireEvent.click(screen.getByRole('link', { name: 'the docs' }))
    expect(proceeded).toBe(false)
    expect(props.onOpenExternal).toHaveBeenCalledWith('https://example.com/page')
  })

  it('edits beside a preview drawn from the draft, and writes nothing until Save', async () => {
    const document = await documentOf('notes/alpha.md')
    const props = paneProps(document, { mode: 'edit' })
    const { rerender } = render(<ContentDocumentPane {...props} />)

    const box = screen.getByRole('textbox', { name: 'Edit notes/alpha.md' })
    expect((box as HTMLTextAreaElement).value).toBe(NOTE)
    expect(screen.getByText('Saved')).toBeTruthy()

    await userEvent.type(box, 'Drafted line')
    const draft = `${NOTE}Drafted line`
    expect((box as HTMLTextAreaElement).value).toBe(draft)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(props.onDraftChange).toHaveBeenLastCalledWith(draft)

    // The preview is whatever main rendered from the draft it was handed.
    const preview = await renderMarkdown(draft.replace('# Alpha note', '# Alpha redrafted'), { path: document.file.path })
    rerender(<ContentDocumentPane {...props} preview={preview} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Alpha redrafted' })).toBeTruthy()

    // Find, undo and the wrap toggle are all editing; none of them is a save.
    fireEvent.keyDown(box, { key: 'f', ctrlKey: true })
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    await userEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    expect(props.onSave).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSave).toHaveBeenCalledWith(draft)
  })

  it('edits in the shared editor, with its mirror and highlight layers under the text', async () => {
    render(<ContentDocumentPane {...paneProps(await documentOf('notes/alpha.md'), { mode: 'edit' })} />)

    const editor = screen.getByRole('textbox', { name: 'Edit notes/alpha.md' }).closest('.helm-editor')
    expect(editor?.getAttribute('data-editor-surface')).toBe('content')
    expect(editor?.querySelector('[data-editor-underlay]')?.textContent).toBe(NOTE)
    expect(editor?.querySelector('[data-editor-highlight]')).not.toBeNull()
  })

  it('says the editor has dropped its colour when the file is past the ceiling', async () => {
    const onHighlight = vi.fn(() =>
      Promise.resolve({ lines: [], language: 'plaintext', highlighted: false, tooLarge: true, tookMs: 0 })
    )
    render(<ContentDocumentPane {...paneProps(await documentOf('notes/alpha.md'), { mode: 'edit', onHighlight })} />)
    expect(await screen.findByText('plain text: too large to highlight')).toBeTruthy()
  })
})

describe('ContentDocumentPane: a draft left behind', () => {
  it('starts the editor on the draft a tab left, and a reload is the file again', async () => {
    const document = await documentOf('notes/alpha.md')
    const props = paneProps(document, { mode: 'edit', initialDraft: `${NOTE}Kept while away` })
    const { rerender } = render(<ContentDocumentPane {...props} />)

    const box = screen.getByRole('textbox', { name: 'Edit notes/alpha.md' }) as HTMLTextAreaElement
    expect(box.value).toBe(`${NOTE}Kept while away`)
    expect(screen.getByText('Unsaved changes')).toBeTruthy()

    // The file moved on disk and somebody chose Reload: the draft is not
    // seeded a second time over the version they asked for.
    const moved = { ...document, content: { ...document.content, content: `${NOTE}On disk`, hash: 'moved' } }
    rerender(<ContentDocumentPane {...props} document={moved} />)
    expect(box.value).toBe(`${NOTE}On disk`)
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('draws no header over a note with no frontmatter while it is read, and the wrap toggle while it is edited', async () => {
    const document = await documentOf('notes/second.md')
    const { rerender } = render(<ContentDocumentPane {...paneProps(document)} />)
    expect(screen.queryByRole('button', { name: 'Wrap' })).toBeNull()
    expect(screen.queryByRole('banner')).toBeNull()
    rerender(<ContentDocumentPane {...paneProps(document, { mode: 'edit' })} />)
    expect(screen.getByRole('button', { name: 'Wrap' }).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('ContentDocumentPane: an HTML artifact', () => {
  it('frames it with scripts allowed and nothing else, and trusts only its own frame’s messages', async () => {
    const props = paneProps(await documentOf('notes/lesson.html'), {
      artifactUrl: 'helm-content://artifact/token/lesson.html'
    })
    render(<ContentDocumentPane {...props} />)

    const frame = screen.getByTitle('lesson') as HTMLIFrameElement
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(screen.getByText('console clean')).toBeTruthy()

    const message = { helm: 'wikilink', target: 'second', heading: null }
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message, source: window }))
    })
    expect(props.onOpenWikilink).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: message, source: frame.contentWindow }))
    })
    expect(props.onOpenWikilink).toHaveBeenCalledWith('second', null)
  })

  it('counts what the artifact logged as errors', async () => {
    render(
      <ContentDocumentPane
        {...paneProps(await documentOf('notes/lesson.html'), {
          artifactUrl: 'helm-content://artifact/token/lesson.html',
          artifactConsole: [
            { level: 'error', message: 'boom', source: 'helm-content://artifact/token/lesson.html', line: 3 },
            { level: 'info', message: 'fine', source: 'helm-content://artifact/token/lesson.html', line: 4 }
          ]
        })}
      />
    )
    const toggle = screen.getByRole('button', { name: '1 console error' })
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(document.body).getByText('boom')).toBeTruthy()
  })
})
