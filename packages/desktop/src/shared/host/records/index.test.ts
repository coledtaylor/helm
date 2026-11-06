import { describe, expect, it } from 'vitest'
import type * as P from '../protocol'
import { profileFromHost, sessionFromHost, splitSettingsPatch } from './index'

const hostSession = (patch: Partial<P.SessionRecord> = {}): P.SessionRecord => ({
  id: 9,
  name: 'reviewer',
  label: null,
  cwd: '/work/docs',
  branch: null,
  projectPath: null,
  profileId: null,
  argv: [],
  conversationId: null,
  backend: 'claude-code',
  status: 'running',
  startedAt: '2026-11-05T09:00:00.000Z',
  endedAt: null,
  durationMs: null,
  exitCode: null,
  ...patch
})

describe('a host session, as the window reads it', () => {
  it('carries a child’s parent, the parent’s name and its role', () => {
    const record = sessionFromHost(hostSession({ parentId: 4, parentName: 'lead', role: 'reviewer' }))
    expect(record).toMatchObject({ id: 9, parentId: 4, parentName: 'lead', role: 'reviewer' })
  })

  it('carries a session nobody started with neither a parent nor a role', () => {
    for (const bare of [hostSession(), hostSession({ parentId: null, parentName: null, role: null })]) {
      const record = sessionFromHost(bare)
      expect(record).not.toHaveProperty('parentId')
      expect(record).not.toHaveProperty('parentName')
      expect(record).not.toHaveProperty('role')
    }
  })

  it('keeps a role the parent’s row outlived, with no parent', () => {
    const record = sessionFromHost(hostSession({ parentId: null, parentName: null, role: 'reviewer' }))
    expect(record).toMatchObject({ role: 'reviewer' })
    expect(record).not.toHaveProperty('parentId')
  })
})

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
