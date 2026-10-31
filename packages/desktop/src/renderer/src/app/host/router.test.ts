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

function routerFor(inHost: Promise<boolean>) {
  bridge.reset()
  const host = historyAdapter()
  let asked = 0
  const helm = createRouter({
    own: bridge,
    inHost: () => {
      asked += 1
      return inHost
    },
    adapters: [host.adapter],
    clientOnly: isClientOnly,
    hostInternal: isHostInternal,
    log: () => undefined
  })
  return { helm, host, asked: () => asked }
}

describe('where the window’s calls go', () => {
  it('with the setting off, every call is the preload’s bridge', async () => {
    const r = routerFor(Promise.resolve(false))
    bridge.answer('history:summary', () => SUMMARY)
    bridge.answer('clipboard:read', () => 'copied')
    expect(await r.helm.invoke('history:summary')).toEqual(SUMMARY)
    expect(await r.helm.invoke('clipboard:read')).toBe('copied')
    r.helm.send('sessions:watch', { watching: true })
    expect(bridge.sent('sessions:watch')).toEqual([{ watching: true }])
    const seen: number[] = []
    r.helm.on('history:changed', (summary) => seen.push(summary.sessions))
    bridge.emit('history:changed', SUMMARY)
    expect(seen).toEqual([3])
    expect(r.host.asked).toEqual([])
  })

  it('with the setting on, a channel an adapter takes reaches the host, and a client-only one stays on the preload’s bridge', async () => {
    const r = routerFor(Promise.resolve(true))
    bridge.answer('clipboard:read', () => 'copied')
    expect(await r.helm.invoke('history:summary')).toMatchObject({ sessions: 9 })
    expect(bridge.invoked('history:summary')).toEqual([])
    expect(await r.helm.invoke('clipboard:read')).toBe('copied')
    r.helm.send('sessions:watch', { watching: false })
    expect(r.host.asked).toEqual(['history:summary', 'sessions:watch false'])
    expect(bridge.sent('sessions:watch')).toEqual([])
  })

  it('with the setting on, refuses a channel that is neither client-only, routed nor host-internal rather than asking main', async () => {
    const r = routerFor(Promise.resolve(true))
    bridge.answer('session:list', () => [])
    await expect(r.helm.invoke('session:list')).rejects.toThrow(refusedSentence('session:list'))
    r.helm.send('session:input', { id: 1, data: 'x' })
    const heard: unknown[] = []
    r.helm.on('session:exit', (payload) => heard.push(payload))
    await Promise.resolve()
    await Promise.resolve()
    bridge.emit('session:exit', { id: 1 } as never)
    expect(bridge.invoked('session:list')).toEqual([])
    expect(bridge.sent('session:input')).toEqual([])
    expect(heard).toEqual([])
  })

  it('sends a client-only or host-internal channel to the preload’s bridge at once, without waiting for main’s answer', async () => {
    const r = routerFor(new Promise<boolean>(() => undefined))
    bridge.answer('clipboard:read', () => 'copied')
    expect(await r.helm.invoke('clipboard:read')).toBe('copied')
    r.helm.send('plugins:toolResult', { id: 't1', ok: true, text: 'done' })
    expect(bridge.sent('plugins:toolResult')).toEqual([{ id: 't1', ok: true, text: 'done' }])
    expect(r.asked()).toBe(0)
  })

  it('has the first routed call wait for main’s answer, and asks it once', async () => {
    let answer: (on: boolean) => void = () => undefined
    const r = routerFor(new Promise<boolean>((resolve) => (answer = resolve)))
    const first = r.helm.invoke('history:summary')
    const second = r.helm.invoke('history:summary')
    expect(r.host.asked).toEqual([])
    answer(true)
    await Promise.all([first, second])
    expect(r.host.asked).toEqual(['history:summary', 'history:summary'])
    expect(r.asked()).toBe(1)
  })

  it('moves a listener from the preload’s bridge to the host once it hears the setting is on', async () => {
    let answer: (on: boolean) => void = () => undefined
    const placed = new Promise<boolean>((resolve) => (answer = resolve))
    const r = routerFor(placed)
    const seen: number[] = []
    const off = r.helm.on('history:changed', (summary) => seen.push(summary.sessions))
    answer(true)
    await placed
    await Promise.resolve()
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
        inHost: () => Promise.resolve(true),
        adapters: [{ requests: { 'clipboard:read': () => Promise.resolve('') } }],
        clientOnly: isClientOnly,
        hostInternal: isHostInternal
      })
    ).toThrow('clipboard:read is client-only')
  })
})

describe('every channel a Helm page uses, with the setting on', () => {
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
