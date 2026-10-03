import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigNewDialog,
  ConfigRenameDialog
} from './ConfigFileDialogs'
import { makeConfigFixture, type ConfigFixture } from './ConfigFixture.testkit'

/**
 * New, Rename and Delete for an entry in a `.claude` tree, over the tree core
 * read for a project on disk.
 */

let fixture: ConfigFixture

beforeAll(() => {
  fixture = makeConfigFixture()
})

afterAll(() => fixture.dispose())

describe('ConfigNewDialog', () => {
  const renderNew = () => {
    const props = {
      scope: fixture.scope,
      files: fixture.tree.files,
      busy: false,
      error: null,
      onCreate: vi.fn(),
      onCancel: vi.fn()
    }
    render(<ConfigNewDialog {...props} />)
    return props
  }

  it('previews where the file will land and how it is addressed, then creates it', async () => {
    const props = renderNew()
    const dialog = screen.getByRole('dialog', { name: 'New in app' })

    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'What to create' }), 'command')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'review:deep')

    expect(within(dialog).getByText('.claude/commands/review/deep.md')).toBeTruthy()
    expect(within(dialog).getByText('/review:deep')).toBeTruthy()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(props.onCreate).toHaveBeenCalledWith('command', 'review:deep')
  })

  it('holds Create back, says why under the field, and stays open for a taken or bad name', async () => {
    const props = renderNew()
    const dialog = screen.getByRole('dialog', { name: 'New in app' })
    const name = within(dialog).getByRole('textbox', { name: 'Name' })
    const create = within(dialog).getByRole('button', { name: 'Create' }) as HTMLButtonElement

    // A skill called `think` is already in the fixture.
    await userEvent.type(name, 'think')
    expect(create.disabled).toBe(true)
    expect(within(dialog).getByRole('alert').textContent).toContain('.claude/skills/think/SKILL.md is already there')

    await userEvent.clear(name)
    await userEvent.type(name, 'Not Valid!')
    expect(create.disabled).toBe(true)
    expect(within(dialog).getByRole('alert').textContent).not.toBe('')

    await userEvent.click(create)
    expect(props.onCreate).not.toHaveBeenCalled()
    expect(props.onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'New in app' })).toBeTruthy()
  })
})

describe('ConfigRenameDialog', () => {
  it('previews the destination of a skill’s folder, and applies the new name', async () => {
    const props = {
      scope: fixture.scope,
      file: fixture.file('.claude/skills/think/SKILL.md'),
      files: fixture.tree.files,
      busy: false,
      error: null,
      onRename: vi.fn(),
      onCancel: vi.fn()
    }
    render(<ConfigRenameDialog {...props} />)
    const dialog = screen.getByRole('dialog', { name: 'Rename think' })
    const name = within(dialog).getByRole('textbox', { name: 'New name' }) as HTMLInputElement
    expect(name.value).toBe('think')
    expect(within(dialog).getByText('Type a different name to see where it would go.')).toBeTruthy()

    await userEvent.clear(name)
    await userEvent.type(name, 'ponder')
    expect(within(dialog).getByText(/→ \.claude\/skills\/ponder\/SKILL\.md/)).toBeTruthy()
    expect(within(dialog).getByText(/the SKILL\.md and the file beside it/)).toBeTruthy()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }))
    expect(props.onRename).toHaveBeenCalledWith('ponder')
  })
})

describe('ConfigDeleteDialog', () => {
  it('lists every file that goes, says Undo brings them back, and starts on Cancel', async () => {
    const props = {
      file: fixture.file('.claude/skills/think/SKILL.md'),
      files: fixture.tree.files,
      busy: false,
      error: null,
      onDelete: vi.fn(),
      onCancel: vi.fn()
    }
    render(<ConfigDeleteDialog {...props} />)
    const dialog = screen.getByRole('alertdialog', { name: 'Delete think' })

    const listed = within(within(dialog).getByRole('list'))
      .getAllByRole('listitem')
      .map((item) => item.getAttribute('title'))
    expect(listed.sort()).toEqual(
      [fixture.file('.claude/skills/think/SKILL.md').path, fixture.file('.claude/skills/think/prompts.md').path].sort()
    )
    expect(dialog.textContent).toContain('Undo puts them back')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }))

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(props.onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('ConfigDeletedNotice', () => {
  it('offers Undo after a delete', async () => {
    const onUndo = vi.fn()
    render(<ConfigDeletedNotice label="think" fileCount={2} busy={false} onUndo={onUndo} onDismiss={vi.fn()} />)
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('Deleted think')
    expect(notice.textContent).toContain('2 files kept in its history')
    await userEvent.click(within(notice).getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledTimes(1)
  })
})
