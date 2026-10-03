import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  highlightCode,
  readConfigFileContent,
  renderMarkdown,
  type ConfigFile,
  type ConfigRendered,
  type EditorHighlight
} from '@helm/core'
import { installExecCommand, installLayoutStandIns, type ExecCommandStandIn } from './CodeEditor.testkit'
import { ConfigEditor, type ConfigEditorProps } from './ConfigEditor'
import { makeConfigFixture, SKILL, type ConfigFixture } from './ConfigFixture.testkit'

installLayoutStandIns()

/**
 * One configuration file, opened. Each kind is its own object - a settings
 * file's keys, a hook's provenance, a skill's rendered body - over the one
 * editor, save and version list every kind shares.
 */

let fixture: ConfigFixture
let editing: ExecCommandStandIn

beforeAll(() => {
  fixture = makeConfigFixture()
})

afterAll(() => fixture.dispose())

beforeEach(() => {
  editing = installExecCommand()
})

afterEach(() => editing.restore())

/** What `config:render` answers for a file: markdown rendered, anything else highlighted. */
async function renderedOf(file: ConfigFile): Promise<ConfigRendered> {
  const source = readConfigFileContent(file.path).content
  if (file.path.endsWith('.md')) return { markdown: await renderMarkdown(source, { path: file.path }), code: null }
  const code = await highlightCode(source, file.path.slice(file.path.lastIndexOf('.') + 1))
  return { markdown: null, code: code.html === '' ? null : code }
}

async function editorProps(relPath: string, overrides: Partial<ConfigEditorProps> = {}): Promise<ConfigEditorProps> {
  const file = fixture.file(relPath)
  return {
    file,
    loaded: readConfigFileContent(file.path),
    rendered: await renderedOf(file),
    live: fixture.view,
    siblings: fixture.tree.files,
    snapshots: [],
    saving: false,
    error: null,
    external: null,
    onSave: vi.fn(),
    onReload: vi.fn(),
    onRestore: vi.fn(),
    onReveal: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenExternal: vi.fn(),
    onDirtyChange: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    ...overrides
  }
}

const mode = (name: 'Read' | 'Edit' | 'Source'): HTMLElement =>
  within(screen.getByRole('group', { name: 'Mode' })).getByRole('button', { name })

describe('ConfigEditor: a settings file', () => {
  it('lists exactly the keys the file declares, each marked as winning or outranked', async () => {
    const { container } = render(<ConfigEditor {...(await editorProps('.claude/settings.json'))} />)

    // Leaves, as the layers merge them: `env.B` is set again in
    // settings.local.json, which outranks this file; everything else wins.
    const keys = [...container.querySelectorAll<HTMLElement>('[data-config-setting]')].map((row) => [
      row.querySelector('span')?.textContent,
      row.textContent?.includes('outranked') ? 'outranked' : 'wins'
    ])
    expect(keys.sort()).toEqual([
      ['env.A', 'wins'],
      ['env.B', 'outranked'],
      ['hooks.PreToolUse', 'wins'],
      ['model', 'wins']
    ])
    expect(screen.getByText('the local layer sets "local" instead')).toBeTruthy()
  })

  it('refuses to save JSON that does not parse, and says where it broke', async () => {
    const props = await editorProps('.claude/settings.json')
    render(<ConfigEditor {...props} />)
    await userEvent.click(mode('Source'))

    const box = screen.getByRole('textbox', { name: 'Edit .claude/settings.json' }) as HTMLTextAreaElement
    // A trailing comma after the first key, on line 2.
    fireEvent.change(box, { target: { value: '{\n  "model": "opus",\n}\n' } })

    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    const strip = screen.getByRole('button', { name: /Go to it/ })
    expect(strip.textContent).toMatch(/^2:\d+/)
    await userEvent.click(save)
    expect(props.onSave).not.toHaveBeenCalled()
  })

  it('cannot be renamed, and says why on the control', async () => {
    render(<ConfigEditor {...(await editorProps('.claude/settings.json'))} />)
    const rename = screen.getByRole('button', { name: 'Rename settings.json' }) as HTMLButtonElement
    expect(rename.disabled).toBe(true)
    expect(rename.title).toMatch(/exact name/)
  })
})

