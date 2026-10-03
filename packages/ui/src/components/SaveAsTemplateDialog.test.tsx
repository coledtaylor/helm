import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FolderTemplatePreview } from '@helm/core'
import { SaveAsTemplateDialog, type SaveAsTemplateDialogProps } from './SaveAsTemplateDialog'

type Entry = FolderTemplatePreview['entries'][number]

const entry = (name: string, fileCount: number, bytes: number, patch: Partial<Entry> = {}): Entry => ({
  name,
  directory: !name.includes('.') || name.startsWith('.'),
  fileCount,
  bytes,
  truncated: false,
  included: true,
  refused: null,
  link: false,
  ...patch
})

/** A harness's top level as the engine previews it: instance data unticked, two entries refused. */
const PREVIEW: FolderTemplatePreview = {
  dir: 'C:\\work\\hub',
  kind: 'harness',
  entries: [
    entry('.claude', 3, 3072),
    entry('.git', 40, 90_000, { included: false, refused: 'version control is never copied' }),
    entry('CLAUDE.md', 1, 1024, { directory: false }),
    entry('harness.yaml', 1, 40, { directory: false, included: false, refused: 'a template must not carry one' }),
    entry('notes', 2, 2048),
    entry('repos', 0, 0, { included: false }),
    entry('tools', 1, 512)
  ],
  fileCount: 7,
  totalBytes: 6656,
  note: '',
  problems: []
}

function renderDialog(overrides: Partial<SaveAsTemplateDialogProps> = {}) {
  const props: SaveAsTemplateDialogProps = {
    kind: 'harness',
    dir: 'C:\\work\\hub',
    preview: PREVIEW,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<SaveAsTemplateDialog {...props} />)
  return props
}

describe('SaveAsTemplateDialog', () => {
  it('states nothing and offers nothing until the folder has been read', () => {
    renderDialog({ preview: null })
    expect(screen.getByText('reading…')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create template' }).hasAttribute('disabled')).toBe(true)
  })

  it('states the size of what is ticked, and the total moves as entries are unticked', async () => {
    renderDialog()
    expect(screen.getByText('7 files · 6.5 KB')).toBeTruthy()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy notes' }))
    expect(screen.getByText('5 files · 4.5 KB')).toBeTruthy()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy .claude' }))
    expect(screen.getByText('2 files · 1.5 KB')).toBeTruthy()
  })

  it('lists a refused entry with its reason and no way to tick it', () => {
    renderDialog()
    expect(screen.getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual([
      'Copy .claude',
      'Copy CLAUDE.md',
      'Copy notes',
      'Copy repos',
      'Copy tools'
    ])
    expect(screen.getByText('not copied - version control is never copied')).toBeTruthy()
    expect(screen.getByText('not copied - a template must not carry one')).toBeTruthy()
  })

  it('creates the template from exactly the entries ticked', async () => {
    const props = renderDialog()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy notes' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy repos' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Template label' }), 'Hub layout')
    await userEvent.click(screen.getByRole('button', { name: 'Create template' }))

    expect(props.onSave).toHaveBeenCalledWith({
      name: 'hub',
      label: 'Hub layout',
      description: '',
      include: ['.claude', 'CLAUDE.md', 'tools', 'repos']
    })
  })
})
