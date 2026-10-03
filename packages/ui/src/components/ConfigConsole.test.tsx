import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ConfigFile } from '@helm/core'
import { bundledWith, ConfigConsole, skillHolding, type ConfigConsoleProps } from './ConfigConsole'
import { makeConfigFixture, type ConfigFixture } from './ConfigFixture.testkit'
import { expectOnThePane } from './page.testkit'

/**
 * The config console's file list, painted from a `.claude` tree core read off
 * disk and the resolution core computed for it.
 */

let fixture: ConfigFixture

beforeAll(() => {
  fixture = makeConfigFixture()
})

afterAll(() => fixture.dispose())

const EXPECTED_FILES = [
  'CLAUDE.md',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude/hooks/guard.js',
  '.claude/skills/think/SKILL.md',
  '.claude/skills/think/prompts.md',
  '.claude/commands/spec/plan.md',
  '.claude/agents/reviewer.md'
]

function renderConsole(overrides: Partial<ConfigConsoleProps> = {}) {
  const props: ConfigConsoleProps = {
    scopes: [fixture.scope],
    scopePath: fixture.scope.path,
    onScopeChange: vi.fn(),
    view: 'files',
    onViewChange: vi.fn(),
    tree: fixture.tree,
    treeLoading: false,
    live: null,
    selected: null,
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    refreshing: false,
    children: null,
    ...overrides
  }
  return { props, ...render(<ConfigConsole {...props} />) }
}

const list = (): HTMLElement => screen.getByRole('group', { name: 'Configuration files' })

/** File rows, by the path in their tooltip. Section headings carry none. */
const rows = (): Map<string, HTMLElement> =>
  new Map(
    within(list())
      .getAllByRole('button')
      .filter((row) => (row.getAttribute('title') ?? '').startsWith(fixture.project))
      .map((row) => [
        (row.getAttribute('title') ?? '').split('\n')[0]!.slice(fixture.project.length + 1).replaceAll('\\', '/'),
        row
      ])
  )

describe('bundledWith and skillHolding', () => {
  const file = (relPath: string, kind: ConfigFile['kind']): ConfigFile => ({
    path: `C:\\p\\${relPath.replaceAll('/', '\\')}`,
    relPath,
    kind,
    name: relPath,
    size: 1,
    mtimeMs: 0,
    description: null,
    binary: false
  })
  const skill = file('.claude/skills/think/SKILL.md', 'skill')
  const prompts = file('.claude/skills/think/prompts.md', 'other')
  const deeper = file('.claude/skills/think/refs/deep.md', 'other')
  const nested = file('.claude/skills/think/inner/SKILL.md', 'skill')
  const nestedFile = file('.claude/skills/think/inner/notes.md', 'other')
  const elsewhere = file('.claude/skills/other/notes.md', 'other')
  const files = [skill, prompts, deeper, nested, nestedFile, elsewhere]

  it('gives a skill the files directly beside its SKILL.md, and nothing deeper or elsewhere', () => {
    expect(bundledWith(skill, files)).toEqual([prompts])
    expect(bundledWith(nested, files)).toEqual([nestedFile])
    expect(bundledWith(prompts, files)).toEqual([])
  })

  it('finds the skill a bundled file belongs to', () => {
    expect(skillHolding(prompts, files)).toBe(skill)
    expect(skillHolding(nestedFile, files)).toBe(nested)
    expect(skillHolding(deeper, files)).toBeNull()
    expect(skillHolding(skill, files)).toBeNull()
  })
})

describe('ConfigConsole: the file list', () => {
  it('paints one row per file, except a skill’s bundled files, which ride on the skill’s row', () => {
    expect(fixture.tree.files.map((file) => file.relPath).sort()).toEqual([...EXPECTED_FILES].sort())
    renderConsole()

    expect([...rows().keys()].sort()).toEqual(
      EXPECTED_FILES.filter((relPath) => relPath !== '.claude/skills/think/prompts.md').sort()
    )
    const skill = rows().get('.claude/skills/think/SKILL.md')
    expect(skill?.textContent).toContain('think')
    expect(skill?.textContent).toContain('prompts.md')
    expect(screen.getByText('7 entries · 8 files')).toBeTruthy()
  })

  it('says nothing about live state until the resolution arrives, then says it on each row', () => {
    const { rerender, props } = renderConsole()
    const before = rows().get('.claude/skills/think/SKILL.md')
    expect(before?.textContent).toContain('Think before acting')
    expect(before?.textContent).not.toContain('resolves as')

    rerender(<ConfigConsole {...props} live={fixture.view} />)
    expect(rows().get('.claude/skills/think/SKILL.md')?.textContent).toContain('resolves as think')
    expect(rows().get('.claude/commands/spec/plan.md')?.textContent).toContain('available as /spec:plan')
    expect(rows().get('.claude/settings.json')?.textContent).toMatch(/1 of 4 keys outranked/)
  })

  it('hides a section’s rows when it is collapsed and brings them back when expanded', async () => {
    renderConsole()
    const skills = within(list()).getByRole('button', { name: /^Skills/ })
    expect(skills.getAttribute('aria-expanded')).toBe('true')

    await userEvent.click(skills)
    expect(skills.getAttribute('aria-expanded')).toBe('false')
    expect(rows().has('.claude/skills/think/SKILL.md')).toBe(false)
    expect(rows().has('.claude/commands/spec/plan.md')).toBe(true)

    await userEvent.click(skills)
    expect(rows().has('.claude/skills/think/SKILL.md')).toBe(true)
  })

  it('opens a row on click', async () => {
    const { props } = renderConsole()
    await userEvent.click(rows().get('.claude/agents/reviewer.md')!)
    expect(props.onSelect).toHaveBeenCalledWith(fixture.file('.claude/agents/reviewer.md'))
  })
})

describe('ConfigConsole on its pane', () => {
  it('draws no island of its own, and its bar repeats no title the tab already says', () => {
    renderConsole()
    expectOnThePane(document.body, 'config')
  })
})
