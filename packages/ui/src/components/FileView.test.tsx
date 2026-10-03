import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileView as FileViewData } from '@helm/core'
import { installLayoutStandIns } from './CodeEditor.testkit'
import { FileActions, FileCrumb, FileView, type FileViewProps } from './FileView'

installLayoutStandIns()

const VIEW: FileViewData = {
  root: 'C:\\p',
  path: 'C:\\p\\src\\a.ts',
  relPath: 'src/a.ts',
  exists: true,
  size: 30,
  mtimeMs: 0,
  binary: false,
  tooLarge: false,
  content: 'one\ntwo\nthree\nfour\n',
  eol: 'CRLF',
  changes: {
    kind: 'tracked',
    lines: { changed: [[2, 3]], removedAfter: [4], changedCount: 2, removedCount: 1 }
  },
  error: null
}

function renderView(overrides: Partial<FileViewProps> = {}) {
  const props: FileViewProps = {
    view: VIEW,
    error: null,
    wrap: false,
    onWrapChange: vi.fn(),
    onHighlight: null,
    onReveal: vi.fn(),
    onOpenInEditor: vi.fn(),
    ...overrides
  }
  const result = render(<FileView {...props} />)
  return { props, ...result }
}

describe('FileView', () => {
  it('shows the file read-only, with the lines that differ from the last commit marked', () => {
    const { container } = renderView()
    const box = screen.getByRole('textbox', { name: 'Contents of src/a.ts' }) as HTMLTextAreaElement
    expect(box.value).toBe(VIEW.content)
    expect(box.readOnly).toBe(true)

    fireEvent.keyDown(box, { key: 'Tab' })
    fireEvent.change(box, { target: { value: 'typed over' } })
    expect(box.value).toBe(VIEW.content)

    const marked = [...container.querySelectorAll('[data-editor-changed="true"]')].map((n) => n.textContent)
    expect(marked).toEqual(['2', '3'])
    expect(container.querySelector('[data-editor-removed-after="4"]')).not.toBeNull()
  })

  it('says where the caret is, how the lines end, and that it is read only', () => {
    renderView()
    expect(screen.getByText('Ln 1, Col 1')).toBeTruthy()
    expect(screen.getByText('CRLF')).toBeTruthy()
    expect(screen.getByText('Read only')).toBeTruthy()
  })

  it('toggles wrapping from its footer', () => {
    const { props } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    expect(props.onWrapChange).toHaveBeenCalledWith(true)
  })

  it('says a file is gone, binary or too large, and offers somewhere else to open it', () => {
    const { rerender, props } = renderView({ view: { ...VIEW, exists: false, content: '' } })
    expect(screen.getByText('This file is not there any more')).toBeTruthy()
    // A file that is not there cannot be opened in VS Code; Explorer still can show its folder.
    expect(screen.queryByRole('button', { name: 'Open in VS Code' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Explorer' }))
    expect(props.onReveal).toHaveBeenCalledWith(VIEW.path)

    rerender(<FileView {...props} view={{ ...VIEW, binary: true, content: '', size: 2048 }} />)
    expect(screen.getByText('Not a text file')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    expect(props.onOpenInEditor).toHaveBeenCalled()

    rerender(<FileView {...props} view={{ ...VIEW, tooLarge: true, content: '', size: 9 * 1024 * 1024 }} />)
    expect(screen.getByText('Too large to read here')).toBeTruthy()
  })

  it('says a read that failed, and is reading until the first answer', () => {
    const { rerender, props } = renderView({ view: null })
    expect(screen.getByText('Reading…')).toBeTruthy()
    rerender(<FileView {...props} view={null} error="C:\\x is not a folder Helm knows" />)
    expect(screen.getByText('This file could not be read')).toBeTruthy()
  })
})

describe('FileCrumb', () => {
  it('shows where the file is in its project and how it stands against the last commit', () => {
    const { rerender } = render(<FileCrumb relPath="src/a.ts" changes={VIEW.changes} />)
    expect(screen.getByTitle('src/a.ts').textContent).toBe('src›a.ts')
    // The sentence, and its short form for a narrow pane; CSS picks one by the crumb's width.
    const said = screen.getByTitle('2 lines changed, 1 line removed since the last commit')
    expect(said.textContent).toBe('2 lines changed, 1 line removed since the last commit2 changed, 1 removed')
    rerender(<FileCrumb relPath="src/a.ts" changes={{ kind: 'unknown', reason: 'git timed out' }} />)
    expect(screen.getByTitle('Could not read what changed: git timed out')).toBeTruthy()
    rerender(<FileCrumb relPath="src/a.ts" changes={null} />)
    expect(screen.queryByTitle(/since the last commit|Could not read/)).toBeNull()
  })
})

describe('FileActions', () => {
  it('hands the file to VS Code, Explorer and the clipboard', () => {
    const onOpenInEditor = vi.fn()
    const onReveal = vi.fn()
    const onCopyPath = vi.fn()
    render(<FileActions path={'C:\\p\\a.ts'} onOpenInEditor={onOpenInEditor} onReveal={onReveal} onCopyPath={onCopyPath} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reveal in Explorer' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(onOpenInEditor).toHaveBeenCalled()
    expect(onReveal).toHaveBeenCalledWith('C:\\p\\a.ts')
    expect(onCopyPath).toHaveBeenCalledWith('C:\\p\\a.ts')
    expect(screen.getByRole('button', { name: 'Path copied' })).toBeTruthy()
  })

  it('keeps the VS Code button, disabled and saying why, where VS Code is not installed', () => {
    render(<FileActions path={'C:\\p\\a.ts'} onOpenInEditor={null} onReveal={vi.fn()} onCopyPath={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'Open in VS Code' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('VS Code is not installed on this machine')
  })
})
