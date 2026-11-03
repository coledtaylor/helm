// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import type { PluginBackgroundReport, PluginInfo, RemoteHostStates } from '../../../shared/ipc'
import type { FrameState, PluginRelay, SurfaceSpec } from '../plugins/relay'
import { backgroundKey, startBackgroundFrames, type HostBackgroundBridge } from './backgrounds'

const BUILD_BOX = 'build-box'

const listed = (id: string, url: string): PluginInfo =>
  ({
    path: `/plugins/${id}`,
    id,
    name: id,
    enabled: true,
    error: null,
    revision: 1,
    background: { url, state: 'running', error: null }
  }) as unknown as PluginInfo

/** A relay that keeps specs and states, and makes a frame per key. */
function fakeRelay() {
  const specs = new Map<string, SurfaceSpec>()
  const states = new Map<string, FrameState>()
  const listeners = new Set<() => void>()
  const relay = {
    open(spec: SurfaceSpec) {
      specs.set(spec.key, spec)
      if (!states.has(spec.key)) states.set(spec.key, { kind: 'loading' })
      const frame = document.createElement('iframe')
      frame.dataset['key'] = spec.key
      return frame
    },
    state: (key: string) => states.get(key) ?? null,
    specs: () => [...specs.values()],
    disposeWhere(predicate: (spec: SurfaceSpec) => boolean) {
      for (const spec of [...specs.values()]) if (predicate(spec)) specs.delete(spec.key)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  } as unknown as PluginRelay
  return {
    relay,
    specs,
    ready(key: string) {
      states.set(key, { kind: 'ready' })
      for (const listener of listeners) listener()
    }
  }
}

/** One host's bridge in the hidden window: its list, and what it was told. */
function fakeHost(list: PluginInfo[]) {
  const listeners = new Set<(list: PluginInfo[]) => void>()
  const told: PluginBackgroundReport[] = []
  let connects = 0
  const bridge = {
    helm: {
      on: (_channel: string, listener: (list: PluginInfo[]) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      invoke: () => Promise.resolve(list)
    },
    background: { reported: (report: PluginBackgroundReport) => told.push(report) },
    link: {
      connection: () => {
        connects += 1
        return Promise.resolve({})
      },
      onEnded: () => undefined
    }
  } as unknown as HostBackgroundBridge
  return {
    bridge,
    told,
    connects: () => connects,
    push: (next: PluginInfo[]) => {
      for (const listener of listeners) listener(next)
    }
  }
}

function hiddenWindow(states: RemoteHostStates) {
  const relay = fakeRelay()
  const ours = fakeHost([listed('trackr', 'helm-plugin://trackr/background.html')])
  const theirs = fakeHost([listed('trackr', `helm-plugin://trackr.${BUILD_BOX}/background.html`)])
  const sent: Array<{ channel: string; payload: unknown }> = []
  let hostsChanged: ((states: RemoteHostStates) => void) | null = null
  const own = {
    on: (channel: string, listener: (states: RemoteHostStates) => void) => {
      if (channel === 'remoteHosts:changed') hostsChanged = listener
      return () => undefined
    },
    invoke: () => Promise.resolve(states),
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  }
  const root = document.createElement('div')
  startBackgroundFrames({
    root,
    relay: relay.relay,
    own: own as never,
    bridgeOf: (host) => (host === LOCAL_HOST_KEY ? ours.bridge : theirs.bridge),
    log: () => undefined
  })
  return { relay, ours, theirs, sent, root, hostsChanged: (next: RemoteHostStates) => hostsChanged?.(next) }
}

const CONNECTED = { [BUILD_BOX]: { state: 'connected' } } as unknown as RemoteHostStates

describe('the hidden window’s background frames on every host', () => {
  it('s20: runs the same plugin’s background page once for This PC and once for build-box, each on its own host’s origin', async () => {
    const w = hiddenWindow(CONNECTED)
    await expect.poll(() => w.relay.specs.size).toBe(2)
    const ours = w.relay.specs.get(backgroundKey(LOCAL_HOST_KEY, 'trackr'))
    const theirs = w.relay.specs.get(backgroundKey(BUILD_BOX, 'trackr'))
    expect(ours).toMatchObject({ plugin: 'trackr', url: 'helm-plugin://trackr/background.html' })
    expect(ours?.host).toBeUndefined()
    expect(theirs).toMatchObject({ plugin: 'trackr', host: BUILD_BOX, url: `helm-plugin://trackr.${BUILD_BOX}/background.html` })
    expect(w.theirs.connects()).toBe(1)
    expect(w.root.querySelectorAll('iframe')).toHaveLength(2)
  })

  it('reports build-box’s page as build-box’s, to main and to build-box alone', async () => {
    const w = hiddenWindow(CONNECTED)
    await expect.poll(() => w.relay.specs.size).toBe(2)
    w.relay.ready(backgroundKey(BUILD_BOX, 'trackr'))
    expect(w.sent).toEqual([
      {
        channel: 'plugins:backgroundState',
        payload: { plugin: 'trackr', revision: 1, state: 'running', error: null, host: BUILD_BOX }
      }
    ])
    expect(w.theirs.told).toEqual([{ plugin: 'trackr', revision: 1, state: 'running', error: null }])
    expect(w.ours.told).toEqual([])
  })

  it('leaves build-box’s frames alone when This PC’s list moves, and drops them when build-box is removed', async () => {
    const w = hiddenWindow(CONNECTED)
    await expect.poll(() => w.relay.specs.size).toBe(2)
    w.ours.push([])
    expect([...w.relay.specs.keys()]).toEqual([backgroundKey(BUILD_BOX, 'trackr')])
    w.hostsChanged({})
    expect(w.relay.specs.size).toBe(0)
  })
})
