import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type Project } from '@helm/core/types'
import { ProjectPane } from './ProjectPane'

const API: Project = {
  path: '/home/you/work/infra/repos/api',
  name: 'api',
  kind: 'repo',
  harnessPath: null,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
}

describe('ProjectPane for a folder on another host', () => {
  it('names build-box beside its path, offers no Show in Explorer, and starts a session from it', async () => {
    const onLaunch = vi.fn()
    const { container } = render(<ProjectPane project={API} host="build-box" onLaunch={onLaunch} />)
    expect(container.querySelector('[data-project-host]')?.textContent).toBe('on build-box')
    expect(screen.queryByTitle('Show in Explorer')).toBeNull()
    expect(container.querySelector('[data-project-path]')?.textContent).toBe('/home/you/work/infra/repos/api')
    await userEvent.click(screen.getAllByRole('button', { name: /Start/ })[0]!)
    expect(onLaunch).toHaveBeenCalledWith(API)
  })
})
