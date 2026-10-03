import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type LiveSession, type Project } from '@helm/core/types'
import { ProjectPane } from './ProjectPane'

/**
 * The project pane's "already running here" warning: said beside the launch
 * button, before it is pressed, naming what is in this working tree.
 */

const PROJECT: Project = {
  path: 'C:\\work\\shop',
  name: 'shop',
  kind: 'repo',
  harnessPath: null,
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
}

function live(over: Partial<LiveSession> & Pick<LiveSession, 'pid'>): LiveSession {
  return {
    helmSessionId: null,
    registered: true,
    cwd: PROJECT.path,
    name: null,
    activity: 'idle',
    waitingFor: null,
    statusSinceMs: null,
    version: '2.1.999',
    entrypoint: 'cli',
    startedAtMs: null,
    claudeSessionId: null,
    ...over
  }
}

const HOSTED = live({ pid: 4100, helmSessionId: 1, name: 'shop' })
const OUTSIDE = live({ pid: 5100, name: 'terminal session' })

function renderPane(liveHere?: readonly LiveSession[]): { onLaunch: ReturnType<typeof vi.fn> } {
  const onLaunch = vi.fn()
  render(<ProjectPane project={PROJECT} onReveal={vi.fn()} onLaunch={onLaunch} liveHere={liveHere} />)
  return { onLaunch }
}

describe('ProjectPane, with sessions already running in the folder', () => {
  it('warns before the launch, naming each session and saying which one Helm did not start', () => {
    const { onLaunch } = renderPane([HOSTED, OUTSIDE])
    expect(screen.getByRole('button', { name: 'Start session here' })).toBeDefined()
    expect(screen.getByRole('note').textContent).toBe(
      '2 sessions are already running in this folder: shop, terminal session. ' +
        'One of them was not started by Helm, so it has no tab here. ' +
        'Starting another one here means two agents in one working tree.'
    )
    expect(onLaunch).not.toHaveBeenCalled()
  })

  it('says so of a single session Helm did not start', () => {
    renderPane([OUTSIDE])
    expect(screen.getByRole('note').textContent).toBe(
      'A session is already running in this folder: terminal session. ' +
        'It was not started by Helm, so it has no tab here. ' +
        'Starting another one here means two agents in one working tree.'
    )
  })

  it('says nothing for a folder with nothing running in it', () => {
    renderPane([])
    expect(screen.queryByRole('note')).toBeNull()
    renderPane(undefined)
    expect(screen.queryByRole('note')).toBeNull()
  })
})
