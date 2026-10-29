import { createTerminal, type TerminalHost } from './terminal'
import { LatencyRecorder } from './latency'
import { makeProbeHandler } from './probe'
import type { HelmBridge } from '../../shared/ipc'
import type { ProbeOp } from '../../shared/protocol'

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

/**
 * C10's second terminal: configured as the first is, kept off screen, and
 * given nothing but what the main process writes to it.
 */
let mirror: TerminalHost | null = null
const mirrorProbe = makeProbeHandler(() => mirror, latency)
const ignored = (): void => undefined

function answer(req: ProbeOp): unknown {
  switch (req.op) {
    case 'mirrorOpen': {
      mirror?.dispose()
      document.getElementById('mirror')?.remove()
      const element = document.createElement('div')
      element.id = 'mirror'
      element.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:800px'
      document.body.append(element)
      mirror = createTerminal(
        element,
        {
          cols: req.cols,
          rows: req.rows,
          fit: false,
          ...(req.windowsBuild === undefined ? {} : { windowsBuild: req.windowsBuild })
        },
        {
          onInput: ignored,
          onResize: ignored,
          readClipboard: () => Promise.resolve(''),
          writeClipboard: () => Promise.resolve(),
          openLink: ignored
        }
      )
      return { ok: true }
    }
    case 'mirrorWrite': {
      const target = mirror
      if (target === null) return { error: 'no mirror' }
      return new Promise((resolve) => target.term.write(req.data, () => resolve({ ok: true })))
    }
    case 'mirrorScreen':
      return mirrorProbe({ op: 'screen' })
    case 'mirrorClose':
      mirror?.dispose()
      mirror = null
      document.getElementById('mirror')?.remove()
      return { ok: true }
    default:
      return probe(req)
  }
}

helm.on('probe:req', ({ id, req }) => {
  void (async () => {
    let value: unknown
    try {
      value = await answer(req)
    } catch (err) {
      value = { error: String(err) }
    }
    helm.send('probe:res', { id, value })
  })()
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
    openLink: (url) => void helm.invoke('shell:openExternal', { url }),
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
