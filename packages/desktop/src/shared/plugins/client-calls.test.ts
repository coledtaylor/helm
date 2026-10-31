import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginUiRequest } from '../ipc'
import { CLIENT_METHODS, LINK_SPACING_MS, createClientCalls, type ClientCaller } from './client-calls'
import { PluginCallError } from './errors'

const caller = (patch: Partial<ClientCaller> = {}): ClientCaller => ({
  plugin: 'sample',
  declaresTab: (tab) => tab === 'item',
  surface: 'panel',
  ...patch
})

function calls(shown = true) {
  const asked: PluginUiRequest[] = []
  const clientCalls = createClientCalls({
    ui: (request) => {
      if (shown) asked.push(request)
      return shown
    }
  })
  const codeOf = (run: () => unknown): string | null => {
    try {
      run()
      return null
    } catch (error) {
      return error instanceof PluginCallError ? error.code : 'not a PluginCallError'
    }
  }
  return { clientCalls, asked, codeOf }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the calls the page on screen answers itself, shared by main and the window', () => {
  it('names exactly tabs.open and open', () => {
    expect([...CLIENT_METHODS].sort()).toEqual(['open', 'tabs.open'])
  })

  it('opens a tab the manifest declares, with its params and options, and refuses any other', () => {
    const { clientCalls, asked, codeOf } = calls()
    clientCalls.run('tabs.open', caller(), ['item', { id: 7 }, { title: ' Seven ', preview: true }])
    expect(asked).toEqual([{ kind: 'openTab', plugin: 'sample', tab: 'item', params: { id: 7 }, title: 'Seven', preview: true }])
    expect(codeOf(() => clientCalls.run('tabs.open', caller(), ['nope']))).toBe('not-declared')
    expect(codeOf(() => clientCalls.run('tabs.open', caller(), ['item', {}, { preview: 'yes' }]))).toBe('invalid')
  })

  it('opens an https link from a panel or a tab, one a second, and never from a background page', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-31T09:00:00.000Z'))
    const { clientCalls, asked, codeOf } = calls()
    clientCalls.run('open', caller(), ['https://example.com/a'])
    expect(codeOf(() => clientCalls.run('open', caller(), ['https://example.com/b']))).toBe('busy')
    vi.advanceTimersByTime(LINK_SPACING_MS)
    clientCalls.run('open', caller({ surface: 'tab' }), ['https://example.com/c'])
    expect(codeOf(() => clientCalls.run('open', caller(), ['http://example.com/']))).toBe('invalid')
    expect(codeOf(() => clientCalls.run('open', caller(), ['https://user:pw@example.com/']))).toBe('invalid')
    expect(codeOf(() => clientCalls.run('open', caller({ surface: 'background' }), ['https://example.com/d']))).toBe(
      'not-allowed'
    )
    expect(asked).toEqual([
      { kind: 'link', plugin: 'sample', url: 'https://example.com/a' },
      { kind: 'link', plugin: 'sample', url: 'https://example.com/c' }
    ])
  })

  it('says so when there is no window to open anything in', () => {
    const { clientCalls, codeOf } = calls(false)
    expect(codeOf(() => clientCalls.run('tabs.open', caller(), ['item']))).toBe('unavailable')
    expect(codeOf(() => clientCalls.run('open', caller(), ['https://example.com/']))).toBe('unavailable')
  })
})