describe('ConfigEditor: a hook', () => {
  it('shows what runs it above its source, naming the settings file it came from', async () => {
    const props = await editorProps('.claude/hooks/guard.js')
    const { container } = render(<ConfigEditor {...props} />)

    expect(screen.getByText('What runs this')).toBeTruthy()
    expect(screen.getByText('PreToolUse')).toBeTruthy()
    expect(screen.getByText('Bash')).toBeTruthy()
    const origin = screen.getByRole('button', { name: 'settings.json · project' })
    await userEvent.click(origin)
    expect(props.onOpenPath).toHaveBeenCalledWith(fixture.file('.claude/settings.json').path)

    const provenance = screen.getByText('What runs this')
    const source = container.querySelector('[data-config-source]') as HTMLElement
    expect(source.textContent).toContain('process.exit(0)')
    expect(provenance.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('ConfigEditor: a skill', () => {
  it('opens rendered, with its frontmatter as chips and no textarea; Edit shows the source', async () => {
    render(<ConfigEditor {...(await editorProps('.claude/skills/think/SKILL.md'))} />)

    expect(screen.getByRole('heading', { level: 1, name: 'Think' })).toBeTruthy()
    expect(screen.getByText('Think before acting')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()

    await userEvent.click(mode('Edit'))
    const box = screen.getByRole('textbox', { name: 'Edit .claude/skills/think/SKILL.md' }) as HTMLTextAreaElement
    expect(box.value).toBe(SKILL)
  })

  it('lists the files bundled with it, each of which opens', async () => {
    const props = await editorProps('.claude/skills/think/SKILL.md')
    render(<ConfigEditor {...props} />)
    expect(screen.getByText('Bundled with this skill')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^prompts\.md/ }))
    expect(props.onOpenPath).toHaveBeenCalledWith(fixture.file('.claude/skills/think/prompts.md').path)
  })
})

describe('ConfigEditor: editing', () => {
  it('opens a file it just created ready to type in', async () => {
    render(<ConfigEditor {...(await editorProps('.claude/agents/reviewer.md', { justCreated: true }))} />)
    expect(screen.getByRole('textbox', { name: 'Edit .claude/agents/reviewer.md' })).toBeTruthy()
    expect(mode('Edit').getAttribute('aria-pressed')).toBe('true')
  })

  it('marks the file dirty as it is typed in, and clean again when it is back to the bytes on disk', async () => {
    const props = await editorProps('CLAUDE.md')
    render(<ConfigEditor {...props} />)
    await userEvent.click(mode('Edit'))
    const box = screen.getByRole('textbox', { name: 'Edit CLAUDE.md' }) as HTMLTextAreaElement
    const original = box.value

    await userEvent.type(box, 'x')
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(true)

    await userEvent.type(box, '{Backspace}')
    expect(box.value).toBe(original)
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(props.onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('wraps prose by default, and the toggle flips it for this file', async () => {
    render(<ConfigEditor {...(await editorProps('CLAUDE.md'))} />)
    await userEvent.click(mode('Edit'))
    const box = screen.getByRole('textbox', { name: 'Edit CLAUDE.md' })
    const wrap = screen.getByRole('button', { name: 'Wrap' })
    expect([wrap.getAttribute('aria-pressed'), box.getAttribute('wrap')]).toEqual(['true', 'soft'])

    await userEvent.click(wrap)
    expect([wrap.getAttribute('aria-pressed'), box.getAttribute('wrap')]).toEqual(['false', 'off'])
  })

  it('does not wrap structured data by default', async () => {
    render(<ConfigEditor {...(await editorProps('.claude/settings.json'))} />)
    await userEvent.click(mode('Source'))
    expect(screen.getByRole('textbox', { name: 'Edit .claude/settings.json' }).getAttribute('wrap')).toBe('off')
  })

  it('writes nothing for typing, find, undo or wrapping - only Save writes', async () => {
    const props = await editorProps('CLAUDE.md')
    render(<ConfigEditor {...props} />)
    await userEvent.click(mode('Edit'))
    const box = screen.getByRole('textbox', { name: 'Edit CLAUDE.md' })

    await userEvent.type(box, 'more')
    fireEvent.keyDown(box, { key: 'f', ctrlKey: true })
    fireEvent.keyDown(box, { key: 'z', ctrlKey: true })
    await userEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    await userEvent.click(mode('Read'))
    await userEvent.click(mode('Edit'))
    expect(props.onSave).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(props.onSave).toHaveBeenCalledTimes(1)
  })

  it('says the editor has gone plain when the file is past the ceiling', async () => {
    const tooLarge = (): Promise<EditorHighlight> =>
      Promise.resolve({ lines: [], language: 'plaintext', highlighted: false, tooLarge: true, tookMs: 0 })
    render(<ConfigEditor {...(await editorProps('CLAUDE.md', { onHighlight: tooLarge }))} />)
    await userEvent.click(mode('Edit'))
    expect(await screen.findByText('plain text: too large to highlight')).toBeTruthy()
  })

  it('blocks a save over a file that changed on disk, and offers to reload it', async () => {
    const props = await editorProps('CLAUDE.md', {
      external: { hash: 'other', content: '# Changed elsewhere\n', exists: true }
    })
    render(<ConfigEditor {...props} />)
    await userEvent.click(mode('Edit'))
    await userEvent.type(screen.getByRole('textbox', { name: 'Edit CLAUDE.md' }), 'mine')

    expect(screen.getByRole('alert').textContent).toContain('This file changed on disk after you opened it')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    expect(props.onReload).toHaveBeenCalledTimes(1)
    expect(props.onSave).not.toHaveBeenCalled()
  })
})
