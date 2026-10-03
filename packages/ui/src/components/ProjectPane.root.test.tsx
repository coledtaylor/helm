import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, isScanRoot, type Project } from '@helm/core/types'
import { ProjectPane } from './ProjectPane'

const ROOTS = ['C:\\Work\\My Repos']

const folder = (path: string, kind: Project['kind']): Project => ({
  path,
  name: path.split('\\').pop() ?? path,
  kind,
  harnessPath: null,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

/** The pane as the window draws it: Remove is passed only where the project is a root. */
function renderPane(project: Project, onRemoveRoot = vi.fn()) {
  render(
    <ProjectPane
      project={project}
      onReveal={vi.fn()}
      onLaunch={vi.fn()}
      {...(isScanRoot(ROOTS, project.path) ? { onRemoveRoot } : {})}
    />
  )
  return onRemoveRoot
}

describe('Remove root on the project pane', () => {
  it('counts a root by its own path, however it is spelled, and nothing inside it', () => {
    expect(isScanRoot(ROOTS, 'C:\\Work\\My Repos')).toBe(true)
    expect(isScanRoot(ROOTS, 'c:\\work\\my repos')).toBe(true)
    expect(isScanRoot(ROOTS, 'C:\\Work\\My Repos\\api')).toBe(false)
    expect(isScanRoot(ROOTS, 'C:\\Work')).toBe(false)
    expect(isScanRoot([], 'C:\\Work\\My Repos')).toBe(false)
  })

  it('is offered on a scan root’s pane, and removes that folder', async () => {
    const root = folder('C:\\Work\\My Repos', 'folder')
    const onRemoveRoot = renderPane(root)

    expect(screen.getByRole('heading', { name: 'Scanned folder' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Remove My Repos from Helm' }))
    expect(onRemoveRoot).toHaveBeenCalledWith(root)
  })

  it('is not offered on the pane of a project inside a root', () => {
    renderPane(folder('C:\\Work\\My Repos\\api', 'repo'))

    expect(screen.getByRole('heading', { level: 1, name: 'api' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /from Helm$/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Scanned folder' })).toBeNull()
  })
})
