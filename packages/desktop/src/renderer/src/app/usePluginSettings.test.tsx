import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginInfo, PluginLogLine, PluginMetrics, SecretsState } from '../../../shared/ipc'
import { bridge } from './bridge.testkit'
import { usePluginSettings } from './usePluginSettings'

vi.mock('./bridge', () => import('./bridge.testkit'))

const SAMPLE = 'C:\\plugins\\sample'
const OTHER = 'C:\\plugins\\other'

const stored = (key: string): SecretsState => ({
  available: true,
  secrets: [{ key, hosts: ['https://api.example.com'], plugins: ['sample'], updatedAt: '2026-10-05T10:00:00.000Z' }]
})

const figures = (path: string, memoryKb: number): PluginMetrics => ({
  path,
  plugin: path === SAMPLE ? 'sample' : 'other',
  memoryKb,
  cpuPercent: 1.5,
  processes: 2
})

const line = (text: string): PluginLogLine => ({ at: '2026-10-05T10:00:00.000Z', stream: 'out', text })

/** A request main has not answered yet, settled by the test. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

/** Lets the requests the hook made land, and React render what they brought. */
const settle = (): Promise<void> => act(async () => undefined)

beforeEach(() => {
  bridge.reset()
  bridge.answer('secrets:list', () => ({ available: true, secrets: [] }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('usePluginSettings - secrets', () => {
  it('has no secrets until main answers, then the ones main listed', async () => {
    bridge.answer('secrets:list', () => stored('sample-token'))
    const { result } = renderHook(() => usePluginSettings(null))
    expect(result.current.secrets).toBeNull()
    await settle()
    expect(result.current.secrets).toEqual(stored('sample-token'))
    expect(bridge.invoked('secrets:list')).toHaveLength(1)
  })

  it('keeps what main pushed over a first read that lands after it', async () => {
    const first = deferred<SecretsState>()
    bridge.answer('secrets:list', () => first.promise)
    const { result } = renderHook(() => usePluginSettings(null))

    act(() => bridge.emit('secrets:changed', stored('newer')))
    expect(result.current.secrets).toEqual(stored('newer'))

    first.resolve(stored('older'))
    await settle()
    expect(result.current.secrets).toEqual(stored('newer'))
  })

  it('stays empty-handed when the first read fails, and still takes what main pushes', async () => {
    bridge.answer('secrets:list', () => {
      throw new Error('no store')
    })
    const { result } = renderHook(() => usePluginSettings(null))
    await settle()
    expect(result.current.secrets).toBeNull()
    act(() => bridge.emit('secrets:changed', stored('sample-token')))
    expect(result.current.secrets).toEqual(stored('sample-token'))
  })

  it("shows main's list at once after a save or a removal", async () => {
    bridge.answer('secrets:save', () => stored('saved'))
    bridge.answer('secrets:remove', () => ({ available: true, secrets: [] }))
    const { result } = renderHook(() => usePluginSettings(null))
    await settle()

    const input = { key: 'saved', value: 'v', hosts: ['https://api.example.com'], plugins: ['sample'] }
    let answer: string | null = 'unset'
    await act(async () => {
      answer = await result.current.saveSecret(input)
    })
    expect(answer).toBeNull()
    expect(bridge.invoked('secrets:save')).toEqual([input])
    expect(result.current.secrets).toEqual(stored('saved'))

    await act(async () => {
      answer = await result.current.removeSecret('saved')
    })
    expect(answer).toBeNull()
    expect(bridge.invoked('secrets:remove')).toEqual([{ key: 'saved' }])
    expect(result.current.secrets).toEqual({ available: true, secrets: [] })
  })

  it("answers a refused save or removal with main's sentence, without the transport's wrapping, and keeps the list", async () => {
    bridge.answer('secrets:list', () => stored('kept'))
    bridge.answer('secrets:save', () => {
      throw new Error("Error invoking remote method 'secrets:save': Error: this computer cannot encrypt")
    })
    bridge.answer('secrets:remove', () => {
      throw new Error("Error invoking remote method 'secrets:remove': Error: no secret named gone")
    })
    const { result } = renderHook(() => usePluginSettings(null))
    await settle()

    expect(await result.current.saveSecret({ key: 'k', value: 'v', hosts: [], plugins: [] })).toBe(
      'this computer cannot encrypt'
    )
    expect(await result.current.removeSecret('gone')).toBe('no secret named gone')
    expect(result.current.secrets).toEqual(stored('kept'))
  })
})

describe('usePluginSettings - folders and settings', () => {
  it('says why a folder was not added, and forgets it once one is', async () => {
    const results = [
      { path: 'C:\\somewhere', error: 'C:\\somewhere holds no helm-plugin.json', plugins: [] as PluginInfo[] },
      { path: SAMPLE, error: null, plugins: [] as PluginInfo[] }
    ]
    bridge.answer('plugins:add', () => results.shift() ?? { path: null, error: null, plugins: [] })
    const { result } = renderHook(() => usePluginSettings(null))
    await settle()
    expect(result.current.addError).toBeNull()

    act(() => result.current.add())
    await settle()
    expect(result.current.addError).toBe('C:\\somewhere holds no helm-plugin.json')

    act(() => result.current.add())
    await settle()
    expect(result.current.addError).toBeNull()
  })

  it('says what went wrong when the picker itself failed', async () => {
    bridge.answer('plugins:add', () => {
      throw new Error("Error invoking remote method 'plugins:add': Error: the window is gone")
    })
    const { result } = renderHook(() => usePluginSettings(null))
    act(() => result.current.add())
    await settle()
    expect(result.current.addError).toBe('the window is gone')
  })

  it('hands turning on and off, reloading and removing to main as they were asked for', async () => {
    bridge.answer('plugins:setEnabled', () => [])
    bridge.answer('plugins:setTools', () => [])
    bridge.answer('plugins:reload', () => [])
    bridge.answer('plugins:remove', () => [])
    const { result } = renderHook(() => usePluginSettings(null))
    await settle()

    act(() => {
      result.current.setEnabled(SAMPLE, false)
      result.current.setEnabled(SAMPLE, true)
      result.current.setTools(OTHER, false)
      result.current.reload(OTHER)
      result.current.remove(SAMPLE, ['sample-token'])
    })
    await settle()
    expect(bridge.invoked('plugins:setEnabled')).toEqual([
      { path: SAMPLE, enabled: false },
      { path: SAMPLE, enabled: true }
    ])
    expect(bridge.invoked('plugins:setTools')).toEqual([{ path: OTHER, enabled: false }])
    expect(bridge.invoked('plugins:reload')).toEqual([{ path: OTHER }])
    expect(bridge.invoked('plugins:remove')).toEqual([{ path: SAMPLE, deleteSecrets: ['sample-token'] }])
  })

  it('asks main which secrets only this plugin may use', async () => {
    bridge.answer('plugins:ownSecrets', ({ path }) => (path === SAMPLE ? ['sample-token'] : []))
    const { result } = renderHook(() => usePluginSettings(null))
    expect(await result.current.ownSecrets(SAMPLE)).toEqual(['sample-token'])
    expect(await result.current.ownSecrets(OTHER)).toEqual([])
  })

  it("answers a setting main took with null, and one it refused with main's sentence", async () => {
    bridge.answer('plugins:setSetting', ({ value }) => {
      if (value === 500) throw new Error("Error invoking remote method 'plugins:setSetting': Error: at most 100")
      return []
    })
    const { result } = renderHook(() => usePluginSettings(null))
    expect(await result.current.setSetting('sample', 'limit', 20)).toBeNull()
    expect(await result.current.setSetting('sample', 'limit', 500)).toBe('at most 100')
    expect(bridge.invoked('plugins:setSetting')).toEqual([
      { plugin: 'sample', key: 'limit', value: 20 },
      { plugin: 'sample', key: 'limit', value: 500 }
    ])
  })
})

describe('usePluginSettings - the watched plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  /** Moves the clock on, and lets every read that came due land. */
  const advance = (ms: number): Promise<void> =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it('reads nothing about any plugin while none is on screen', async () => {
    const { result } = renderHook(() => usePluginSettings(null))
    await advance(10_000)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(0)
    expect(bridge.invoked('plugins:log')).toHaveLength(0)
    expect(result.current.metrics).toBeNull()
    expect(result.current.log).toBeNull()
  })

  it("reads the watched plugin's figures and log at once, picks its own out of everyone's, and reads again every two seconds", async () => {
    let memory = 1000
    bridge.answer('plugins:metrics', () => [figures(OTHER, 1), figures(SAMPLE, memory)])
    bridge.answer('plugins:log', ({ path }) => [line(`log of ${path}`)])
    const { result } = renderHook(() => usePluginSettings(SAMPLE))
    await advance(0)

    expect(result.current.metrics).toEqual(figures(SAMPLE, 1000))
    expect(result.current.log).toEqual([line(`log of ${SAMPLE}`)])
    expect(bridge.invoked('plugins:log')).toEqual([{ path: SAMPLE }])

    memory = 2000
    await advance(1999)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(1)
    await advance(1)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(2)
    expect(result.current.metrics).toEqual(figures(SAMPLE, 2000))
  })

  it('starts the next read only when the last one has landed, however slow it is', async () => {
    const slow = deferred<PluginMetrics[]>()
    bridge.answer('plugins:metrics', () => slow.promise)
    bridge.answer('plugins:log', () => [])
    const { result } = renderHook(() => usePluginSettings(SAMPLE))

    await advance(10_000)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(1)
    expect(result.current.metrics).toBeNull()

    slow.resolve([figures(SAMPLE, 300)])
    await advance(0)
    expect(result.current.metrics).toEqual(figures(SAMPLE, 300))
    await advance(2000)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(2)
  })

  it('shows what it could read when one half fails, and null for the half it could not', async () => {
    bridge.answer('plugins:metrics', () => {
      throw new Error('the process walk failed')
    })
    bridge.answer('plugins:log', () => [line('still here')])
    const { result } = renderHook(() => usePluginSettings(SAMPLE))
    await advance(0)
    expect(result.current.metrics).toBeNull()
    expect(result.current.log).toEqual([line('still here')])

    // And it keeps reading: a failed walk is not the end of the page.
    await advance(2000)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(2)
  })

  it('is null for a plugin main has no figures for', async () => {
    bridge.answer('plugins:metrics', () => [figures(OTHER, 5)])
    bridge.answer('plugins:log', () => [])
    const { result } = renderHook(() => usePluginSettings(SAMPLE))
    await advance(0)
    expect(result.current.metrics).toBeNull()
    expect(result.current.log).toEqual([])
  })

  it("never shows one plugin's figures on another's page, and stops reading when the page goes", async () => {
    const reads: Array<{ path: string; answer: ReturnType<typeof deferred<PluginLogLine[]>> }> = []
    bridge.answer('plugins:metrics', () => [figures(SAMPLE, 100), figures(OTHER, 200)])
    bridge.answer('plugins:log', ({ path }) => {
      const answer = deferred<PluginLogLine[]>()
      reads.push({ path, answer })
      return answer.promise
    })
    const { result, rerender } = renderHook(({ watching }) => usePluginSettings(watching), {
      initialProps: { watching: SAMPLE as string | null }
    })
    reads[0]?.answer.resolve([line('sample')])
    await advance(0)
    expect(result.current.metrics).toEqual(figures(SAMPLE, 100))

    // Another plugin's page: until its own read lands there is nothing to show.
    rerender({ watching: OTHER })
    expect(result.current.metrics).toBeNull()
    expect(result.current.log).toBeNull()
    reads[1]?.answer.resolve([line('other')])
    await advance(0)
    expect(result.current.metrics).toEqual(figures(OTHER, 200))
    expect(result.current.log).toEqual([line('other')])

    // The page goes: the read in flight lands on nothing, and none follows it.
    await advance(2000)
    expect(reads).toHaveLength(3)
    rerender({ watching: null })
    reads[2]?.answer.resolve([line('late')])
    await advance(10_000)
    expect(reads).toHaveLength(3)
    expect(result.current.metrics).toBeNull()
    expect(result.current.log).toBeNull()
  })

  it('stops reading when it is let go between reads', async () => {
    bridge.answer('plugins:metrics', () => [figures(SAMPLE, 100)])
    bridge.answer('plugins:log', () => [])
    const { unmount } = renderHook(() => usePluginSettings(SAMPLE))
    await advance(0)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(1)
    unmount()
    await advance(10_000)
    expect(bridge.invoked('plugins:metrics')).toHaveLength(1)
  })
})
