import { LOCAL_HOST_KEY } from '@helm/core/types'
import type { HelmBridge, PluginBackgroundReport, PluginInfo, RemoteHostStates } from '../../../shared/ipc'
import { hostFrameKey } from '../../../shared/plugins/origin'
import type { PluginRelay, SurfaceSpec } from '../plugins/relay'

/**
 * The background host's frames: every enabled plugin's background page on
 * every host the hidden window reaches, each an iframe on its host's own
 * origin for its plugin, in a window nobody sees.
 *
 * Each host's plugin list says which of its plugins need one
 * (`plugins:changed`, through each plugin's background state), and this keeps
 * exactly those frames, keyed by host and plugin. It reports back what only it
 * can see: that a page connected (`running`), or that it failed to load or
 * stopped (`crashed`), naming the host, which main shows in Settings and
 * which the host's own adapter lays over that host's list.
 *
 * This PC's host is followed from the start. A host on another computer is
 * followed once main says it is connected (`remoteHosts:changed`), and its
 * connection is opened again each time main says it is back; its frames stay
 * while it is away, and go when it is removed.
 *
 * A crashed page is not brought back here - Reload in Settings is the way back,
 * because a page that dies on start would otherwise restart forever.
 */

/** What this needs of one host's bridge in the hidden window (`bridge.ts`). */
export interface HostBackgroundBridge {
  helm: Pick<HelmBridge, 'on' | 'invoke'>
  background: { reported(report: PluginBackgroundReport): void }
  link: { connection(): Promise<unknown>; onEnded(listener: () => void): void }
}

export interface BackgroundFramesDeps {
  /** Where the frames are put. */
  root: HTMLElement
  relay: PluginRelay
  /** The preload's bridge: where main says which hosts are connected, and hears the reports. */
  own: Pick<HelmBridge, 'on' | 'invoke' | 'send'>
  /** One host's bridge: This PC's for `LOCAL_HOST_KEY`. */
  bridgeOf: (host: string) => HostBackgroundBridge
  log: (line: string) => void
}

/** The key of one host's plugin's background frame. */
export const backgroundKey = (host: string, plugin: string): string => hostFrameKey(host, `background:${plugin}`)

const hostOf = (spec: SurfaceSpec): string => spec.host ?? LOCAL_HOST_KEY

interface Followed {
  /** Whether this window's connection to it is up or on its way. */
  live: boolean
  /** Stops hearing its list. */
  off: () => void
}

export function startBackgroundFrames(deps: BackgroundFramesDeps): { stop(): void } {
  const { relay, root } = deps
  /** What was last said to main about each frame, so a state is reported once. */
  const reported = new Map<string, string>()
  const followed = new Map<string, Followed>()

  function sync(host: string, list: readonly PluginInfo[]): void {
    const wanted = new Map<string, SurfaceSpec>()
    for (const plugin of list) {
      const { background } = plugin
      if (!plugin.enabled || plugin.error !== null || plugin.id === null || background === null) continue
      if (background.state !== 'starting' && background.state !== 'running') continue
      // A background script runs in the host's engine, not in a frame here.
      if (!/\.html?$/i.test(new URL(background.url).pathname)) continue
      const key = backgroundKey(host, plugin.id)
      wanted.set(key, {
        key,
        plugin: plugin.id,
        ...(host === LOCAL_HOST_KEY ? {} : { host }),
        revision: plugin.revision,
        url: background.url,
        surface: 'background',
        name: 'background',
        params: {},
        title: `${plugin.name} background page`
      })
    }
    drop((spec) => hostOf(spec) === host && !wanted.has(spec.key))
    for (const spec of wanted.values()) {
      const element = relay.open(spec)
      if (element.parentElement !== root) root.appendChild(element)
    }
    report()
  }

  function drop(predicate: (spec: SurfaceSpec) => boolean): void {
    const gone = relay.specs().filter(predicate)
    relay.disposeWhere(predicate)
    for (const spec of gone) reported.delete(spec.key)
  }

  function report(): void {
    for (const spec of relay.specs()) {
      const state = relay.state(spec.key)
      if (state === null || state.kind === 'loading') continue
      const said = `${String(spec.revision)}:${state.kind}`
      if (reported.get(spec.key) === said) continue
      reported.set(spec.key, said)
      const report: PluginBackgroundReport = {
        plugin: spec.plugin,
        revision: spec.revision,
        state: state.kind === 'ready' ? 'running' : 'crashed',
        error: state.kind === 'failed' ? state.message : null
      }
      deps.own.send('plugins:backgroundState', spec.host === undefined ? report : { ...report, host: spec.host })
      deps.bridgeOf(hostOf(spec)).background.reported(report)
    }
  }

  /** Hears `host`'s list from now on, and keeps its frames to it. */
  function follow(host: string): Followed {
    const known = followed.get(host)
    if (known !== undefined) return known
    const bridge = deps.bridgeOf(host)
    let takeRead = true
    const off = bridge.helm.on('plugins:changed', (list) => {
      takeRead = false
      sync(host, list)
    })
    void bridge.helm.invoke('plugins:list').then(
      (list) => {
        if (takeRead) sync(host, list)
      },
      (error: unknown) => deps.log(`plugins: ${host}'s plugins were not listed (${(error as Error).message})`)
    )
    const entry: Followed = { live: host === LOCAL_HOST_KEY, off }
    bridge.link.onEnded(() => {
      entry.live = false
    })
    followed.set(host, entry)
    return entry
  }

  /** Follows each remote host main says is connected, and lets go of each it no longer lists. */
  function hosts(states: RemoteHostStates): void {
    for (const [host, entry] of [...followed]) {
      if (host === LOCAL_HOST_KEY || host in states) continue
      entry.off()
      followed.delete(host)
      drop((spec) => hostOf(spec) === host)
    }
    for (const [host, state] of Object.entries(states)) {
      if (state.state !== 'connected') continue
      const entry = follow(host)
      if (entry.live) continue
      entry.live = true
      deps
        .bridgeOf(host)
        .link.connection()
        .catch((error: unknown) => {
          entry.live = false
          deps.log(`plugins: the background host could not reach ${host} (${(error as Error).message})`)
        })
    }
  }

  const offReport = relay.subscribe(report)
  follow(LOCAL_HOST_KEY)
  let heard = false
  const offHosts = deps.own.on('remoteHosts:changed', (states) => {
    heard = true
    hosts(states)
  })
  void deps.own.invoke('remoteHosts:read').then(
    (states) => {
      // An event that came first is newer than this answer.
      if (!heard) hosts(states)
    },
    (error: unknown) => deps.log(`plugins: the remote hosts were not read (${(error as Error).message})`)
  )

  return {
    stop() {
      offReport()
      offHosts()
      for (const entry of followed.values()) entry.off()
      followed.clear()
    }
  }
}
