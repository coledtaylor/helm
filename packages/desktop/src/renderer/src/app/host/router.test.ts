import { describe, expect, it } from 'vitest'
import { isClientOnly, isHostInternal } from '../../../../shared/host/protocol'
import { EVENT_CHANNELS, REQUEST_CHANNELS, SEND_CHANNELS } from '../../../../shared/ipc'
import { bridge } from '../bridge.testkit'
import { createRouter, refusedSentence, routedChannels, type HostAdapter } from './router'

const SUMMARY = {
  sessions: 3,
  prompts: 4,
  projects: 1,
  resumable: 1,
  latestAt: null,
  historyFile: '/home/.claude/history.jsonl',
  indexedBytes: 0
}

/** An adapter taking history's summary and its pushes, recording what reached it. */
function historyAdapter() {
  const asked: string[] = []
  const listeners = new Set<(payload: typeof SUMMARY) => void>()
  const adapter: HostAdapter = {
    requests: {
      'history:summary': () => {
        asked.push('history:summary')
        return Promise.resolve({ ...SUMMARY, sessions: 9 })
      }
    },
    sends: {
      'sessions:watch': ({ watching }) => {
        asked.push(`sessions:watch ${String(watching)}`)
      }
    },
    events: {
      'history:changed': (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  }
  return { adapter, asked, push: (payload: typeof SUMMARY) => listeners.forEach((l) => l(payload)) }
}

function routerFor() {
  bridge.reset()
  const host = historyAdapter()
  const helm = createRouter({
    own: bridge,
    adapters: [host.adapter],
    clientOnly: isClientOnly,
    hostInternal: isHostInternal,
    log: () => undefined
  })
  return { helm, host }
}

describe('where the window’s calls go', () => {
  it('sends a channel an adapter takes to the host, and keeps a client-only one on the preload’s bridge', async () => {
    const r = routerFor()
    bridge.answer('clipboard:read', () => ({ text: 'copied' }))
    expect(await r.helm.invoke('history:summary')).toMatchObject({ sessions: 9 })
    expect(bridge.invoked('history:summary')).toEqual([])
    expect(await r.helm.invoke('clipboard:read')).toEqual({ text: 'copied' })
    r.helm.send('sessions:watch', { watching: false })
    expect(r.host.asked).toEqual(['history:summary', 'sessions:watch false'])
    expect(bridge.sent('sessions:watch')).toEqual([])
  })

  it('S6: refuses a channel that is neither client-only, routed nor host-internal at once, rather than asking main', async () => {
    const r = routerFor()
    bridge.answer('session:list', () => [])
    await expect(r.helm.invoke('session:list')).rejects.toThrow(refusedSentence('session:list'))
    r.helm.send('session:input', { id: 1, data: 'x' })
    const heard: unknown[] = []
    r.helm.on('session:exit', (payload) => heard.push(payload))
    bridge.emit('session:exit', { id: 1 } as never)
    expect(bridge.invoked('session:list')).toEqual([])
    expect(bridge.sent('session:input')).toEqual([])
    expect(heard).toEqual([])
  })

  it('sends a host-internal channel to the preload’s bridge', () => {
    const r = routerFor()
    r.helm.send('plugins:toolResult', { id: 't1', ok: true, text: 'done' })
    expect(bridge.sent('plugins:toolResult')).toEqual([{ id: 't1', ok: true, text: 'done' }])
  })

  it('hears a routed event from the host, never from the preload’s bridge, until it stops listening', () => {
    const r = routerFor()
    const seen: number[] = []
    const off = r.helm.on('history:changed', (summary) => seen.push(summary.sessions))
    bridge.emit('history:changed', SUMMARY)
    r.host.push({ ...SUMMARY, sessions: 5 })
    expect(seen).toEqual([5])
    off()
    r.host.push({ ...SUMMARY, sessions: 6 })
    expect(seen).toEqual([5])
  })

  it('refuses an adapter that takes a client-only channel', () => {
    expect(() =>
      createRouter({
        own: bridge,
        adapters: [{ requests: { 'clipboard:read': () => Promise.resolve({ text: '' }) } }],
        clientOnly: isClientOnly,
        hostInternal: isHostInternal
      })
    ).toThrow('clipboard:read is client-only')
  })
})

describe('every channel a Helm page uses', () => {
  /** The window's and the hidden plugin window's adapters, as their bridges build them, on a preload that answers nothing. */
  async function pages() {
    Object.defineProperty(window, 'helm', { value: bridge, configurable: true })
    const { hostAdapters } = await import('../bridge')
    const { background } = await import('../../pluginHost/bridge')
    return { window: hostAdapters, background: [background] }
  }

  const ALL = [...REQUEST_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS]

  it('is client-only, taken by one of the window’s adapters, or host-internal', async () => {
    const routed = routedChannels((await pages()).window, isClientOnly)
    const strays = ALL.filter((channel) => !isClientOnly(channel) && !routed.has(channel) && !isHostInternal(channel))
    expect([...new Set(strays)].sort()).toEqual([])
  })

  it('in the hidden plugin window, routes only the plugin channels a background page needs, and leaves host-internal ones to the preload', async () => {
    const routed = routedChannels((await pages()).background, isClientOnly)
    expect([...routed].sort()).toEqual(['plugins:call', 'plugins:cancel', 'plugins:changed', 'plugins:deliver', 'plugins:list', 'settings:read'])
    expect(ALL.filter((channel) => isHostInternal(channel)).sort()).toEqual([
      'plugins:backgroundState',
      'plugins:tool',
      'plugins:toolCancel',
      'plugins:toolResult'
    ])
    expect([...routed].filter((channel) => isHostInternal(channel))).toEqual([])
  })
})
