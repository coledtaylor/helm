import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { TemplateChoice, TemplatePreview } from '@helm/core'
import { NewHarnessDialog, type NewHarnessDialogProps } from './NewHarnessDialog'

const TEMPLATES: TemplateChoice[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'A manifest, an empty repos/ and an empty .claude/. Nothing else.',
    order: null,
    builtIn: true
  },
  { id: 'client', label: 'Client work', description: 'Notes, tools and a review skill.', order: 1, builtIn: false },
  { id: 'bare', label: 'bare', description: null, order: null, builtIn: false }
]

/** What `template:preview` answers for `client`: the manifest first. */
const PREVIEW: TemplatePreview = {
  template: 'client',
  entries: ['harness.yaml', '.claude/skills/review/SKILL.md', 'CLAUDE.md', 'notes/'],
  note: 'From the Client work template.',
  problems: []
}

function renderDialog(overrides: Partial<NewHarnessDialogProps> = {}) {
  const props: NewHarnessDialogProps = {
    mode: 'new',
    dir: 'C:\\work',
    onChooseDir: vi.fn(),
    templates: TEMPLATES,
    template: 'minimal',
    onTemplateChange: vi.fn(),
    templatesDir: 'C:\\Users\\me\\.config\\helm\\templates',
    onManageTemplates: vi.fn(),
    onCreate: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  }
  render(<NewHarnessDialog {...props} />)
  return props
}

describe('NewHarnessDialog', () => {
  it('shows each template by the label and description its template.yaml gives', () => {
    renderDialog()
    const picker = screen.getByRole('radiogroup', { name: 'Template' })
    const rows = within(picker).getAllByRole('radio')
    expect(rows.map((row) => row.textContent)).toEqual([
      'MinimalA manifest, an empty repos/ and an empty .claude/. Nothing else.',
      'Client workNotes, tools and a review skill.',
      'bare'
    ])
    expect(within(picker).getByRole('radio', { name: /^Minimal/ }).getAttribute('aria-checked')).toBe('true')
  })

  it('picks a template and creates the harness from it', async () => {
    const props = renderDialog({ template: 'client', preview: PREVIEW })
    await userEvent.click(screen.getByRole('radio', { name: /^bare/ }))
    expect(props.onTemplateChange).toHaveBeenCalledWith('bare')

    await userEvent.type(screen.getByRole('textbox', { name: 'Harness name' }), 'acme')
    await userEvent.click(screen.getByRole('button', { name: 'Create harness' }))
    expect(props.onCreate).toHaveBeenCalledWith({ mode: 'new', dir: 'C:\\work', name: 'acme', template: 'client' })
  })

  it('lists what gets written exactly as the preview gives it, manifest first', async () => {
    renderDialog({ template: 'client', preview: PREVIEW })
    await userEvent.type(screen.getByRole('textbox', { name: 'Harness name' }), 'acme')

    expect(screen.getByText('C:\\work\\acme')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(PREVIEW.entries)
    expect(screen.getByText(PREVIEW.note)).toBeTruthy()
  })

  it('lists nothing under what gets written until the preview answers', () => {
    renderDialog({ preview: null })
    expect(screen.queryAllByRole('listitem')).toEqual([])
  })

  it('opens the template manager from beside the picker', async () => {
    const props = renderDialog()
    await userEvent.click(screen.getByRole('button', { name: 'Manage templates…' }))
    expect(props.onManageTemplates).toHaveBeenCalledTimes(1)
  })
})
