import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CachedProject } from '@helm/core'
import { DEFAULT_SETTINGS, EMPTY_INVENTORY } from '@helm/core/types'
import type { AppInfo } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { useLauncher } from './useLauncher'

vi.mock('./bridge', () => import('./bridge.testkit'))

const ROOT = 'C:\\work'
const HUB = 'C:\\work\\hub'
const TOOLS = 'C:\\work\\hub\\repos\\tools'

const cached = (path: string, name: string, kind: CachedProject['kind'], template: string | null): CachedProject => ({
  path,
  name,
  kind,
  harnessPath: HUB,
  hasClaudeDir: true,
  inventory: EMPTY_INVENTORY,
  git: null,
  lastSeenAt: '2026-10-01T00:00:00.000Z',
  template
})

/**
 * A cold start, before the first scan lands: the tree is painted from the
 * discovery cache, and a harness's provenance has to be in that first frame.
 */
describe('useLauncher on a cold start', () => {
  beforeEach(() => {
    bridge.reset()
    bridge.answer('app:info', () => ({ version: '0.0.0-test' }) as AppInfo)
    bridge.answer('settings:read', () => ({ ...DEFAULT_SETTINGS, scanRoots: [ROOT] }))
  })

  it('carries the template a harness was built from out of the cache', async () => {
    bridge.answer('discovery:cached', () => [
      cached(HUB, 'hub', 'harness', 'client'),
      cached(TOOLS, 'tools', 'repo', null)
    ])
    const { result } = renderHook(() => useLauncher())

    await waitFor(() => expect(result.current.discovery).not.toBeNull())
    expect(result.current.discovery?.roots).toEqual([ROOT])
    expect(result.current.discovery?.harnesses.map(({ path, name, template }) => ({ path, name, template }))).toEqual([
      { path: HUB, name: 'hub', template: 'client' }
    ])
    expect(bridge.sends.map((send) => send.channel)).toContain('renderer:ready')
  })
})
