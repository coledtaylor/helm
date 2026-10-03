import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ContentDirEntry, ContentDirListing, FilesStatus } from '@helm/core'
import { FilesRootPicker, FilesStatusNote, FilesTree, type FilesTreeProps } from './FilesTree'

const ROOT = 'C:\\p'

function entry(relPath: string, directory = false, extra: Partial<ContentDirEntry> = {}): ContentDirEntry {
  const name = relPath.split('/').at(-1) ?? relPath
  return {
    name,
    relPath,
    path: `${ROOT}\\${relPath.replaceAll('/', '\\')}`,
    directory,
    link: false,
    kind: directory ? null : 'source',
    ext: directory ? '' : 'ts',
    size: 1,
    mtimeMs: 0,
    ignored: false,
    ignoredBy: null,
    ...extra
  }
}

function listing(relPath: string, entries: ContentDirEntry[]): ContentDirListing {
  return { scopePath: ROOT, relPath, entries, ignored: 0, ignoreSource: 'gitignore', error: null, tookMs: 0 }
}

const STATUS: FilesStatus = {
  root: ROOT,
  repo: ROOT,
  files: { 'src/a.ts': 'modified', 'new.ts': 'untracked' },
  error: null
}

function renderTree(overrides: Partial<FilesTreeProps> = {}) {
  const props: FilesTreeProps = {
    rootLabel: 'p',
    dirs: new Map([
      ['', listing('', [entry('src', true), entry('node_modules', true, { ignored: true, ignoredBy: 'gitignore' }), entry('new.ts')])],
      ['src', listing('src', [entry('src/a.ts'), entry('src/b.ts')])]
    ]),
    expanded: new Set(['src']),
    loading: new Set(),
    status: STATUS,
    selectedPath: `${ROOT}\\src\\b.ts`,
    onToggleDir: vi.fn(),
    onOpen: vi.fn(),
    onReveal: vi.fn(),
    onCopyPath: vi.fn(),
    onOpenInEditor: vi.fn(),
    onGoToFile: vi.fn(),
    ...overrides
  }
  render(<FilesTree {...props} />)
  return props
}

const row = (relPath: string): HTMLElement =>
  document.querySelector(`[data-files-entry="${relPath}"]`) as HTMLElement

describe('FilesTree', () => {
  it('puts git’s letter on a changed file and marks the folder that holds one', () => {
    renderTree()
    expect(within(row('src/a.ts')).getByLabelText('Modified').textContent).toBe('M')
    expect(within(row('new.ts')).getByLabelText('Untracked').textContent).toBe('U')
    expect(within(row('src')).getByLabelText('Holds changed files')).toBeTruthy()
    expect(within(row('src/b.ts')).queryByLabelText('Modified')).toBeNull()
  })

  it('opens a file as a preview on a click and to keep on a double click, and opens folders in place', () => {
    const props = renderTree()
    fireEvent.click(within(row('src/b.ts')).getByRole('button', { name: /b\.ts/ }))
    expect(props.onOpen).toHaveBeenLastCalledWith(`${ROOT}\\src\\b.ts`, false)
    fireEvent.doubleClick(within(row('src/b.ts')).getByRole('button', { name: /b\.ts/ }))
    expect(props.onOpen).toHaveBeenLastCalledWith(`${ROOT}\\src\\b.ts`, true)

    const folder = within(row('src')).getByRole('button', { name: /src/, expanded: true })
    fireEvent.click(folder)
    expect(props.onToggleDir).toHaveBeenCalledWith('src')
    // An ignored folder is listed and never walked: it has nothing to expand.
    expect(within(row('node_modules')).getByRole('button', { name: /node_modules/ }).hasAttribute('aria-expanded')).toBe(false)
  })

  it('marks the file in front and offers VS Code, Explorer and the path on every row', () => {
    const props = renderTree()
    expect(within(row('src/b.ts')).getByRole('button', { name: /b\.ts/ }).getAttribute('aria-current')).toBe('true')

    const actions = within(row('src/a.ts'))
    fireEvent.click(actions.getByRole('button', { name: 'Open file in VS Code' }))
    fireEvent.click(actions.getByRole('button', { name: 'Reveal in Explorer' }))
    fireEvent.click(actions.getByRole('button', { name: 'Copy path' }))
    expect(props.onOpenInEditor).toHaveBeenCalledWith(`${ROOT}\\src\\a.ts`)
    expect(props.onReveal).toHaveBeenCalledWith(`${ROOT}\\src\\a.ts`)
    expect(props.onCopyPath).toHaveBeenCalledWith(`${ROOT}\\src\\a.ts`)
    expect(actions.getByRole('button', { name: 'Path copied' })).toBeTruthy()
    expect(within(row('src')).getByRole('button', { name: 'Open folder in VS Code' })).toBeTruthy()
  })

  it('offers no VS Code where there is none, and Go to file opens Ctrl+P', () => {
    const props = renderTree({ onOpenInEditor: null })
    expect(screen.queryByRole('button', { name: /in VS Code/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Go to file/ }))
    expect(props.onGoToFile).toHaveBeenCalled()
  })

  it('says a project could not be read rather than drawing nothing', () => {
    renderTree({ dirs: new Map([['', { ...listing('', []), error: 'EACCES' }]]) })
    expect(screen.getByRole('alert').textContent).toBe('p could not be read: EACCES')
  })
})

