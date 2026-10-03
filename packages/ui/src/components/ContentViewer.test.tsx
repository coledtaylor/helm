import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildCorpus,
  contentScope,
  readContentDir,
  readContentTree,
  searchCorpus,
  type ContentDirListing,
  type ContentScope,
  type ContentTree
} from '@helm/core'
import { ContentViewer, type ContentViewerProps } from './ContentViewer'
import { expectOnThePane } from './page.testkit'

/**
 * The content viewer's list column, painted from what core actually reads off
 * two scopes on disk: a harness, read as curated roots, and a git project, read
 * as a tree.
 */

function write(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), body)
}

let base: string
let harness: ContentScope
let project: ContentScope
let harnessTree: ContentTree
let projectTree: ContentTree

/** What each file in the harness is, by its extension - the expectation, written down. */
const HARNESS_FILES: Record<string, string> = {
  'notes/alpha.md': 'markdown',
  'notes/beta.md': 'markdown',
  'docs/report.html': 'html',
  'tools/rebuild.py': 'source',
  'tools/logo.png': 'binary'
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'helm content view-'))

  const harnessDir = join(base, 'vault')
  write(harnessDir, 'notes/alpha.md', '---\ntype: journal\ntags: [helm]\n---\n# Alpha note\n\nThe quokka sees [[beta]].\n')
  write(harnessDir, 'notes/beta.md', '# Beta note\n\nA quokka, and another quokka.\n')
  write(harnessDir, 'docs/report.html', '<html><head><title>Report</title></head><body>quokka</body></html>\n')
  write(harnessDir, 'tools/rebuild.py', 'print("quokka")\n')
  write(harnessDir, 'tools/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]).toString('latin1'))
  // A named root that holds nothing.
  mkdirSync(join(harnessDir, 'context'))
  harness = contentScope(harnessDir, 'harness', 'vault')
  harnessTree = readContentTree(harness)

  const projectDir = join(base, 'app')
  write(projectDir, '.gitignore', 'build/\n')
  write(projectDir, 'build/out.txt', 'generated\n')
  write(projectDir, 'src/main.ts', 'export const main = 1\n')
  write(projectDir, 'notes/todo.md', '# Todo\n')
  execFileSync('git', ['init', '-q'], { cwd: projectDir, stdio: 'ignore' })
  project = contentScope(projectDir, 'project', 'app')
  projectTree = readContentTree(project)
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

function renderViewer(overrides: Partial<ContentViewerProps> = {}) {
  const props: ContentViewerProps = {
    scopes: [harness, project],
    scopePath: harness.path,
    onScopeChange: vi.fn(),
    tree: harnessTree,
    treeLoading: false,
    view: 'curated',
    onViewChange: vi.fn(),
    viewIsDefault: true,
    dirs: new Map(),
    expanded: new Set(),
    onToggleDir: vi.fn(),
    loadingDirs: new Set(),
    query: '',
    onQueryChange: vi.fn(),
    search: null,
    searching: false,
    selected: null,
    selectedPath: null,
    onSelect: vi.fn(),
    onOpenPath: vi.fn(),
    onReveal: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    children: null,
    ...overrides
  }
  const view = render(<ContentViewer {...props} />)
  return { props, ...view }
}

const files = (): HTMLElement => screen.getByRole('group', { name: 'Content files' })

/**
 * A file row, by the path in its tooltip. Section headings are buttons too,
 * and carry no tooltip.
 */
const fileRows = (scope: ContentScope): Map<string, HTMLElement> =>
  new Map(
    within(files())
      .getAllByRole('button')
      .filter((row) => (row.getAttribute('title') ?? '').startsWith(scope.path))
      .map((row) => [
        (row.getAttribute('title') ?? '').split('\n')[0]!.slice(scope.path.length + 1).replaceAll('\\', '/'),
        row
      ])
  )

/** The listing core reads for one directory of a scope. */
async function listing(scope: ContentScope, relPath: string): Promise<ContentDirListing> {
  return readContentDir(scope, relPath)
}

describe('ContentViewer: curated', () => {
  it('paints one row per file in the tree, each tagged with its kind', () => {
    expect(harnessTree.files.map((file) => file.relPath).sort()).toEqual(Object.keys(HARNESS_FILES).sort())
    renderViewer()

    const rows = fileRows(harness)
    expect([...rows.keys()].sort()).toEqual(Object.keys(HARNESS_FILES).sort())
    for (const [rel, kind] of Object.entries(HARNESS_FILES)) {
      expect(rows.get(rel)?.getAttribute('data-content-kind'), rel).toBe(kind)
    }
    // The script is labelled as source by its extension, and the binary is
    // listed rather than hidden, with a tooltip saying it is not opened.
    expect(rows.get('tools/rebuild.py')?.textContent).toContain('py')
    expect(rows.get('tools/logo.png')?.getAttribute('title')).toMatch(/Not a kind Helm reads/)
  })

  it('names the rule the mode follows, and whose choice it was', () => {
    const { rerender, props } = renderViewer()
    expect(screen.getByText('harness default - curated roots')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Curated' }).getAttribute('aria-pressed')).toBe('true')

    rerender(<ContentViewer {...props} viewIsDefault={false} />)
    expect(screen.getByText('curated roots')).toBeTruthy()
    expect(screen.queryByText(/default/)).toBeNull()
  })

  it('keeps an empty named root on the list, badged named, and says it is empty', () => {
    renderViewer()
    const context = screen.getByRole('button', { name: /context/i, expanded: true })
    expect(context.textContent).toContain('NAMED')
    expect(context.textContent).toMatch(/0$/)
    expect(within(files()).getByText('empty')).toBeTruthy()
    expect(screen.getByText('context/ empty')).toBeTruthy()
  })

  it('reads a project as curated roots when asked', () => {
    renderViewer({ scopePath: project.path, tree: projectTree, view: 'curated', viewIsDefault: false })
    expect([...fileRows(project).keys()]).toContain('notes/todo.md')
    expect(screen.getByText('curated roots')).toBeTruthy()
  })

  it('collapses a root and opens it again', async () => {
    renderViewer()
    const notes = screen.getByRole('button', { name: /notes/i, expanded: true })
    await userEvent.click(notes)
    expect(notes.getAttribute('aria-expanded')).toBe('false')
    expect(fileRows(harness).has('notes/alpha.md')).toBe(false)
    await userEvent.click(notes)
    expect(fileRows(harness).has('notes/alpha.md')).toBe(true)
  })
})

describe('ContentViewer: tree', () => {
  it('walks a harness as a tree, its top-level directories as rows', async () => {
    const root = await listing(harness, '')
    renderViewer({ view: 'tree', viewIsDefault: false, dirs: new Map([['', root]]) })

    for (const dir of ['context/', 'docs/', 'notes/', 'tools/']) {
      expect(within(files()).getByRole('button', { name: dir })).toBeTruthy()
    }
    expect(screen.getByText('every file, lazy per directory, gitignore-aware')).toBeTruthy()
  })

  it('marks what the repository ignores, from its own .gitignore, and counts it', async () => {
    const root = await listing(project, '')
    expect(root.ignoreSource).toBe('gitignore')
    renderViewer({ scopePath: project.path, tree: projectTree, view: 'tree', dirs: new Map([['', root]]) })

    expect(screen.getByText('project default - every file, lazy per directory, gitignore-aware')).toBeTruthy()
    const build = within(files()).getByRole('button', { name: /^build\// })
    expect(build.textContent).toContain('IGNORED')
    expect(within(files()).getByRole('button', { name: /^src\// }).textContent).not.toContain('IGNORED')
    expect(screen.getByText(/\.gitignore respected/)).toBeTruthy()
    // `build/` by the repository's rule, and git's own directory, which git
    // never tracks either.
    const ignored = within(files())
      .getAllByRole('button')
      .filter((row) => row.textContent?.includes('IGNORED'))
      .map((row) => row.textContent?.replace('IGNORED', ''))
    expect(ignored.sort()).toEqual(['.git/', 'build/'])
    expect(screen.getByText('2 ignored')).toBeTruthy()
  })

  it('paints a folder’s children once it is expanded, and not before', async () => {
    const root = await listing(project, '')
    const { props, rerender } = renderViewer({
      scopePath: project.path,
      tree: projectTree,
      view: 'tree',
      dirs: new Map([['', root]])
    })

    expect(within(files()).queryByRole('button', { name: 'main.ts' })).toBeNull()
    await userEvent.click(within(files()).getByRole('button', { name: 'src/' }))
    expect(props.onToggleDir).toHaveBeenCalledWith('src')

    const src = await listing(project, 'src')
    rerender(
      <ContentViewer
        {...props}
        dirs={new Map([
          ['', root],
          ['src', src]
        ])}
        expanded={new Set(['src'])}
      />
    )
    expect(within(files()).getByRole('button', { name: 'src/' }).getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(within(files()).getByRole('button', { name: 'main.ts' }))
    expect(props.onOpenPath).toHaveBeenCalledWith(join(project.path, 'src', 'main.ts'))
  })
})

describe('ContentViewer: search', () => {
  it('paints the hits and a status line saying what was searched', async () => {
    const result = searchCorpus(buildCorpus(harness.path, harnessTree.files), 'quokka', false)
    const { props, rerender } = renderViewer()

    await userEvent.type(screen.getByRole('textbox', { name: 'Search the text of this scope’s content' }), 'q')
    expect(props.onQueryChange).toHaveBeenLastCalledWith('q')

    rerender(<ContentViewer {...props} query="quokka" search={result} />)
    // Bodies read: the two notes and the script; the report is HTML and the
    // logo is binary, so both are matched on their names only. The word is in
    // beta twice and in alpha and the script once each.
    expect(screen.getByText(/text in/).textContent).toContain('text in 3, names in 5')
    expect(screen.getByText('4 matches')).toBeTruthy()
    expect(screen.getByText('3 files')).toBeTruthy()
    const hits = within(files())
      .getAllByRole('button')
      .filter((button) => button.getAttribute('title') !== null)
      .map((button) => button.getAttribute('title'))
    expect(hits).toEqual([
      join(harness.path, 'notes', 'beta.md'),
      join(harness.path, 'notes', 'alpha.md'),
      join(harness.path, 'tools', 'rebuild.py')
    ])
  })

  it('says when more files matched than are listed', () => {
    const result = searchCorpus(buildCorpus(harness.path, harnessTree.files), 'quokka', false, 1)
    expect(result.truncated).toBe(true)
    renderViewer({ query: 'quokka', search: result })
    expect(screen.getByText('More files matched than are listed. Narrow the search.')).toBeTruthy()
  })
})

describe('ContentViewer on its pane', () => {
  it('draws no island of its own, and its bar repeats no title the tab already says', () => {
    renderViewer()
    expectOnThePane(document.body, 'content')
  })
})
