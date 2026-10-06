import { flushSync, mount, unmount } from 'svelte'
import { derived, get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settings, theme, visible } from '../src/stores.js'
import { DARK, LIGHT, installBridge, removeBridge, type FakeBridge } from './bridge'
import Panel from './Panel.svelte'

/**
 * Svelte gets no adapter: the stores meet its store contract, so a component
 * reads them with `$` and `svelte/store` composes them. These mount a
 * component the compiler built, not a stand-in for one.
 */

let fake: FakeBridge
let target: HTMLElement

const text = (id: string): string | null | undefined => target.querySelector(`[data-testid="${id}"]`)?.textContent

beforeEach(() => {
  fake = installBridge()
  target = document.createElement('div')
  document.body.append(target)
})

afterEach(() => {
  target.remove()
  removeBridge()
})

describe('the stores in Svelte', () => {
  it('render in a component through $, follow Helm, and let go when it unmounts', async () => {
    const panel = mount(Panel, { target })
    expect(text('settings')).toBe('reading')
    expect(text('visible')).toBe('hidden')
    expect(text('theme')).toBe('dark')
    expect(text('token')).toBe('reading')

    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    await fake.stateReads[0]!.answer('missing')
    flushSync()
    expect(text('settings')).toBe('is:open')
    expect(text('token')).toBe('missing')

    fake.emit('settings', { query: 'is:closed' })
    fake.emit('visibility', true)
    fake.emit('theme', LIGHT)
    flushSync()
    expect(text('settings')).toBe('is:closed')
    expect(text('visible')).toBe('shown')
    expect(text('theme')).toBe('light')

    target.querySelector('button')!.click()
    await fake.requests[0]!.answer('ready')
    flushSync()
    expect(text('token')).toBe('ready')

    await unmount(panel)
    for (const event of ['settings', 'secrets', 'theme', 'visibility'] as const) expect(fake.listeners(event)).toBe(0)
  })

  it('work with svelte/store', async () => {
    expect(get(theme)).toBe(DARK)
    expect(get(visible)).toBe(false)

    const query = derived(settings, ($settings) => String($settings?.['query'] ?? 'reading'))
    const seen: string[] = []
    const off = query.subscribe((value) => seen.push(value))
    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    off()
    expect(seen).toEqual(['reading', 'is:open'])
    expect(fake.listeners('settings')).toBe(0)
  })
})
