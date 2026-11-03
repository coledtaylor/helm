import { backgroundBridge, helm } from './bridge'
import { startBackgroundFrames } from './backgrounds'
import { createPluginRelay } from '../plugins/relay'

/**
 * The background host: every enabled plugin's background page on every host
 * this window reaches, each an iframe on its host's own origin for its
 * plugin, in a window nobody sees (`backgrounds.ts`). This PC's pages call
 * This PC's host; a remote host's pages call that host only, over its own
 * connection (`bridge.ts`).
 */

const found = document.getElementById('frames')
if (found === null) throw new Error('#frames is missing from plugin-host.html')

const relay = createPluginRelay({ win: window, ipc: helm, hostIpc: (host) => backgroundBridge(host).helm })

startBackgroundFrames({
  root: found,
  relay,
  own: window.helm,
  bridgeOf: backgroundBridge,
  log: (line) => console.warn(line)
})
