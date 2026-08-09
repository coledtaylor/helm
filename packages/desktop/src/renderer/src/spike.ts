import { createTerminal, type TerminalHost } from './terminal'
import { LatencyRecorder } from './latency'
import { makeProbeHandler } from './probe'
import type { HelmBridge } from '../../shared/ipc'

/**
 * Entry point for Spike B and C's harness page.
 *
 * A bare terminal with no app chrome, driven entirely over IPC by the
 * `--selftest` / `--fidelity` / `--claude-check` modes. It is the regression
 * test for the terminal configuration those spikes proved load-bearing, so it
 * stays a separate page from the app: the checks measure a terminal, not a
 * terminal inside a layout that might have changed under it.
 *
 * It goes through the same typed bridge as the app - `window.helm` is the only
 * thing the preload exposes, in either page.
 */

declare global {
  interface Window {
    readonly helm: HelmBridge
  }
}

const helm = window.helm

let host: TerminalHost | null = null
const latency = new LatencyRecorder()
const probe = makeProbeHandler(() => host, latency)

helm.on('probe:req', ({ id, req }) => {
  let value: unknown
  try {
    value = probe(req)
  } catch (err) {
    value = { error: String(err) }
  }
  helm.send('probe:res', { id, value })
})

helm.on('term:create', (opts) => {
  host = createTerminal(document.getElementById('terminal')!, opts, {
    onInput: (data) => {
      latency.hostInput()
      helm.send('pty:input', data)
    },
    onResize: (cols, rows) => helm.send('pty:resize', { cols, rows }),
    readClipboard: () => helm.invoke('clipboard:read'),
    writeClipboard: (text) => helm.invoke('clipboard:write', text),
    onKeyDown: (at) => latency.keyDown(at)
  })
  helm.send('term:created', {
    rendererKind: host.rendererKind,
    cols: host.term.cols,
    rows: host.term.rows,
    unicodeVersion: host.term.unicode.activeVersion
  })
})

helm.on('term:write', (data) => {
  host?.term.write(data, () => {
    const n = latency.countPending(data)
    if (n > 0) requestAnimationFrame(() => latency.close(n))
  })
})

helm.on('term:resize', ({ cols, rows }) => {
  host?.term.resize(cols, rows)
  helm.send('term:resized')
})

helm.send('renderer:ready')
