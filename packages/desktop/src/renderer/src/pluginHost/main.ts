import type { PluginInfo } from '../../../shared/ipc'
import { background, helm } from './bridge'
import { createPluginRelay, type SurfaceSpec } from '../plugins/relay'

/**
 * The background host: every enabled plugin's background page, each an
 * iframe on its plugin's origin, in a window nobody sees.
 *
 * The plugin list says which plugins need one (`plugins:changed`, through each
 * plugin's background state) and this page keeps exactly those frames. It
 * reports back what only it can see: that a page connected (`running`), or
 * that it failed to load or stopped (`crashed`), which main shows in Settings.
 * With sessions in the local host the list is the host's, read over this
 * window's own connection (`bridge.ts`), and what this window saw of its
 * frames is laid over it here as well as told to main.
 * A crashed page is not brought back here - Reload in Settings is the way back,
 * because a page that dies on start would otherwise restart forever.
 */

const found = document.getElementById('frames')
if (found === null) throw new Error('#frames is missing from plugin-host.html')
const root: HTMLElement = found

const relay = createPluginRelay({ win: window, ipc: helm })
/** What was last said to main about each frame, so a state is reported once. */
const reported = new Map<string, string>()

const keyOf = (plugin: string): string => `background:${plugin}`

function sync(list: readonly PluginInfo[]): void {
  const wanted = new Map<string, SurfaceSpec>()
  for (const plugin of list) {
    const { background } = plugin
    if (!plugin.enabled || plugin.error !== null || plugin.id === null || background === null) continue
    if (background.state !== 'starting' && background.state !== 'running') continue
    // A background script runs in the local host's engine, not in a frame here.
    if (!/\.html?$/i.test(new URL(background.url).pathname)) continue
    const key = keyOf(plugin.id)
    wanted.set(key, {
      key,
      plugin: plugin.id,
      revision: plugin.revision,
      url: background.url,
      surface: 'background',
      name: 'background',
      params: {},
      title: `${plugin.name} background page`
    })
  }
  relay.disposeWhere((spec) => !wanted.has(spec.key))
  for (const key of reported.keys()) if (!wanted.has(key)) reported.delete(key)
  for (const spec of wanted.values()) {
    const element = relay.open(spec)
    if (element.parentElement !== root) root.appendChild(element)
  }
  report()
}

function report(): void {
  for (const spec of relay.specs()) {
    const state = relay.state(spec.key)
    if (state === null || state.kind === 'loading') continue
    const said = `${String(spec.revision)}:${state.kind}`
    if (reported.get(spec.key) === said) continue
    reported.set(spec.key, said)
    const report = {
      plugin: spec.plugin,
      revision: spec.revision,
      state: state.kind === 'ready' ? ('running' as const) : ('crashed' as const),
      error: state.kind === 'failed' ? state.message : null
    }
    helm.send('plugins:backgroundState', report)
    background.reported(report)
  }
}

relay.subscribe(report)

let takeRead = true
helm.on('plugins:changed', (list) => {
  takeRead = false
  sync(list)
})
void helm.invoke('plugins:list').then((list) => {
  if (takeRead) sync(list)
})
