import type { PluginBackgroundReport } from '../../shared/ipc'
import { hostLabel } from '../../shared/plugins/origin'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import type { HostLink } from './link'
import { createPluginToolRelay, type PluginToolRelay } from './plugin-tools'
import { createHostPlugins, type HostPlugins } from './plugins'

/**
 * Each remote host's plugins, as main keeps them: the same parts This PC's
 * host has (`plugins.ts`, `plugin-tools.ts`), one set per host, each on that
 * host's own main link.
 *
 * - Page files: a host's plugin pages are served on its own origin for each
 *   plugin (`helm-plugin://<id>.<label>/`, `shared/plugins/origin.ts`), from
 *   that host's files only, cached per plugin version and revision.
 * - Tools: the relay offers each host only the tool servers of the plugins
 *   that host lists as on with tools on, and a call it relays is answered by
 *   that host's background page for the plugin, in a frame on that host's
 *   origin in the hidden plugin window, named by host end to end. No host is
 *   offered another host's plugins, This PC's included.
 * - Background pages: each host's reports name it, and the hidden window is
 *   open while any host's page needs it.
 *
 * Helm's own plugins are never copied into a remote host: it keeps its own.
 */

/** What one host's background pages need of the one hidden window. */
export interface BackgroundNeeds {
  /** The sync a host's plugins call: whether that host's pages need the window. */
  forHost(host: string): { sync(needed: boolean): void }
  /** A host gone: its pages need nothing any more. */
  forget(host: string): void
}

/** The hidden window is open while any host's background page needs it, and closed when none does. */
export function createBackgroundNeeds(background: { sync(needed: boolean): void }): BackgroundNeeds {
  const needs = new Map<string, boolean>()
  const settle = (): void => background.sync([...needs.values()].some(Boolean))
  return {
    forHost: (host) => ({
      sync(needed) {
        needs.set(host, needed)
        settle()
      }
    }),
    forget(host) {
      if (needs.delete(host)) settle()
    }
  }
}

export interface RemotePluginsDeps {
  /** Hands a call to the hidden window, which gives it to the background page of `request.host`'s plugin. */
  runTool: (request: ToolCallRequest, signal: AbortSignal) => Promise<ToolAnswer>
  background: BackgroundNeeds
  /** What the hidden window reported of some host's background pages moved. */
  reportsChanged: () => void
  log: (line: string) => void
}

export interface RemotePlugins {
  /** Starts host `id`'s plugins and tool relay on its main link; what `stop` ends when the link is let go of. */
  attach(id: string, link: HostLink): { stop(): void }
  /** Host `id`'s plugins, or null for a host not attached. */
  forHost(id: string): HostPlugins | null
  /** The plugins of the host whose origin label is `label`, or null when no attached host has it. */
  byLabel(label: string): HostPlugins | null
  /** Every attached host's background reports, each naming its host. */
  reports(): PluginBackgroundReport[]
  /** The hidden window's renderer died, and every host's background pages with it. */
  backgroundGone(reason: string): void
  /** Helm is quitting: every relay stops answering and every host's plugins shut down. */
  shutdown(): void
}

interface Attached {
  plugins: HostPlugins
  relay: PluginToolRelay
}

export function createRemotePlugins(deps: RemotePluginsDeps): RemotePlugins {
  const hosts = new Map<string, Attached>()

  const end = (id: string, attached: Attached): void => {
    attached.relay.stop()
    attached.plugins.shutdown()
    if (hosts.get(id) === attached) {
      hosts.delete(id)
      deps.background.forget(id)
      deps.reportsChanged()
    }
  }

  return {
    attach(id, link) {
      const previous = hosts.get(id)
      if (previous !== undefined) end(id, previous)
      // Filled in below: the plugins' tools moving reach the relay made beside them.
      let relay: PluginToolRelay | null = null
      const plugins = createHostPlugins({
        link,
        host: id,
        reportsChanged: () => deps.reportsChanged(),
        runTool: (request, signal) => deps.runTool({ ...request, host: id }, signal),
        onToolsChanged: () => relay?.offer(),
        background: deps.background.forHost(id),
        log: deps.log
      })
      relay = createPluginToolRelay({
        link,
        // Only the plugins this host lists, on with tools on: never This PC's or another host's.
        servers: () => plugins.toolServers(),
        call: (request, signal) => plugins.callTool(request, signal),
        log: deps.log
      })
      const attached: Attached = { plugins, relay }
      hosts.set(id, attached)
      return { stop: () => end(id, attached) }
    },

    forHost: (id) => hosts.get(id)?.plugins ?? null,

    byLabel(label) {
      for (const [id, attached] of hosts) if (hostLabel(id) === label) return attached.plugins
      return null
    },

    reports: () => [...hosts.values()].flatMap((attached) => attached.plugins.reports()),

    backgroundGone(reason) {
      for (const attached of hosts.values()) attached.plugins.backgroundGone(reason)
    },

    shutdown() {
      for (const [id, attached] of [...hosts]) end(id, attached)
    }
  }
}
