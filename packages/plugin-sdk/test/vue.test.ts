// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, effectScope, h, nextTick, ref } from 'vue'
import { useHelmEvent, useHelmSettings, useHelmTheme, useHelmVisible, useSecret } from '../src/vue.js'
import { installBridge, removeBridge, LIGHT, type FakeBridge } from './bridge'

/** The Vue composables, over the stores, in a mounted component and in a bare effect scope. */

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
  vi.restoreAllMocks()
})

describe('the Vue composables', () => {
  it('render in a component, follow Helm, and let go when it unmounts', async () => {
    const actions: string[] = []
    const Panel = defineComponent({
      setup() {
        const settings = useHelmSettings()
        const visible = useHelmVisible()
        const theme = useHelmTheme()
        const [token, requestToken] = useSecret('github-token')
        useHelmEvent('action', ({ id }) => actions.push(id))
        return () => [
          h('p', { 'data-testid': 'settings' }, settings.value === null ? 'reading' : String(settings.value['query'])),
          h('p', { 'data-testid': 'visible' }, visible.value ? 'shown' : 'hidden'),
          h('p', { 'data-testid': 'theme' }, theme.value.kind),
          h('p', { 'data-testid': 'token' }, token.value ?? 'reading'),
          h('button', { onClick: () => void requestToken() }, 'Add token')
        ]
      }
    })
    const app = createApp(Panel)
    app.mount(target)
    expect(text('settings')).toBe('reading')
    expect(text('visible')).toBe('hidden')
    expect(text('theme')).toBe('dark')
    expect(text('token')).toBe('reading')

    await fake.settingsReads[0]!.answer({ query: 'is:open' })
    await fake.stateReads[0]!.answer('missing')
    await nextTick()
    expect(text('settings')).toBe('is:open')
    expect(text('token')).toBe('missing')

    fake.emit('settings', { query: 'is:closed' })
    fake.emit('visibility', true)
    fake.emit('theme', LIGHT)
    fake.emit('action', { id: 'refresh' })
    await nextTick()
    expect(text('settings')).toBe('is:closed')
    expect(text('visible')).toBe('shown')
    expect(text('theme')).toBe('light')
    expect(actions).toEqual(['refresh'])

    target.querySelector('button')!.click()
    await fake.requests[0]!.answer('ready')
    await nextTick()
    expect(text('token')).toBe('ready')

    app.unmount()
    for (const event of ['settings', 'secrets', 'theme', 'visibility', 'action'] as const) expect(fake.listeners(event)).toBe(0)
  })

  it('follow a secret key held in a ref, ending the old key before reading the new one', async () => {
    const scope = effectScope()
    const key = ref('github-token')
    const [state] = scope.run(() => useSecret(key))!
    await fake.stateReads[0]!.answer('ready')
    expect(state.value).toBe('ready')

    key.value = 'jira-token'
    await nextTick()
    expect(state.value).toBeNull()
    expect(fake.stateReads.map((read) => read.key)).toEqual(['github-token', 'jira-token'])
    expect(fake.listeners('secrets')).toBe(1)
    await fake.stateReads[1]!.answer('missing')
    expect(state.value).toBe('missing')

    scope.stop()
    expect(fake.listeners('secrets')).toBe(0)
  })

  it('work outside an effect scope without a warning, for as long as the page lasts', () => {
    const warn = vi.spyOn(console, 'warn')
    const visible = useHelmVisible()
    fake.emit('visibility', true)
    expect(visible.value).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})
