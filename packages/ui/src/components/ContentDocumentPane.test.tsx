import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildWikiIndex,
  contentScope,
  highlightCode,
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
    return { file, content, rendered, source: null, error: null }
  }
  if (file.kind === 'html') return { file, content, rendered: null, source: null, error: null }
  const out = await highlightCode(content.content, file.ext)
  return {
    file,
    content,
    rendered: null,
    source: { html: out.html, language: out.language, highlighted: out.highlighted, tooLarge: false },
    error: null
  }
}

function paneProps(document: ContentDocument, overrides: Partial<ContentDocumentPaneProps> = {}): ContentDocumentPaneProps {
  return {
    file: document.file,
    document,
    preview: null,
    previewPending: false,
    mode: 'read',
    onModeChange: vi.fn(),
    artifactUrl: null,
    artifactConsole: [],
    snapshots: [],
    saving: false,
    error: null,
    external: null,
    highlight: null,
    wrapDefault: false,
    wrapIndent: 4,
    onHighlight: null,
    onSave: vi.fn(),
    onReload: vi.fn(),
    onRestore: vi.fn(),
    onReveal: vi.fn(),
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

    expect(screen.getByRole('heading', { level: 2, name: 'Alpha note' })).toBeTruthy()
    for (const chip of ['journal', '2026-08-10', '#helm', '#notes']) expect(screen.getByText(chip)).toBeTruthy()
    expect(document.body.textContent).not.toContain('type: journal')
    expect(document.body.textContent).not.toContain('tags: [helm')
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

describe('ContentDocumentPane: a source file', () => {
  it('starts wrapped or not from the setting, and keeps its own choice once open', async () => {
    const props = paneProps(await documentOf('notes/data.json'), { wrapDefault: true })
    const { rerender, unmount } = render(<ContentDocumentPane {...props} />)
    const wrap = screen.getByRole('button', { name: 'Wrap' })
    expect(wrap.getAttribute('aria-pressed')).toBe('true')

    await userEvent.click(wrap)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    // The setting changing under an open pane does not overrule the pane.
    rerender(<ContentDocumentPane {...props} wrapDefault={false} />)
    rerender(<ContentDocumentPane {...props} wrapDefault={true} />)
    expect(wrap.getAttribute('aria-pressed')).toBe('false')
    unmount()

    // The next file opened starts from the setting again.
    render(<ContentDocumentPane {...paneProps(await documentOf('notes/data.json'), { wrapDefault: false })} />)
    expect(screen.getByRole('button', { name: 'Wrap' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('hangs a continuation by the setting’s indent from each line’s own indentation', async () => {
    const { container } = render(
      <ContentDocumentPane {...paneProps(await documentOf('notes/data.json'), { wrapDefault: true, wrapIndent: 6 })} />
    )
    const view = container.querySelector('.source-view') as HTMLElement
    expect(view.getAttribute('data-wrap')).toBe('on')
    expect(view.style.getPropertyValue('--source-wrap-indent')).toBe('6ch')

    // Each line carries its own leading whitespace, which the stylesheet adds
    // the setting's indent to: the fixture's lines are indented 0, 2, 4, 2, 0.
    const indents = [...view.querySelectorAll<HTMLElement>('.line')].map((line) =>
      line.style.getPropertyValue('--line-indent')
    )
    expect(indents.slice(0, 5)).toEqual(['', '2ch', '4ch', '2ch', ''])
  })

  it('keeps the highlighted block, and where it was scrolled to, across re-renders and the wrap toggle', async () => {
    const document = await documentOf('notes/data.json')
    const props = paneProps(document)
    const { container, rerender } = render(<ContentDocumentPane {...props} />)

    const block = container.querySelector('pre.shiki') as HTMLElement
    block.scrollTop = 240
    block.scrollLeft = 60

    // A fresh answer for the same bytes, as a refresh produces.
    rerender(<ContentDocumentPane {...props} document={{ ...document, source: { ...document.source! } }} />)
    await userEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    rerender(<ContentDocumentPane {...props} document={{ ...document }} />)
    await userEvent.click(screen.getByRole('button', { name: 'Wrap' }))

    expect(container.querySelector('pre.shiki')).toBe(block)
    expect(block.scrollTop).toBe(240)
    expect(block.scrollLeft).toBe(60)
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
