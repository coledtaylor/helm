import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secret, settings, theme, visible } from '../src/stores.js'
import { DARK, LIGHT, installBridge, removeBridge, type FakeBridge } from './bridge'

/**
 * The stores every framework helper is built on. What they promise is
 * Svelte's store contract - the value at once, then every change, and a
 * function that unsubscribes - plus the ordering a read and an event need.
 */

let fake: FakeBridge
const offs: Array<() => void> = []

/** Subscribes, records every value it is handed, and unsubscribes after the test. */
function watch<T>(store: { subscribe(run: (value: T) => void): () => void }): { values: T[]; off: () => void } {
  const values: T[] = []
  const off = store.subscribe((value) => values.push(value))
  offs.push(off)
  return { values, off }
}

beforeEach(() => {
  fake = installBridge()
})

afterEach(() => {
  for (const off of offs.splice(0)) off()
  removeBridge()
  vi.restoreAllMocks()
})

describe('theme and visible', () => {
  it('hand over the value now, then each change, until unsubscribed', () => {
    const themes = watch(theme)
    const shown = watch(visible)
    expect(themes.values).toEqual([DARK])
    expect(shown.values).toEqual([false])

    fake.emit('theme', LIGHT)
    fake.emit('visibility', true)
    expect(themes.values).toEqual([DARK, LIGHT])
    expect(shown.values).toEqual([false, true])
    expect(theme.current).toBe(LIGHT)
    expect(visible.current).toBe(true)

    themes.off()
    shown.off()
    fake.emit('theme', DARK)
    expect(themes.values).toEqual([DARK, LIGHT])
    expect(fake.listeners('theme')).toBe(0)
    expect(fake.listeners('visibility')).toBe(0)
  })

  it('tell one function subscribed twice twice, and end each subscription on its own', () => {
    const seen: boolean[] = []
    const run = (value: boolean): void => {
      seen.push(value)
    }
    const first = visible.subscribe(run)
    const second = visible.subscribe(run)
    first()
    fake.emit('visibility', true)
    expect(seen).toEqual([false, false, true])
    second()
    expect(fake.listeners('visibility')).toBe(0)
  })
})

describe('settings', () => {
  it('is null until the read answers, then follows the event', async () => {
    const { values } = watch(settings)
    expect(values).toEqual([null])
    expect(fake.settingsReads).toHaveLength(1)

    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    fake.emit('settings', { query: 'is:closed' })
    expect(values).toEqual([null, { query: 'is:open' }, { query: 'is:closed' }])
    expect(settings.current).toEqual({ query: 'is:closed' })
  })

  it('reads once and listens once however many subscribe, and a late subscriber gets the value at once', async () => {
    watch(settings)
    watch(settings)
    expect(fake.settingsReads).toHaveLength(1)
    expect(fake.listeners('settings')).toBe(1)

    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    expect(watch(settings).values).toEqual([{ query: 'is:open' }])
    expect(fake.settingsReads).toHaveLength(1)
  })

  it('keeps an event that arrives before the read answers', async () => {
    const { values } = watch(settings)
    fake.emit('settings', { query: 'newer' })
    await fake.settingsReads[0]!.answer({ query: 'older' })
    expect(values).toEqual([null, { query: 'newer' }])
  })

  it('forgets the value when the last subscriber leaves, and reads again for the next', async () => {
    const first = watch(settings)
    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    first.off()
    expect(settings.current).toBeNull()
    expect(fake.listeners('settings')).toBe(0)

    const next = watch(settings)
    expect(next.values).toEqual([null])
    expect(fake.settingsReads).toHaveLength(2)
  })

  it('drops a read that answers after everyone it was for has left', async () => {
    // What React's StrictMode does on mount: subscribe, unsubscribe, subscribe.
    watch(settings).off()
    const { values } = watch(settings)
    await fake.settingsReads[0]!.answer({ query: 'stale' })
    expect(values).toEqual([null])

    await fake.settingsReads[1]!.answer({ query: 'current' })
    expect(values).toEqual([null, { query: 'current' }])
  })

  it('still tells the others when one subscriber throws, and reports the error on its own', async () => {
    const reported: Array<() => void> = []
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => {
      reported.push(callback)
      return 0
    }) as unknown as typeof setTimeout)
    const broken = new Error('a bug in the plugin')
    offs.push(
      settings.subscribe((value) => {
        if (value !== null) throw broken
      })
    )
    const { values } = watch(settings)

    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    expect(values).toEqual([null, { query: 'is:open' }])
    expect(reported).toHaveLength(1)
    expect(reported[0]!).toThrow(broken)
  })
})

describe('secret', () => {
  it('is one store per key', () => {
    expect(secret('github-token')).toBe(secret('github-token'))
    expect(secret('github-token')).not.toBe(secret('jira-token'))
  })

  it('reads its own key and follows only its own key in the event', async () => {
    const { values } = watch(secret('github-token'))
    expect(fake.stateReads.map((read) => read.key)).toEqual(['github-token'])
    await fake.stateReads[0]!.answer('missing')

    fake.emit('secrets', { 'jira-token': 'ready' })
    fake.emit('secrets', { 'github-token': 'ready', 'jira-token': 'ready' })
    expect(values).toEqual([null, 'missing', 'ready'])
  })

  it('opens the dialog on request, and takes and returns its answer', async () => {
    const token = secret('github-token')
    const { values } = watch(token)
    await fake.stateReads[0]!.answer('missing')

    const asked = token.request()
    expect(fake.requests.map((request) => request.key)).toEqual(['github-token'])
    await fake.requests[0]!.answer('ready')
    await expect(asked).resolves.toBe('ready')
    expect(values).toEqual([null, 'missing', 'ready'])
  })

  it('keeps a request answered before the read, and keeps nothing when nobody is subscribed', async () => {
    const token = secret('github-token')
    const asked = token.request()
    await fake.requests[0]!.answer('ready')
    await expect(asked).resolves.toBe('ready')
    expect(token.current).toBeNull()

    const { values } = watch(token)
    const again = token.request()
    await fake.requests[1]!.answer('ready')
    await again
    await fake.stateReads[0]!.answer('missing')
    expect(values).toEqual([null, 'ready'])
  })
})

describe('outside Helm', () => {
  it('imports without a bridge, says what is wrong on subscribe, and recovers once there is one', () => {
    removeBridge()
    expect(() => settings.subscribe(() => undefined)).toThrow('window.helm is missing')
    expect(() => theme.subscribe(() => undefined)).toThrow('window.helm is missing')

    fake = installBridge()
    expect(watch(settings).values).toEqual([null])
    expect(fake.settingsReads).toHaveLength(1)
  })
})
