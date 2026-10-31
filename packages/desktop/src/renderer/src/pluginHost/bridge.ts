import { isClientOnly, isHostInternal } from '../../../shared/host/protocol'
import type { HelmBridge } from '../../../shared/ipc'
import { createPageLink } from '../app/host/link'
import { createBackgroundAdapter } from '../app/host/plugins'
import { createRouter } from '../app/host/router'

/**
 * The hidden plugin host window's own bridge.
 *
 * With "Run sessions in the local host" on, this window reaches the host over
 * a connection of its own, which says it can draw plugin pages and nothing
 * else, and only its background adapter is built on it: no terminal, files or
 * sessions. Its background pages' calls and deliveries go over it; the theme
 * and the tool calls main hands a background page stay on the preload's
 * bridge. With the setting off it is the preload's bridge.
 *
 * A background page is an iframe on its plugin's origin with no preload, so
 * it reaches none of this, and this window holds no key: main pipes the
 * connection's frames to a bridge that does.
 */

const log = (line: string): void => console.warn(line)

const link = createPageLink({ bridge: window.helm, capabilities: ['pluginPages'], log })

export const background = createBackgroundAdapter({ link, own: window.helm, log })

export const helm: HelmBridge = createRouter({
  own: window.helm,
  inHost: () => link.inHost(),
  adapters: [background],
  clientOnly: isClientOnly,
  hostInternal: isHostInternal,
  log
})
