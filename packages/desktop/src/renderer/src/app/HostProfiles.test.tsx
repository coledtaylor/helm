import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile, SessionRecord } from '@helm/core'
import { bridge, remoteBridge } from './bridge.testkit'
import { HostProfiles } from './HostProfiles'

vi.mock('./bridge', () => import('./bridge.testkit'))
vi.mock('./terminals', () => ({ estimateGrid: () => ({ cols: 132, rows: 41 }) }))

const stamp = { createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z' }
const INFRA: Profile = {
  id: 5,
  name: 'infra',
  root: '/home/you/work/infra',
  overlays: [],
  access: [],
  model: null,
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: null,
  pinnedOrder: null,
  ...stamp
}
const STARTED = { id: 4, name: 'infra', label: null, cwd: INFRA.root, status: 'running' } as SessionRecord

beforeEach(() => {
  bridge.reset()
  bridge.whenUnanswered('pending')
  const box = remoteBridge('h1')
  box.reset()
  box.answer('profile:list', () => [INFRA])
  box.answer('profile:launch', () => ({
    session: STARTED,
    profile: INFRA,
    overlays: [],
    composedInstructions: false,
    warnings: []
  }))
})

describe('HostProfiles', () => {
  it('lists build-box’s profiles under its name and starts one on build-box only', async () => {
    const onLaunched = vi.fn()
    render(
      <HostProfiles
        host="h1"
        name="build-box"
        connected
        projects={[]}
        harnesses={[]}
        blank={(root, name) => ({ ...INFRA, root, name })}
        onLaunched={onLaunched}
        paneSize={() => null}
      />
    )
    expect(screen.getByRole('region', { name: 'Profiles on build-box' })).toBeTruthy()
    const row = await screen.findByTitle('infra — /home/you/work/infra')
    await userEvent.click(row)
    await waitFor(() => expect(onLaunched).toHaveBeenCalledWith(STARTED))
    expect(remoteBridge('h1').invoked('profile:launch')).toEqual([expect.objectContaining({ profileId: 5 })])
    expect(bridge.invocations).toEqual([])
  })
})
