import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigFile, ConfigScope, ConfigTree, TemplateChoice, TemplateDetail } from '@helm/core'
import { TemplateManager, type TemplateManagerProps } from './TemplateManager'

const DIR = 'C:\\Users\\me\\.config\\helm\\templates'

const TEMPLATES: TemplateChoice[] = [
  { id: 'minimal', label: 'Minimal', description: 'The built-in.', order: null, builtIn: true },
  { id: 'client', label: 'Client work', description: 'Notes and tools.', order: 1, builtIn: false },
  { id: 'bare', label: 'bare', description: null, order: null, builtIn: false }
]

const file = (relPath: string, patch: Partial<TemplateDetail['files'][number]> = {}): TemplateDetail['files'][number] => ({
  relPath,
  target: relPath,
  size: 12,
  mtimeMs: 0,
  substituted: false,
  link: false,
  ...patch
})

const DETAIL: TemplateDetail = {
  id: 'client',
  dir: `${DIR}\\client`,
  label: 'Client work',
  description: 'Notes and tools.',
  hasManifest: true,
  files: [
    file('CLAUDE.md.tpl', { target: 'CLAUDE.md', substituted: true }),
    file('dot-claude/skills/review/SKILL.md', { target: '.claude/skills/review/SKILL.md' }),
    file('linked', { target: '', link: true }),
    file('tools/run.mjs')
  ],
  fileCount: 4,
  totalBytes: 48,
  modifiedAtMs: 0,
  problems: []
}

const USER: ConfigScope = { kind: 'user', path: 'C:\\Users\\me\\.claude', claudeDir: 'C:\\Users\\me\\.claude', label: 'User', exists: true }
const HUB: ConfigScope = { kind: 'harness', path: 'C:\\work\\hub', claudeDir: 'C:\\work\\hub\\.claude', label: 'hub', exists: true }

const configFile = (relPath: string, kind: ConfigFile['kind'], name: string): ConfigFile => ({
  path: `${USER.path}\\${relPath.split('/').join('\\')}`,
  relPath,
  kind,
  name,
  size: 10,
  mtimeMs: 0,
  description: null,
  binary: false
})

const USER_TREE: ConfigTree = {
  scope: USER,
  files: [
    configFile('skills/think/SKILL.md', 'skill', 'think'),
    configFile('skills/think/reference.md', 'other', 'reference.md'),
    configFile('agents/reviewer.md', 'agent', 'reviewer'),
    configFile('settings.local.json', 'settings-local', 'settings.local.json')
  ],
  errors: [],
  scannedAt: '2026-10-02T00:00:00.000Z'
}