describe('FilesStatusNote', () => {
  it('tells "could not ask git" apart from "no repository", and says nothing for a repository git answered', () => {
    const { rerender, container } = render(<FilesStatusNote status={{ ...STATUS, files: null, error: 'no git' }} />)
    expect(container.textContent).toBe('Could not read git status: no git')
    rerender(<FilesStatusNote status={{ ...STATUS, repo: null, files: {} }} />)
    expect(container.textContent).toBe('Not a git repository - no changes to mark')
    rerender(<FilesStatusNote status={STATUS} />)
    expect(container.textContent).toBe('')
  })
})

describe('FilesRootPicker', () => {
  it('shows the project on screen, even one no scan listed', () => {
    const onChange = vi.fn()
    render(
      <FilesRootPicker
        roots={[{ kind: 'project', path: 'C:\\a', label: 'a' }]}
        value={'C:\\work\\elsewhere'}
        onChange={onChange}
      />
    )
    const picker = screen.getByRole('button', { name: 'Project' })
    expect(picker.textContent).toBe('elsewhere')
    fireEvent.click(picker)
    const options = within(screen.getByRole('listbox', { name: 'Projects' })).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['elsewhere', 'a'])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(options[1]!)
    expect(onChange).toHaveBeenCalledWith('C:\\a')
    // A pick closes the list.
    expect(screen.queryByRole('listbox', { name: 'Projects' })).toBeNull()
  })

  it('is driven from the keyboard: down opens it on the current project, letters jump, Enter picks, Escape closes', () => {
    const onChange = vi.fn()
    render(
      <FilesRootPicker
        roots={[
          { kind: 'harness', path: 'C:\\dev', label: 'dev' },
          { kind: 'project', path: 'C:\\dev\\repos\\helm', label: 'helm' },
          { kind: 'project', path: 'C:\\dev\\repos\\hub', label: 'hub' }
        ]}
        value={'C:\\dev\\repos\\helm'}
        onChange={onChange}
      />
    )
    const picker = screen.getByRole('button', { name: 'Project' })
    picker.focus()
    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    const list = screen.getByRole('listbox', { name: 'Projects' })
    // The keys go to the list, not the button that opened it.
    expect(document.activeElement).toBe(list)
    const active = (): string | null =>
      document.getElementById(list.getAttribute('aria-activedescendant') ?? '')?.textContent ?? null
    expect(active()).toBe('helm')
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(active()).toBe('hub')
    fireEvent.keyDown(list, { key: 'd' })
    expect(active()).toBe('dev')
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    // And back to the button once it closes.
    expect(document.activeElement).toBe(picker)

    fireEvent.keyDown(picker, { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('C:\\dev')
  })
})
