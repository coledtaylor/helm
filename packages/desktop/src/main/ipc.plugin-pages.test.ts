import { describe, expect, it, vi } from 'vitest'
import type { PluginCallRequest } from '../shared/ipc'
import type { HostPlugins } from './host/plugins'
import type { PluginHost } from './plugins/host'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

const { pluginPages } = await import('./ipc')

/**
 * Where a plugin page's calls go: Helm's own registry with sessions in Helm,
 * the local host's plugins with sessions there. Both sides are recorders, so
 * each assertion is about which one was asked.
 */

const REQUEST: PluginCallRequest = { plugin: 'sample', surface: 'panel', method: 'fetch', args: [], callId: '1.1.1' }

function recorder<T extends object>(name: string, asked: string[]): T {
  return new Proxy({} as T, {
    get: (_, method) => (...args: unknown[]) => {
      asked.push(`${name}.${String(method)}(${args.map((arg) => JSON.stringify(arg)).join(', ')})`)
      return method === 'call' ? Promise.resolve({ ok: true, value: name }) : Promise.resolve(null)
    }
  })
}

describe('a plugin page’s calls', () => {
  it('are answered by Helm itself with the setting off, and nothing asks the local host', async () => {
    const asked: string[] = []
    const pages = pluginPages({ plugins: recorder<PluginHost>('helm', asked), hostPlugins: undefined })
    expect(await pages.call(REQUEST, 4)).toEqual({ ok: true, value: 'helm' })
    pages.cancel('1.1.1', 4)
    await pages.command('sample', 'refresh')
    pages.answer('secret-1')
    await pages.session({ requestId: 'ask-1', start: false, cols: 80, rows: 24 }, 4)
    expect(asked).toEqual([
      `helm.call(${JSON.stringify(REQUEST)}, 4)`,
      'helm.cancel("1.1.1", 4)',
      'helm.command("sample", "refresh")',
      'helm.answer("secret-1")',
      'helm.session({"requestId":"ask-1","start":false,"cols":80,"rows":24}, 4)'
    ])
  })

  it('go to the local host’s plugins with the setting on, and Helm’s registry answers none of them', async () => {
    const asked: string[] = []
    const pages = pluginPages({ plugins: recorder<PluginHost>('helm', asked), hostPlugins: recorder<HostPlugins>('host', asked) })
    expect(await pages.call(REQUEST, 4)).toEqual({ ok: true, value: 'host' })
    pages.cancel('1.1.1', 4)
    await pages.command('sample', 'refresh')
    pages.answer('secret-1')
    await pages.session({ requestId: 'ask-1', start: true, cols: 80, rows: 24 }, 4)
    expect(asked.every((line) => line.startsWith('host.'))).toBe(true)
    expect(asked).toHaveLength(5)
  })
})
