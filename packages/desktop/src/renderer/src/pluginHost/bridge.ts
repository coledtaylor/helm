import { LOCAL_HOST_KEY } from '@helm/core/types'
import { isClientOnly, isHostInternal } from '../../../shared/host/protocol'
import type { HelmBridge } from '../../../shared/ipc'
import { remoteOwn } from '../app/host/hostBridges'
import { createPageLink, type PageLink } from '../app/host/link'
import { createBackgroundAdapter, type BackgroundAdapter } from '../app/host/plugins'
import { createRouter } from '../app/host/router'

/**
 * The hidden plugin host window's own bridges: one per host whose background
 * pages it runs.
 *
 * This window reaches each host over a connection of its own, which says it
 * can draw plugin pages and nothing else, and only a background adapter is
 * built on it: no terminal, files or sessions. A host on another computer is
 * reached once main says it is connected (`backgrounds.ts`), over its own page
 * link. Each host's background pages' calls and deliveries go over that
 * host's connection only; the theme and the tool calls main hands a
 * background page stay on the preload's bridge.
 *
 * A background page is an iframe on its host's origin for its plugin, with no
 * preload, so it reaches none of this, and this window holds no key: main
 * pipes each connection's frames to a bridge that does.
 */

/** One host's connection, background adapter and router in the hidden window. */
export interface BackgroundBridge {
  /** `LOCAL_HOST_KEY`, or a remote host's id. */
  readonly host: string
  readonly link: PageLink
  readonly background: BackgroundAdapter
  /** The router this host's background pages' calls go through. */
  readonly helm: HelmBridge
}

const log = (line: string): void => console.warn(line)

/** One host's bridge, over `own` (the preload's bridge). */
export function createBackgroundBridge(own: HelmBridge, host: string): BackgroundBridge {
  const local = host === LOCAL_HOST_KEY
  const link = local
    ? createPageLink({ bridge: own, capabilities: ['pluginPages'], log })
    : // Told when to connect: main's own link to that host says when it is reachable.
      createPageLink({ bridge: own, capabilities: ['pluginPages'], host, retries: false, log })
  // A remote host's adapter hears none of main's word about This PC's host,
  // and hands nothing of it to the window.
  const adapterOwn = local ? own : remoteOwn(own, () => host)
  const background = createBackgroundAdapter({ link, own: adapterOwn, host, log })
  const helm = createRouter({
    own,
    adapters: [background],
    clientOnly: isClientOnly,
    hostInternal: isHostInternal,
    log
  })
  return { host, link, background, helm }
}

const local = createBackgroundBridge(window.helm, LOCAL_HOST_KEY)

/** This PC's background adapter. */
export const background = local.background

/** This PC's router: also the bridge to main for what only main hears (reports, tool answers). */
export const helm: HelmBridge = local.helm

const remote = new Map<string, BackgroundBridge>()

/** The bridge to `host`: This PC's for `LOCAL_HOST_KEY`, otherwise that host's, made on first ask. */
export function backgroundBridge(host: string): BackgroundBridge {
  if (host === LOCAL_HOST_KEY) return local
  let bridge = remote.get(host)
  if (bridge === undefined) {
    bridge = createBackgroundBridge(window.helm, host)
    remote.set(host, bridge)
  }
  return bridge
}