function renderManager(overrides: Partial<TemplateManagerProps> = {}) {
  const props: TemplateManagerProps = {
    templates: TEMPLATES,
    templatesDir: DIR,
    selected: null,
    onSelect: vi.fn(),
    detail: null,
    scopes: [USER, HUB],
    importScope: null,
    onImportScopeChange: vi.fn(),
    importTree: null,
    onCreate: vi.fn(),
    onSaveMetadata: vi.fn(),
    onDelete: vi.fn(),
    onReveal: vi.fn(),
    onMakeSubstitutable: vi.fn(),
    onImport: vi.fn(),
    onImportFolder: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
  render(<TemplateManager {...props} />)
  return props
}

/** The template rows: the buttons that say which one is current. */
const rows = (): string[] =>
  screen
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-current'))
    .map((button) => button.textContent ?? '')

const fileRow = (relPath: string): HTMLElement => screen.getByTitle(relPath).closest('li') as HTMLElement

describe('TemplateManager', () => {
  it('lists exactly the templates in the folder, not the built-in, and selects one', async () => {
    const props = renderManager()
    expect(screen.getByRole('dialog', { name: 'Manage templates' })).toBeTruthy()
    expect(rows()).toEqual(['Client workclientNotes and tools.', 'barebare'])

    await userEvent.click(screen.getByRole('button', { name: /^Client work/ }))
    expect(props.onSelect).toHaveBeenCalledWith('client')
  })

  it('creates a template from the name typed under New', async () => {
    const props = renderManager()
    await userEvent.click(screen.getByRole('button', { name: 'New' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New template folder name' }), ' acme ')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(props.onCreate).toHaveBeenCalledWith('acme')
  })

  it('saves the label and description, and a changed folder name as the rename', async () => {
    const props = renderManager({ selected: 'client', detail: DETAIL })
    const label = screen.getByRole('textbox', { name: 'Template label' })
    await userEvent.clear(label)
    await userEvent.type(label, 'Client: work')
    await userEvent.clear(screen.getByRole('textbox', { name: 'Template description' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSaveMetadata).toHaveBeenLastCalledWith({ name: 'client', label: 'Client: work', description: '' })

    const name = screen.getByRole('textbox', { name: 'Template folder name' })
    await userEvent.clear(name)
    await userEvent.type(name, 'client-work')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSaveMetadata).toHaveBeenLastCalledWith({ name: 'client-work', label: 'Client: work', description: '' })
  })

  it('deletes a template only once the delete is confirmed', async () => {
    const props = renderManager({ selected: 'client', detail: DETAIL })
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(props.onDelete).not.toHaveBeenCalled()
    expect(screen.getByText('Delete client and everything in it?')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }))
    expect(screen.queryByText('Delete client and everything in it?')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(props.onDelete).toHaveBeenCalledWith('client')
  })

  it('badges only the .tpl files, and names the four variables they are filled with', () => {
    renderManager({ selected: 'client', detail: DETAIL })
    expect(within(fileRow('CLAUDE.md.tpl')).getByText('tpl')).toBeTruthy()
    for (const plain of ['dot-claude/skills/review/SKILL.md', 'linked', 'tools/run.mjs']) {
      expect(within(fileRow(plain)).queryByText('tpl')).toBeNull()
    }
    for (const variable of ['{{NAME}}', '{{CREATED_AT}}', '{{TEMPLATE}}', '{{PATH}}']) {
      expect(screen.getByText(variable)).toBeTruthy()
    }
  })

  it('offers to make a plain file substitutable, and nothing else', async () => {
    const props = renderManager({ selected: 'client', detail: DETAIL })
    expect(within(fileRow('CLAUDE.md.tpl')).queryByRole('button', { name: 'Make substitutable' })).toBeNull()
    expect(within(fileRow('linked')).queryByRole('button', { name: 'Make substitutable' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Make substitutable' })).toHaveLength(2)

    await userEvent.click(within(fileRow('tools/run.mjs')).getByRole('button', { name: 'Make substitutable' }))
    expect(props.onMakeSubstitutable).toHaveBeenCalledWith('tools/run.mjs')
  })

  it('copies in from the config console’s scopes, the user’s ~/.claude included', async () => {
    const props = renderManager({ selected: 'client', detail: DETAIL })
    const scope = screen.getByRole('combobox', { name: 'Where to copy from' })
    expect(within(scope).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Choose a scope…',
      'User · ~/.claude',
      'hub · C:\\work\\hub'
    ])
    await userEvent.selectOptions(scope, USER.path)
    expect(props.onImportScopeChange).toHaveBeenCalledWith(USER.path)
  })

  it('offers what a template can carry from the scope, and copies what is ticked', async () => {
    const props = renderManager({ selected: 'client', detail: DETAIL, importScope: USER.path, importTree: USER_TREE })
    expect(
      screen.getAllByRole('checkbox', { name: /^Copy / }).map((box) => box.getAttribute('aria-label'))
    ).toEqual(['Copy think', 'Copy reviewer'])

    await userEvent.click(screen.getByRole('checkbox', { name: 'Copy think' }))
    await userEvent.click(screen.getByRole('button', { name: 'Copy 1 in' }))
    expect(props.onImport).toHaveBeenCalledWith([USER_TREE.files[0]?.path])
  })
})
