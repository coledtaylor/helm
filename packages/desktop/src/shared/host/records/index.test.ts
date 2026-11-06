import { describe, expect, it } from 'vitest'
import type * as P from '../protocol'
import { profileFromHost, splitSettingsPatch } from './index'

const hostProfile = (patch: Partial<P.Profile> = {}): P.Profile => ({
  id: 3,
  name: 'hub dev',
  root: '/work/hub',
  overlays: [],
  access: [],
  model: null,
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: null,
  pinnedOrder: null,
  createdAt: '2026-10-29T09:00:00.000Z',
  updatedAt: '2026-10-29T09:00:00.000Z',
  ...patch
})

describe('a host profile, as the window reads it', () => {
  it('keeps the choice to turn the session agents off', () => {
    expect(profileFromHost(hostProfile({ sessionAgents: false })).sessionAgents).toBe(false)
  })

  it('has no choice where the host has none or follows the setting', () => {
    expect(profileFromHost(hostProfile())).not.toHaveProperty('sessionAgents')
    expect(profileFromHost(hostProfile({ sessionAgents: null }))).not.toHaveProperty('sessionAgents')
  })
})

describe('a window settings patch, split between the host and Helm', () => {
  it('keeps what quitting does on this device, never in the host', () => {
    const split = splitSettingsPatch({ quitSessions: { local: 'keep' }, scanRoots: ['/work'] })

    expect(split.own).toEqual({ quitSessions: { local: 'keep' } })
    expect(split.host).toEqual({ scanRoots: ['/work'] })
    expect(split.host).not.toHaveProperty('quitSessions')
  })

  it('keeps the tabs, panes and splits on this device, never in the host', () => {
    const paneLayout = {
      root: {
        axis: 'row' as const,
        children: [
          { panes: [{ kind: 'session' as const, id: 7 }], activeId: 'session:7' },
          { panes: [{ kind: 'history' as const }], activeId: 'history' }
        ],
        sizes: [0.3, 0.7]
      },
      focused: 1
    }
    const split = splitSettingsPatch({ paneLayout })

    expect(split.own).toEqual({ paneLayout })
    expect(split.host).toEqual({})
  })
})
