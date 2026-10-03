import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type Harness, type Project } from '@helm/core/types'
import { ProjectPane, type ProjectPaneProps } from './ProjectPane'

const HUB = 'C:\\work\\hub'

const project = (path: string, name: string, kind: Project['kind']): Project => ({
  path,
  name,
  kind,
  harnessPath: kind === 'folder' ? null : HUB,
  hasClaudeDir: true,
  inventory: EMPTY_INVENTORY,
  git: null
})

const HUB_PROJECT = project(HUB, 'hub', 'harness')
const harness = (template: string | null): Harness => ({
  path: HUB,
  name: 'hub',
  template,
  version: null,
  repoPaths: []
})

function renderPane(overrides: Partial<ProjectPaneProps> = {}) {
  const props: ProjectPaneProps = { project: HUB_PROJECT, onReveal: vi.fn(), onLaunch: vi.fn(), ...overrides }
  render(<ProjectPane {...props} />)
  return props
}

describe('ProjectPane - harness provenance', () => {
  it('names the template a harness was created from', () => {
    renderPane({ harness: harness('client') })
    expect(screen.getByText('client').parentElement?.textContent).toBe('Created from the client template.')
  })

  it('says nothing about a template when the manifest names none', () => {
    renderPane({ harness: harness(null) })
    expect(screen.queryByText(/Created from the/)).toBeNull()
  })

  it('offers to save a harness as a template, and hands over the harness', async () => {
    const onSaveAsTemplate = vi.fn()
    renderPane({ harness: harness('client'), onSaveAsTemplate })
    await userEvent.click(screen.getByRole('button', { name: 'Save as template' }))
    expect(onSaveAsTemplate).toHaveBeenCalledWith(HUB_PROJECT)
  })
})
