import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginInfo } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { usePlugins } from './usePlugins'

vi.mock('./bridge', () => import('./bridge.testkit'))

const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({
  path: 'C:\\plugins\\sample',
  id: 'sample',
  name: 'Sample',
  version: '1.0.0',
  description: null,
  enabled: true,
  error: null,
  warnings: [],
  revision: 1,
  icon: null,
  rail: null,
  panels: {},
  tabs: {},
  pageStrip: false,
  background: null,
  commands: [],
  settings: [],
  settingValues: {},
  network: [],
  secrets: [],
  exec: [],
  service: null,
  runsPrograms: false,
  agent: null,
  status: null,
  badge: null,
  ...overrides
})

const on = plugin()
const off = plugin({ path: 'C:\\plugins\\off', id: 'off', name: 'Off', enabled: false })
const broken = plugin({ path: 'C:\\plugins\\broken', id: 'broken', name: 'Broken', error: 'apiVersion 2 is not supported' })
const unnamed = plugin({ path: 'C:\\plugins\\empty', id: null, name: 'empty', error: 'no helm-plugin.json' })

afterEach(() => {
  bridge.reset()
})

describe('usePlugins', () => {
  it('is null until main answers, then every folder, with only the enabled and loaded ones live', async () => {
    bridge.answer('plugins:list', () => [on, off, broken, unnamed])
    const { result } = renderHook(() => usePlugins())
    // Not read yet is not "no plugins": a restored plugin tab waits on this.
    expect(result.current.list).toBeNull()

    await waitFor(() => expect(result.current.list).toEqual([on, off, broken, unnamed]))
    expect([...result.current.live.keys()]).toEqual(['sample'])
    expect(result.current.live.get('sample')).toBe(on)
  })

  it('takes each change main pushes, whole', async () => {
    bridge.answer('plugins:list', () => [on])
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.list).toEqual([on]))

    const turnedOn = { ...off, enabled: true }
    act(() => bridge.emit('plugins:changed', [{ ...on, enabled: false }, turnedOn]))
    expect(result.current.list?.map((each) => each.id)).toEqual(['sample', 'off'])
    expect([...result.current.live.keys()]).toEqual(['off'])
  })

  it('keeps a change that arrived while the first read was on its way', async () => {
    let answer: (list: PluginInfo[]) => void = () => undefined
    bridge.answer('plugins:list', () => new Promise<PluginInfo[]>((resolve) => (answer = resolve)))
    const { result } = renderHook(() => usePlugins())

    act(() => bridge.emit('plugins:changed', [on, off]))
    await act(async () => {
      answer([on])
      // A macrotask: every promise callback the read set off has run by then.
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(result.current.list).toEqual([on, off])
  })

  it('reads a list main could not give as empty, not as still waiting', async () => {
    // Nothing answers `plugins:list`: the invoke rejects.
    const { result } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.list).toEqual([]))
    expect(result.current.live.size).toBe(0)
  })

  it('stops listening when it unmounts', async () => {
    bridge.answer('plugins:list', () => [on])
    const { result, unmount } = renderHook(() => usePlugins())
    await waitFor(() => expect(result.current.list).toEqual([on]))
    unmount()

    // A push after unmount reaches no listener, so nothing renders and nothing warns.
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bridge.emit('plugins:changed', [off])
    expect(result.current.list).toEqual([on])
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })
})
